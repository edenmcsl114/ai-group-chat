'use strict';

/**
 * 长期记忆覆盖专项自测：
 * 预置“去年年度记忆”和“今年所有已完成季度记忆”，发送一条今天的消息，
 * 断言群成员 AI 的系统提示词完整包含这些记忆。
 * 旧逻辑只取每层最新一份，会漏掉今年较早的已完成季度（例如 2026-Q1）。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3237;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

let mockServer = null;
let childApp = null;
let appLogs = '';
let tempConfigPath = null;
let tempDaysDir = null;
let tempMemoryDir = null;
let tempLegacyPath = null;
const chatRequests = [];

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
        res.on('data', (chunk) => (chunks += chunk));
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

function parseKey(key) {
  const parts = String(key).split('-').map(Number);
  return { y: parts[0], m: parts[1], d: parts[2] };
}

function addDaysKey(key, days) {
  const { y, m, d } = parseKey(key);
  const ms = Date.UTC(y, m - 1, d) + days * 24 * 60 * 60 * 1000;
  const date = new Date(ms);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function isoWeekdayMondayIndex(key) {
  const { y, m, d } = parseKey(key);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function latestWeekKey(today) {
  return addDaysKey(addDaysKey(today, -isoWeekdayMondayIndex(today)), -7);
}

function latestMonthKey(today) {
  const { y, m } = parseKey(today);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${pad2(m - 1)}`;
}

function latestQuarterKey(today) {
  const { y, m } = parseKey(today);
  const currentQuarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
  const lastDayOfPreviousQuarter = addDaysKey(
    `${y}-${pad2(currentQuarterStartMonth)}-01`,
    -1
  );
  const p = parseKey(lastDayOfPreviousQuarter);
  return `${p.y}-Q${Math.floor((p.m - 1) / 3) + 1}`;
}

function completedQuarterKeysInCurrentYear(today) {
  const { y } = parseKey(today);
  const latest = latestQuarterKey(today);
  const [latestYear, latestQuarter] = latest.split('-Q');
  if (Number(latestYear) !== y) return [];
  const keys = [];
  for (let q = 1; q <= Number(latestQuarter); q += 1) {
    keys.push(`${y}-Q${q}`);
  }
  return keys;
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
        const system = String(
          (body.messages && body.messages[0] && body.messages[0].content) || ''
        );
        chatRequests.push({ body, auth: req.headers.authorization || '' });

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (system.includes('记忆压缩助手')) {
          res.end(
            JSON.stringify({
              id: 'mock-memory',
              object: 'chat.completion',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: JSON.stringify({ entries: [] }) },
                  finish_reason: 'stop',
                },
              ],
            })
          );
          return;
        }

        res.end(
          JSON.stringify({
            id: 'mock-chat',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '收到' },
                finish_reason: 'stop',
              },
            ],
          })
        );
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      mockServer = server;
      resolve(server);
    });
  });
}

function writeTempConfig(mockPort) {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tempDaysDir = path.join(ROOT, 'test', `.tmp-memory-summary-days-${stamp}`);
  tempMemoryDir = path.join(ROOT, 'test', `.tmp-memory-summary-${stamp}`);
  tempLegacyPath = path.join(ROOT, 'test', `.tmp-memory-summary-legacy-${stamp}.jsonl`);
  tempConfigPath = path.join(ROOT, 'test', `.tmp-memory-summary-config-${stamp}.js`);

  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    sessionDays: 7,
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ais: [
      {
        enabled: true,
        name: '小智',
        avatar: '🤖',
        persona: '你是「小智」，回答要简洁。',
        historyCount: 20,
        streamReply: false,
        thinking: { enabled: false, effort: 'medium', sendEffort: false },
        apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'test-secret-key',
        model: 'mock-chat-model',
        temperature: 0.7,
        maxTokens: 300,
        timeoutMs: 60000,
        id: 'xiaozhi',
      },
    ],
    chat: {
      aiReplyMode: 'hybrid',
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
      apiKey: 'test-secret-key',
      model: 'mock-memory-model',
      temperature: 0.2,
      maxTokens: 8192,
      timeoutMs: 60000,
      thinking: { enabled: false, effort: 'medium', sendEffort: false },
      maxInputChars: 60000,
      backfillOnStartup: false,
      budgets: { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
      storageDir: path.relative(ROOT, tempMemoryDir).replace(/\\/g, '/'),
    },
  };

  fs.mkdirSync(tempDaysDir, { recursive: true });
  fs.mkdirSync(tempMemoryDir, { recursive: true });
  fs.writeFileSync(
    tempConfigPath,
    `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
  );
}

function writeMemoryFile(level, key, entries) {
  const dir = path.join(tempMemoryDir, level);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${key}.json`),
    JSON.stringify(
      {
        level,
        key,
        createdAt: Date.now(),
        entries,
      },
      null,
      2
    ),
    'utf8'
  );
}

function writeMemoryState(state) {
  fs.writeFileSync(
    path.join(tempMemoryDir, '_state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );
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
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await request('GET', '/login.html');
      if (res.status === 200) return;
    } catch (_err) {
      // 还没就绪
    }
    await sleep(150);
  }
  throw new Error(`被测服务启动超时\n${appLogs}`);
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

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

function cleanup() {
  try {
    if (childApp) childApp.kill();
  } catch (_err) {
    /* ignore */
  }
  try {
    if (mockServer) mockServer.close();
  } catch (_err) {
    /* ignore */
  }
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
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

async function main() {
  console.log('长期记忆覆盖专项自测开始\n');

  mockServer = await startMockAI();
  const mockPort = mockServer.address().port;
  writeTempConfig(mockPort);

  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const latestWeek = latestWeekKey(today);
  const latestMonth = latestMonthKey(today);
  const latestQuarter = latestQuarterKey(today);
  const latestYear = String(parseKey(today).y - 1);
  const quarterKeys = completedQuarterKeysInCurrentYear(today);

  writeMemoryFile('year', latestYear, [
    {
      category: '事实',
      member: '小明',
      time: `${latestYear}-01-01 00:00`,
      content: '去年年度记忆',
    },
  ]);

  for (const key of quarterKeys) {
    writeMemoryFile('quarter', key, [
      {
        category: '事实',
        member: '小明',
        time: `${key} 00:00`,
        content: `季度记忆-${key}`,
      },
    ]);
  }

  writeMemoryFile('monthly', latestMonth, [
    {
      category: '事实',
      member: '小明',
      time: `${latestMonth}-01 00:00`,
      content: '最近完成月度占位',
    },
  ]);

  writeMemoryFile('weekly', latestWeek, [
    {
      category: '事实',
      member: '小明',
      time: `${latestWeek} 00:00`,
      content: '最近完成周度占位',
    },
  ]);

  writeMemoryState({
    lastDailyDate: yesterday,
    lastWeeklyKey: latestWeek,
    lastMonthlyKey: latestMonth,
    lastQuarterKey: latestQuarter,
    lastYearKey: latestYear,
  });

  startApp();
  await waitForApp();
  ok('测试服务启动成功，记忆文件已预置');

  const cookie = await login('小明', '123456');
  const sendRes = await request(
    'POST',
    '/api/messages',
    { text: '测试长期记忆覆盖' },
    cookie
  );
  assert(sendRes.status === 200, `发送消息成功（HTTP ${sendRes.status}）`);

  const groupReq = await waitFor(
    () =>
      chatRequests.find(
        (r) =>
          !String(
            (r.body.messages && r.body.messages[0] && r.body.messages[0].content) || ''
          ).includes('记忆压缩助手')
      ),
    15000,
    '等待群成员 AI 请求'
  );

  const system = String(groupReq.body.messages[0].content);
  assert(system.includes('群聊长期记忆'), 'AI 系统提示应包含长期记忆标题');
  assert(system.includes('去年年度记忆'), '长期记忆应包含去年年度记忆');

  for (const key of quarterKeys) {
    assert(
      system.includes(`季度记忆-${key}`),
      `长期记忆应包含较早的已完成季度 ${key}`
    );
  }

  ok(`年度与 ${quarterKeys.length} 个已完成季度记忆均进入 AI 上下文`);
  console.log('\n🎉 长期记忆覆盖专项自测全部通过');
}

process.on('exit', cleanup);

main()
  .catch((err) => {
    console.error('\n❌ 长期记忆覆盖专项自测失败：', err && err.stack ? err.stack : err);
    console.error(appLogs.split('\n').slice(-12).join('\n'));
    process.exitCode = 1;
  })
  .finally(cleanup);
