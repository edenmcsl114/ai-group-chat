/**
 * 启动记忆审计自测：
 * 1. 缺失 daily 记忆文件时，启动后自动按原始消息生成
 * 2. 缺失 weekly 记忆文件时，启动后自动从低层 daily 生成
 * 3. backfillOnStartup=false 时，不自动回填缺失记忆
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3231;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

let mockServer = null;
let mockPort = 0;
let memoryContent = '';
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

function isoWeekdayMondayIndex(key) {
  const parts = String(key).split('-').map(Number);
  return (new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay() + 6) % 7;
}

function latestWeeklyKey(today) {
  return addDaysKey(addDaysKey(today, -isoWeekdayMondayIndex(today)), -7);
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
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: 'mock-memory',
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

function makeConfig(backfillOnStartup) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempDaysDir = path.join(ROOT, 'test', `.tmp-memory-audit-days-${stamp}`);
  tempMemoryDir = path.join(ROOT, 'test', `.tmp-memory-audit-${stamp}`);
  tempConfigPath = path.join(ROOT, 'test', `.tmp-memory-audit-config-${stamp}.js`);
  tempLegacyPath = path.join(ROOT, 'test', `.tmp-memory-audit-legacy-${stamp}.jsonl`);

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
      maxInputChars: 60000,
      backfillOnStartup,
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

function readMemoryEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return Array.isArray(obj.entries) ? obj.entries : [];
}

function readMemoryState() {
  const filePath = path.join(tempMemoryDir, '_state.json');
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
}

async function scenarioMissingDailyGenerated() {
  console.log('\n[1/3] 缺失 daily 记忆文件，启动时自动生成');
  await startMockAI();
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const cfg = makeConfig(true);
  writeConfigFile(cfg);
  writeDayMessages(yesterday, [
    makeMessage(1, 'user', '小明', '启动审计应补全这条 daily 记忆', timeAt(yesterday, 10)),
  ]);
  memoryContent = validEntriesJson([
    { category: '事实', member: '小明', time: `${yesterday} 10:00`, content: '启动审计生成 daily' },
  ]);

  startApp();
  await waitForApp();
  await waitFor(
    () => readMemoryEntries(dailyMemoryPath(yesterday)).length > 0,
    10000,
    '等待启动审计生成 daily 文件'
  );

  assert(
    readMemoryEntries(dailyMemoryPath(yesterday)).some((e) =>
      String(e.content).includes('启动审计生成 daily')
    ),
    'daily 文件应由启动审计生成'
  );
  ok('缺失 daily 已在启动时按原始消息生成');
  await cleanupScenario();
}

async function scenarioMissingWeeklyGenerated() {
  console.log('\n[2/3] 缺失 weekly 记忆文件，启动时从 daily 生成');
  await startMockAI();
  const today = shKey(Date.now());
  const prevMonday = latestWeeklyKey(today);
  const cfg = makeConfig(true);
  writeConfigFile(cfg);

  for (let i = 0; i < 7; i++) {
    const day = addDaysKey(prevMonday, i);
    fs.writeFileSync(path.join(tempDaysDir, `${day}.jsonl`), '', 'utf8');
    writeDailyMemory(day, [
      { category: '事实', member: '小明', time: `${day} 10:00`, content: `每日来源-${i}` },
    ]);
  }

  memoryContent = validEntriesJson([
    { category: '事实', member: '小明', time: `${prevMonday} 10:00`, content: '启动审计生成 weekly' },
  ]);

  startApp();
  await waitForApp();
  await waitFor(
    () =>
      readMemoryEntries(weeklyMemoryPath(prevMonday)).some((e) =>
        String(e.content).includes('启动审计生成 weekly')
      ),
    10000,
    '等待启动审计生成 weekly 文件'
  );

  ok('缺失 weekly 已在启动时从低层 daily 生成');
  await cleanupScenario();
}

async function scenarioBackfillDisabled() {
  console.log('\n[3/3] backfillOnStartup=false 时不自动回填');
  await startMockAI();
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const cfg = makeConfig(false);
  writeConfigFile(cfg);
  writeDayMessages(yesterday, [
    makeMessage(1, 'user', '小明', '关闭回填后不应自动生成 daily', timeAt(yesterday, 10)),
  ]);
  memoryContent = validEntriesJson([
    { category: '事实', member: '小明', time: `${yesterday} 10:00`, content: '不应生成' },
  ]);

  startApp();
  await waitForApp();
  await sleep(700);

  assert(!fs.existsSync(dailyMemoryPath(yesterday)), '关闭回填后不应生成 daily 文件');
  const state = readMemoryState();
  assert(state, '关闭回填后也应生成 _state.json 基线状态');
  assert(
    state && state.lastDailyDate === yesterday,
    '首次启动基线状态应记录 lastDailyDate 为昨天'
  );
  ok('backfillOnStartup=false 时不会自动回填');
  await cleanupScenario();
}

async function main() {
  console.log('启动记忆审计自测开始');
  await scenarioMissingDailyGenerated();
  await scenarioMissingWeeklyGenerated();
  await scenarioBackfillDisabled();
  console.log('\n🎉 启动记忆审计自测全部通过');
}

main()
  .catch(async (err) => {
    console.error('\n❌ 启动记忆审计自测失败：', err && err.stack ? err.stack : err);
    console.error(appLogs.split('\n').slice(-12).join('\n'));
    await cleanupScenario();
    process.exitCode = 1;
  })
  .finally(() => {
    /* cleanupScenario 已在成功路径各场景内调用 */
  });
