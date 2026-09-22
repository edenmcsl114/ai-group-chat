/**
 * 记忆系统专项自测：
 * 1. 压缩失败不会推进 _state.json（避免永久漏压）
 * 2. 损坏的高层记忆文件会从低层数据重新生成
 * 3. 单日输入超过 maxInputChars 时会分段请求并合并
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3230;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

let mockServer = null;
let mockPort = 0;
let memoryContent = '';
let mockRequests = [];
let childApp = null;
let appLogs = '';
let tempConfigPath = null;
let tempDaysDir = null;
let tempMemoryDir = null;
let tempLegacyPath = null;

function request(method, apiPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      Object.assign({}, APP_BASE, { method, path: apiPath, headers }),
      (res) => {
        let chunks = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (chunks += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: chunks })
        );
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function login(username, password) {
  const res = await request('POST', '/api/login', { username, password });
  const cookie = ((res.headers && res.headers['set-cookie']) || []).length
    ? res.headers['set-cookie'][0].split(';')[0]
    : '';
  if (res.status !== 200 || !cookie) {
    throw new Error(`登录失败：HTTP ${res.status} ${res.body}`);
  }
  return cookie;
}

async function sendMessage(cookie, text) {
  const res = await request('POST', '/api/messages', { text }, cookie);
  if (res.status !== 200) {
    throw new Error(`发送消息失败：HTTP ${res.status} ${res.body}`);
  }
  return res;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shKey(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function addDaysKey(key, days) {
  const parts = String(key).split('-').map(Number);
  const ms = Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * 24 * 60 * 60 * 1000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dateKeyFromParts(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isoWeekdayMondayIndex(key) {
  const parts = String(key).split('-').map(Number);
  return (new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay() + 6) % 7;
}

function latestWeeklyKey(today) {
  return addDaysKey(addDaysKey(today, -isoWeekdayMondayIndex(today)), -7);
}

function latestMonthlyKey(today) {
  const [y, m] = today.split('-').map(Number);
  const prev = addDaysKey(dateKeyFromParts(y, m, 1), -1);
  const [py, pm] = prev.split('-').map(Number);
  return `${py}-${pad2(pm)}`;
}

function latestQuarterKey(today) {
  const [y, m] = today.split('-').map(Number);
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const prev = addDaysKey(dateKeyFromParts(y, startMonth, 1), -1);
  const [py, pm] = prev.split('-').map(Number);
  return `${py}-Q${Math.floor((pm - 1) / 3) + 1}`;
}

function timeAt(dateKey, hour, minute = 0) {
  const parts = dateKey.split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2], hour, minute, 0) - SHANGHAI_OFFSET_MS;
}

function makeMessage(id, role, name, text, time) {
  return { id, role, name, avatar: '🙂', text, time };
}

function validEntriesJson(entries) {
  return JSON.stringify({ entries });
}

function isMemoryRequest(item) {
  return String(item.system || '').includes('记忆压缩助手');
}

function startMockAI() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw);
        mockRequests.push({
          body,
          system: String((body.messages && body.messages[0] && body.messages[0].content) || ''),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: `mock-memory-${mockRequests.length}`,
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: memoryContent },
                finish_reason: 'stop',
              },
            ],
          })
        );
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      mockPort = server.address().port;
      mockServer = server;
      resolve(server);
    });
  });
}

function makeConfig(maxInputChars) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempDaysDir = path.join(ROOT, 'test', `.tmp-memory-repair-days-${stamp}`);
  tempMemoryDir = path.join(ROOT, 'test', `.tmp-memory-repair-${stamp}`);
  tempConfigPath = path.join(ROOT, 'test', `.tmp-memory-repair-config-${stamp}.js`);
  tempLegacyPath = path.join(ROOT, 'test', `.tmp-memory-repair-legacy-${stamp}.jsonl`);

  return {
    port: APP_PORT,
    host: '127.0.0.1',
    sessionDays: 7,
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    chat: {
      aiReplyMode: 'off',
      silentOnHumanOnlyMention: true,
      aiReplyOnAIMention: true,
      aiMentionMaxHops: 2,
      everyoneMaxHops: 1,
      everyoneKeywords: ['@所有人', '@all'],
      storageDir: path.relative(ROOT, tempDaysDir).replace(/\\/g, '/'),
      storageFile: path.relative(ROOT, tempLegacyPath).replace(/\\/g, '/'),
    },
    memory: {
      enabled: true,
      debug: false,
      apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'test-memory-key',
      model: 'mock-memory-model',
      temperature: 0.2,
      maxTokens: 8192,
      timeoutMs: 60000,
      thinking: { enabled: false, effort: 'medium', sendEffort: false },
      maxInputChars,
      budgets: { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
      storageDir: path.relative(ROOT, tempMemoryDir).replace(/\\/g, '/'),
    },
  };
}

function writeConfigFile(cfg) {
  fs.mkdirSync(tempDaysDir, { recursive: true });
  fs.mkdirSync(tempMemoryDir, { recursive: true });
  fs.writeFileSync(
    tempConfigPath,
    `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
  );
}

function writeState(state) {
  fs.mkdirSync(tempMemoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempMemoryDir, '_state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

function skipState(today, lastDailyDate) {
  return {
    lastDailyDate,
    lastWeeklyKey: latestWeeklyKey(today),
    lastMonthlyKey: latestMonthlyKey(today),
    lastQuarterKey: latestQuarterKey(today),
    lastYearKey: String(Number(today.slice(0, 4)) - 1),
  };
}

function writeDayMessages(dateKey, messages) {
  fs.mkdirSync(tempDaysDir, { recursive: true });
  fs.appendFileSync(
    path.join(tempDaysDir, `${dateKey}.jsonl`),
    messages.map((m) => `${JSON.stringify(m)}\n`).join(''),
    'utf8'
  );
}

function writeDailyMemory(dateKey, entries) {
  fs.mkdirSync(path.join(tempMemoryDir, 'daily'), { recursive: true });
  fs.writeFileSync(
    path.join(tempMemoryDir, 'daily', `${dateKey}.json`),
    JSON.stringify(
      {
        level: 'daily',
        key: dateKey,
        createdAt: Date.now(),
        range: { start: dateKey, end: dateKey },
        entries,
      },
      null,
      2
    ),
    'utf8'
  );
}

function dailyMemoryPath(dateKey) {
  return path.join(tempMemoryDir, 'daily', `${dateKey}.json`);
}

function weeklyMemoryPath(key) {
  return path.join(tempMemoryDir, 'weekly', `${key}.json`);
}

function readState() {
  return JSON.parse(fs.readFileSync(path.join(tempMemoryDir, '_state.json'), 'utf8'));
}

function readMemoryEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(obj.entries) ? obj.entries : [];
  } catch (_err) {
    return [];
  }
}

function startApp() {
  appLogs = '';
  childApp = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONFIG_FILE: tempConfigPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childApp.stdout.on('data', (d) => (appLogs += d));
  childApp.stderr.on('data', (d) => (appLogs += d));
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await request('GET', '/login.html');
      if (res.status === 200) return;
    } catch (_err) {
      /* 还没就绪 */
    }
    await sleep(150);
  }
  throw new Error(`被测服务启动超时\n${appLogs}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

async function cleanupScenario() {
  try {
    if (childApp) childApp.kill();
  } catch (_err) {
    /* ignore */
  }
  childApp = null;

  try {
    if (mockServer) mockServer.close();
  } catch (_err) {
    /* ignore */
  }
  mockServer = null;

  try {
    if (tempConfigPath) fs.unlinkSync(tempConfigPath);
  } catch (_err) {
    /* ignore */
  }
  try {
    if (tempLegacyPath) fs.unlinkSync(tempLegacyPath);
  } catch (_err) {
    /* ignore */
  }
  try {
    if (tempDaysDir) fs.rmSync(tempDaysDir, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }
  try {
    if (tempMemoryDir) fs.rmSync(tempMemoryDir, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }

  tempConfigPath = null;
  tempLegacyPath = null;
  tempDaysDir = null;
  tempMemoryDir = null;
  mockRequests = [];
}

async function scenarioFailureDoesNotAdvance() {
  console.log('\n[1/3] 压缩失败不推进状态');
  await startMockAI();
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const dayBefore = addDaysKey(yesterday, -1);
  const cfg = makeConfig(60000);
  writeConfigFile(cfg);

  writeDayMessages(yesterday, [
    makeMessage(1, 'user', '小明', '昨天的消息内容', timeAt(yesterday, 10)),
  ]);
  writeState(skipState(today, dayBefore));
  memoryContent = 'not-json';

  startApp();
  await waitForApp();
  await waitFor(() => mockRequests.some(isMemoryRequest), 5000, '等待首次压缩尝试');
  await sleep(200);

  assert(readState().lastDailyDate === dayBefore, '失败后 lastDailyDate 不应推进');
  assert(!fs.existsSync(dailyMemoryPath(yesterday)), '失败后不应生成 daily 文件');
  ok('压缩失败时状态未推进');

  memoryContent = validEntriesJson([
    { category: '偏好', member: '小明', time: `${yesterday} 10:00`, content: '失败后重试成功' },
  ]);
  const cookie = await login('小明', '123456');
  await sendMessage(cookie, '触发重试');
  await waitFor(
    () => readMemoryEntries(dailyMemoryPath(yesterday)).length > 0,
    10000,
    '等待重试生成 daily 文件'
  );

  assert(readState().lastDailyDate === yesterday, '重试成功后 lastDailyDate 应推进');
  ok('下一次消息成功重试并推进状态');
  await cleanupScenario();
}

async function scenarioCorruptHigherLevelRegenerated() {
  console.log('\n[2/3] 损坏高层记忆从低层重新生成');
  await startMockAI();
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const prevMonday = latestWeeklyKey(today);
  const cfg = makeConfig(60000);
  writeConfigFile(cfg);

  for (let i = 0; i < 7; i++) {
    const day = addDaysKey(prevMonday, i);
    writeDailyMemory(day, [
      { category: '事实', member: '小明', time: `${day} 10:00`, content: `每日来源-${i}` },
    ]);
  }

  fs.mkdirSync(path.join(tempMemoryDir, 'weekly'), { recursive: true });
  fs.writeFileSync(weeklyMemoryPath(prevMonday), '{broken json', 'utf8');
  writeState(skipState(today, yesterday));
  memoryContent = validEntriesJson([
    { category: '事实', member: '小明', time: `${prevMonday} 10:00`, content: '从低层重新生成' },
  ]);

  startApp();
  await waitForApp();
  await waitFor(
    () =>
      readMemoryEntries(weeklyMemoryPath(prevMonday)).some((e) =>
        String(e.content).includes('从低层重新生成')
      ),
    10000,
    '等待损坏 weekly 重新生成'
  );

  const sourceRequest = mockRequests.find((item) => {
    if (!isMemoryRequest(item)) return false;
    const allText = (item.body.messages || []).map((m) => String(m.content)).join('\n');
    return allText.includes('每日来源-0');
  });
  assert(sourceRequest, 'weekly 重新生成时应使用低层 daily 数据');
  ok('损坏 weekly 已用低层 daily 数据重新生成');
  await cleanupScenario();
}

async function scenarioChunksLargeInput() {
  console.log('\n[3/3] 输入超限时自动分段');
  await startMockAI();
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const dayBefore = addDaysKey(yesterday, -1);
  const cfg = makeConfig(80);
  writeConfigFile(cfg);

  const messages = [];
  for (let i = 0; i < 8; i++) {
    messages.push(
      makeMessage(
        i + 1,
        'user',
        '小明',
        `这是用于分段测试的第${i}条消息，内容比较长一些以确保超过输入上限。`,
        timeAt(yesterday, 10, i)
      )
    );
  }
  writeDayMessages(yesterday, messages);
  writeState(skipState(today, dayBefore));
  memoryContent = validEntriesJson([
    { category: '事实', member: '小明', time: `${yesterday} 10:00`, content: '分段测试记忆' },
  ]);

  startApp();
  await waitForApp();
  await waitFor(
    () => readMemoryEntries(dailyMemoryPath(yesterday)).length > 0,
    10000,
    '等待 daily 分段压缩完成'
  );

  const memoryCalls = mockRequests.filter(isMemoryRequest);
  assert(memoryCalls.length > 1, `输入应被分段请求（实际 ${memoryCalls.length} 次）`);
  assert(
    readMemoryEntries(dailyMemoryPath(yesterday)).some((e) =>
      String(e.content).includes('分段测试记忆')
    ),
    '分段后应合并生成 daily 记忆'
  );
  ok(`输入已分段请求 ${memoryCalls.length} 次并合并`);
  await cleanupScenario();
}

async function main() {
  console.log('记忆系统专项自测开始');
  await scenarioFailureDoesNotAdvance();
  await scenarioCorruptHigherLevelRegenerated();
  await scenarioChunksLargeInput();
  console.log('\n🎉 记忆系统专项自测全部通过');
}

main()
  .catch(async (err) => {
    console.error('\n❌ 记忆系统专项自测失败：', err && err.stack ? err.stack : err);
    console.error(appLogs.split('\n').slice(-12).join('\n'));
    await cleanupScenario();
    process.exitCode = 1;
  })
  .finally(() => {
    /* cleanupScenario 已在成功路径各场景内调用 */
  });
