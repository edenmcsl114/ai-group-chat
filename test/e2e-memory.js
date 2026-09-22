/**
 * 分层长期记忆端到端自测：
 * 1. 本地启动一个模拟 OpenAI 接口，同时扮演群成员 AI 与记忆压缩模型
 * 2. 预置“昨天”的一条聊天消息，并把记忆状态拨回一天前
 * 3. 启动被测服务，断言昨天被压缩成 daily 记忆
 * 4. 发一条“今天”的消息，断言群成员 AI 的系统提示词包含长期记忆，
 *    而昨天的原始消息不进入今天的原始上下文
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3220;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

let mockServer = null;
let childApp = null;
let tempConfigPath = null;
let tempDaysDir = null;
let tempMemoryDir = null;
const requests = [];

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
    throw new Error(`登录失败 ${username}：HTTP ${res.status} ${res.body}`);
  }
  return cookie;
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
        requests.push({ body, auth: req.headers.authorization || '' });
        const system = String(body.messages[0] && body.messages[0].content || '');

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (system.includes('记忆压缩助手')) {
          const yesterday = addDaysKey(shKey(Date.now()), -1);
          res.end(
            JSON.stringify({
              id: 'mock-memory-1',
              object: 'chat.completion',
              model: 'mock-memory-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: JSON.stringify({
                      entries: [
                        {
                          category: '偏好',
                          member: '小明',
                          time: `${yesterday} 10:00`,
                          content: '小明喜欢喝咖啡',
                        },
                      ],
                    }),
                  },
                  finish_reason: 'stop',
                },
              ],
            })
          );
          return;
        }

        res.end(
          JSON.stringify({
            id: 'mock-chat-1',
            object: 'chat.completion',
            model: 'mock-chat-model',
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
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
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

function writeTempConfig(mockPort) {
  const stamp = `${process.pid}-${Date.now()}`;
  tempDaysDir = path.join(ROOT, 'test', `.tmp-memory-days-${stamp}`);
  tempMemoryDir = path.join(ROOT, 'test', `.tmp-memory-${stamp}`);
  tempConfigPath = path.join(ROOT, 'test', `.tmp-memory-config-${stamp}.js`);

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
        historyCount: 100,
        contextHours: 24,
        prefixAiReplies: true,
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
      displayHours: 24,
      storageDir: path.relative(ROOT, tempDaysDir).replace(/\\/g, '/'),
      storageFile: path.relative(ROOT, path.join(tempDaysDir, '..', 'messages.jsonl')).replace(/\\/g, '/'),
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
      budgets: { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
      storageDir: path.relative(ROOT, tempMemoryDir).replace(/\\/g, '/'),
    },
  };

  fs.writeFileSync(tempConfigPath, `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`);

  fs.mkdirSync(tempDaysDir, { recursive: true });
  const yesterday = addDaysKey(shKey(Date.now()), -1);
  const dayBeforeYesterday = addDaysKey(yesterday, -1);
  const yesterdayParts = yesterday.split('-').map(Number);
  const yesterdayTime =
    Date.UTC(yesterdayParts[0], yesterdayParts[1] - 1, yesterdayParts[2], 2, 0, 0) -
    SHANGHAI_OFFSET_MS;
  fs.writeFileSync(
    path.join(tempDaysDir, `${yesterday}.jsonl`),
    `${JSON.stringify({
      id: 1,
      role: 'user',
      name: '小明',
      avatar: '🙂',
      text: '我喜欢喝咖啡',
      time: yesterdayTime,
    })}\n`,
    'utf8'
  );

  fs.mkdirSync(tempMemoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(tempMemoryDir, '_state.json'),
    JSON.stringify({ lastDailyDate: dayBeforeYesterday }, null, 2),
    'utf8'
  );
}

function startApp() {
  childApp = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONFIG_FILE: tempConfigPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  childApp.stdout.on('data', (d) => (logs += d));
  childApp.stderr.on('data', (d) => (logs += d));
  return logs;
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await request('POST', '/api/login', {
        username: '小明',
        password: '123456',
      });
      if (res.status === 200) return;
    } catch (_err) {
      /* 还没就绪 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('被测服务启动超时');
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
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
  console.log('分层长期记忆端到端自测开始\n');

  mockServer = await startMockAI();
  const mockPort = mockServer.address().port;
  writeTempConfig(mockPort);
  startApp();
  await waitForApp();
  ok('记忆模型 mock + 被测服务启动成功');

  const yesterday = addDaysKey(shKey(Date.now()), -1);
  const dailyFile = path.join(tempMemoryDir, 'daily', `${yesterday}.json`);
  await waitFor(() => fs.existsSync(dailyFile), 15000, '等待昨日记忆压缩完成');
  const daily = JSON.parse(fs.readFileSync(dailyFile, 'utf8'));
  assert(
    Array.isArray(daily.entries) &&
      daily.entries.some((e) => String(e.content).includes('喜欢喝咖啡')),
    '昨日消息被压缩为分类记忆'
  );
  ok('昨天聊天被压缩成 daily 记忆');

  const cookie = await login('小明', '123456');
  const sendRes = await request('POST', '/api/messages', { text: '今天也要喝咖啡吗' }, cookie);
  assert(sendRes.status === 200, `发送今天消息成功（实际 HTTP ${sendRes.status}）`);

  const groupReq = await waitFor(
    () =>
      requests.find(
        (r) =>
          !String(r.body.messages[0] && r.body.messages[0].content || '').includes('记忆压缩助手')
      ),
    15000,
    '等待群成员 AI 请求'
  );
  const system = String(groupReq.body.messages[0].content);
  assert(system.includes('群聊长期记忆'), '群成员 AI 系统提示包含长期记忆');
  assert(system.includes('小明喜欢喝咖啡'), '长期记忆包含昨天的偏好');
  ok('长期记忆已拼接到群成员 AI 的系统提示词中');

  const userContext = groupReq.body.messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');
  assert(!userContext.includes('我喜欢喝咖啡'), '昨天的原始消息不进入今天的上下文');
  ok('今日窗口生效：昨天消息只通过记忆提供，不进原始上下文');

  console.log('\n🎉 分层长期记忆端到端自测全部通过');
}

main()
  .catch((err) => {
    console.error('\n❌ 自测失败：', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
