/**
 * 记忆升级（成员档案 / 待办状态 / 置顶记忆）端到端自测：
 * [1/3] profile：压缩返回的档案会归一化落盘（数组裁剪），注入时【成员档案】在最前，同一成员取 updatedAt 最新
 * [2/3] pending：关键词兜底把「未完成的约定」标成 pending + importance=3；已完成的不会被改写；可配置关闭
 * [3/3] pin：置顶接口 + 注入【置顶记忆】 + 压缩输入也带上置顶内容 + 取消置顶后消失
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3247;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const OFF = 8 * 60 * 60 * 1000;

let mockServer = null;
let childApp = null;
let logs = '';
let mode = 'profile';
let ctx = null;
const aiRequests = [];
const memoryRequests = [];

const pad2 = (n) => String(n).padStart(2, '0');
function shKey(ts) {
  const d = new Date(ts + OFF);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function addDaysKey(key, days) {
  const parts = key.split('-').map(Number);
  const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]) + days * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(method, apiPath, body, cookie, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (extraHeaders) Object.assign(headers, extraHeaders);
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

async function login() {
  const res = await request('POST', '/api/login', { username: '小明', password: '123456' });
  const cookie = (res.headers['set-cookie'] || [])[0];
  if (res.status !== 200 || !cookie) throw new Error(`登录失败：${res.status} ${res.body}`);
  return cookie.split(';')[0];
}

function memoryReply() {
  if (mode === 'pending') {
    return JSON.stringify({
      entries: [
        { category: '计划', member: 'eden', time: `${ctx.yesterday} 10:00`, content: 'eden答应下次请大家喝咖啡' },
        { category: '计划', member: 'eden', time: `${ctx.yesterday} 11:00`, status: 'done', content: '说好了要早点睡（已经做到了）' },
        { category: '事实', member: 'eden', time: `${ctx.yesterday} 12:00`, content: '今天天气不错' },
      ],
    });
  }
  if (mode === 'pin') {
    return JSON.stringify({
      entries: [
        { category: '事实', member: 'eden', time: `${ctx.yesterday} 10:00`, content: '普通的一条记忆' },
      ],
    });
  }
  // profile 场景用固定输出格式 JSONL（一行一个对象）
  return [
    JSON.stringify({
      type: 'entry',
      category: '事实',
      member: '小明',
      time: `${ctx.yesterday} 10:00`,
      topic: '咖啡',
      importance: 2,
      status: 'active',
      content: '小明常喝咖啡',
    }),
    JSON.stringify({
      type: 'profile',
      member: '小明',
      identity: '群里的老朋友',
      aliases: ['一', '二', '三', '四', '五', '六', '七', '八', '九'],
      preferences: ['咖啡', '甜食'],
      pending: ['答应下周带咖啡豆'],
    }),
  ].join('\n');
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
        const system = String((body.messages[0] && body.messages[0].content) || '');
        const userContent = String((body.messages[1] && body.messages[1].content) || '');
        let content = '收到';
        if (system.includes('记忆压缩助手')) {
          memoryRequests.push({ system, userContent });
          content = memoryReply();
        } else {
          aiRequests.push({ system, messages: body.messages });
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          })
        );
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function setup(name, extraMemory) {
  const stamp = `${process.pid}-${Date.now()}`;
  const base = path.join(ROOT, 'test', `.tmp-upgrade-${name}-${stamp}`);
  const daysDir = path.join(base, 'days');
  const memoryDir = path.join(base, 'memory');
  fs.mkdirSync(daysDir, { recursive: true });
  fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true });

  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const dayBefore = addDaysKey(today, -2);
  ctx = { base, daysDir, memoryDir, today, yesterday, dayBefore, configPath: path.join(base, 'config.js') };
  aiRequests.length = 0;
  memoryRequests.length = 0;

  const parts = yesterday.split('-').map(Number);
  const time = Date.UTC(parts[0], parts[1] - 1, parts[2], 2, 0, 0) - OFF;
  fs.writeFileSync(
    path.join(daysDir, `${yesterday}.jsonl`),
    `${JSON.stringify({ id: 1, role: 'user', name: 'eden', avatar: '🙂', text: '今天喝了三杯咖啡', time })}\n`,
    'utf8'
  );

  // 一份旧档案，用来验证注入时按 updatedAt 取最新
  fs.writeFileSync(
    path.join(memoryDir, 'daily', `${dayBefore}.json`),
    JSON.stringify(
      {
        version: 2,
        level: 'daily',
        key: dayBefore,
        createdAt: 1,
        range: { start: dayBefore, end: dayBefore },
        entries: [
          { category: '事实', member: '小明', time: `${dayBefore} 09:00`, topic: '', importance: 2, status: 'active', content: '旧的记录' },
        ],
        profiles: [
          { member: '小明', updatedAt: 1, identity: '旧身份', aliases: [], relations: [], preferences: ['旧偏好'], ongoing: [], pending: [], resolved: [], notes: '' },
        ],
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    path.join(memoryDir, '_state.json'),
    JSON.stringify({ lastDailyDate: dayBefore }, null, 2),
    'utf8'
  );

  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    sessionDays: 7,
    users: [{ username: '小明', password: '123456', avatar: '🙂', role: 'admin' }],
    ais: [
      {
        enabled: true,
        name: '小智',
        avatar: '🤖',
        persona: '你是小智。',
        historyCount: 50,
        streamReply: false,
        apiBaseUrl: `http://127.0.0.1:${mockServer.address().port}/v1`,
        apiKey: 'test-key',
        model: 'mock-chat-model',
        id: 'xiaozhi',
      },
    ],
    chat: {
      aiReplyMode: 'hybrid',
      everyoneKeywords: ['@所有人', '@all'],
      storageDir: path.relative(ROOT, daysDir).replace(/\\/g, '/'),
      storageFile: path.relative(ROOT, path.join(base, 'messages.jsonl')).replace(/\\/g, '/'),
    },
    memory: Object.assign(
      {
        enabled: true,
        apiBaseUrl: `http://127.0.0.1:${mockServer.address().port}/v1`,
        apiKey: 'test-key',
        model: 'mock-memory-model',
        budgets: { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
        storageDir: path.relative(ROOT, memoryDir).replace(/\\/g, '/'),
      },
      extraMemory || {}
    ),
  };
  fs.writeFileSync(
    ctx.configPath,
    `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
  );
  return ctx;
}

function startApp() {
  logs = '';
  childApp = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONFIG_FILE: ctx.configPath }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childApp.stdout.on('data', (d) => (logs += d));
  childApp.stderr.on('data', (d) => (logs += d));
}

async function waitForApp() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await request('POST', '/api/login', { username: '小明', password: '123456' });
      if (res.status === 200) return;
    } catch (_err) {
      /* 还没就绪 */
    }
    await wait(150);
  }
  throw new Error(`被测服务启动超时\n${logs}`);
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate()) return true;
    } catch (_err) {
      /* 继续等 */
    }
    await wait(150);
  }
  throw new Error(`等待超时：${label}\n${logs}`);
}

async function stopScenario() {
  if (childApp) {
    childApp.kill();
    childApp = null;
  }
  await wait(250);
  try {
    fs.rmSync(ctx.base, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }
}

function dailyPath() {
  return path.join(ctx.memoryDir, 'daily', `${ctx.yesterday}.json`);
}
function readDaily() {
  return JSON.parse(fs.readFileSync(dailyPath(), 'utf8'));
}
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}
function ok(text) {
  console.log(`  ✅ ${text}`);
}

async function scenarioProfile() {
  console.log('\n[1/3] 成员档案 profile');
  mode = 'profile';
  setup('profile');
  startApp();
  await waitForApp();
  await waitFor(() => fs.existsSync(dailyPath()), 20000, '等待日压缩写入档案');
  const file = readDaily();

  assert(file.version === 2, '记忆文件应带 version=2');
  assert(Array.isArray(file.profiles) && file.profiles.length === 1, '应写入 1 份成员档案');
  assert(file.profiles[0].identity === '群里的老朋友', '档案 identity 应落盘');
  assert(
    file.profiles[0].aliases.length === 8,
    `aliases 应裁剪到 8 项（实际 ${file.profiles[0].aliases.length}）`
  );
  assert(file.profiles[0].preferences.includes('咖啡'), '偏好数组应保留');
  assert(
    file.entries[0].topic === '咖啡' && file.entries[0].importance === 2,
    '条目的 topic / importance 应落盘'
  );
  ok('profiles 归一化落盘（数组裁剪 8 项，字段保留）');

  const cookie = await login();
  await request('POST', '/api/messages', { text: '早上好' }, cookie);
  await waitFor(() => aiRequests.length >= 1, 20000, '等待 AI 回复请求');
  const system = String(aiRequests[aiRequests.length - 1].system);
  assert(system.includes('【成员档案】'), 'system 应包含【成员档案】');
  assert(system.includes('群里的老朋友'), '应使用 updatedAt 最新的档案');
  assert(!system.includes('旧身份'), '旧档案不应出现');
  assert(
    system.includes('【群聊长期记忆】') &&
      system.indexOf('【成员档案】') < system.indexOf('【群聊长期记忆】'),
    '成员档案应排在长期记忆之前'
  );
  ok('注入时【成员档案】在最前，同一成员取最新一份');
  await stopScenario();
}

async function checkPending(extraMemory, expectation) {
  setup('pending', extraMemory);
  startApp();
  await waitForApp();
  await waitFor(() => fs.existsSync(dailyPath()), 20000, '等待日压缩落盘');
  const entries = readDaily().entries;
  const found = (keyword) => entries.find((e) => String(e.content).includes(keyword));
  const agreed = found('答应');
  const done = found('说好了');
  const plain = found('天气');
  assert(agreed.status === expectation.agreedStatus, `约定条目 status 应为 ${expectation.agreedStatus}（实际 ${agreed.status}）`);
  assert(
    agreed.importance === expectation.agreedImportance,
    `约定条目 importance 应为 ${expectation.agreedImportance}（实际 ${agreed.importance}）`
  );
  assert(done.status === 'done', '已完成的条目不应被改写成 pending');
  assert(plain.status === 'active' && plain.importance === 2, '普通条目应保持 active / importance=2');
  await stopScenario();
}

async function scenarioPending() {
  console.log('\n[2/3] pending 关键词兜底');
  mode = 'pending';
  await checkPending({}, { agreedStatus: 'pending', agreedImportance: 3 });
  ok('默认配置：命中「答应 / 说好了」→ pending + importance=3，已完成的保持不变');
  await checkPending({ pendingKeywords: [] }, { agreedStatus: 'active', agreedImportance: 2 });
  ok('pendingKeywords 配成空数组 → 关闭兜底');
}

async function scenarioPin() {
  console.log('\n[3/3] 置顶记忆 pin');
  mode = 'pin';
  setup('pin');
  startApp();
  await waitForApp();
  await waitFor(() => fs.existsSync(dailyPath()), 20000, '等待日压缩落盘');
  const cookie = await login();

  const pinRes = await request(
    'POST',
    '/api/memory/pin',
    { action: 'add', member: 'eden', topic: '重要约定', content: '这是必须记住的事' },
    cookie,
    { Origin: `http://127.0.0.1:${APP_PORT}` }
  );
  assert(pinRes.status === 200, `置顶接口应成功（实际 ${pinRes.status} ${pinRes.body}）`);
  const overview = JSON.parse((await request('GET', '/api/memory/overview', null, cookie)).body);
  assert(overview.pins.length === 1, '总览里应有 1 条置顶');
  ok('置顶接口写入 _pins.json，总览可读');

  await request('POST', '/api/messages', { text: '继续' }, cookie);
  await waitFor(() => aiRequests.length >= 1, 20000, '等待 AI 回复请求');
  const system = String(aiRequests[aiRequests.length - 1].system);
  assert(
    system.includes('【置顶记忆】') && system.includes('这是必须记住的事'),
    '注入 system 应包含置顶记忆'
  );
  ok('置顶内容会注入给 AI');

  // 重置状态触发一次新的日压缩，验证压缩输入里也带上置顶记忆
  fs.rmSync(dailyPath(), { force: true });
  fs.writeFileSync(
    path.join(ctx.memoryDir, '_state.json'),
    JSON.stringify({ lastDailyDate: ctx.dayBefore }, null, 2),
    'utf8'
  );
  memoryRequests.length = 0;
  await request('POST', '/api/messages', { text: '再来一次' }, cookie);
  await waitFor(() => memoryRequests.length >= 1, 20000, '等待重新压缩');
  assert(
    memoryRequests[0].userContent.includes('【置顶记忆】') &&
      memoryRequests[0].userContent.includes('这是必须记住的事'),
    '压缩输入也应带置顶记忆'
  );
  ok('压缩输入同样带上置顶记忆（保证不会被丢）');

  const unpin = await request(
    'POST',
    '/api/memory/pin',
    { action: 'remove', member: 'eden', topic: '重要约定', content: '这是必须记住的事' },
    cookie,
    { Origin: `http://127.0.0.1:${APP_PORT}` }
  );
  assert(unpin.status === 200, '取消置顶应成功');
  const after = JSON.parse((await request('GET', '/api/memory/overview', null, cookie)).body);
  assert(after.pins.length === 0, '取消后置顶列表应为空');
  ok('取消置顶生效');
  await stopScenario();
}

async function main() {
  console.log('记忆升级（档案 / 待办 / 置顶）自测开始');
  mockServer = await startMockAI();
  try {
    await scenarioProfile();
    await scenarioPending();
    await scenarioPin();
    console.log('\n🎉 记忆升级自测全部通过');
  } catch (err) {
    console.error('\n❌ 记忆升级自测失败：', err && err.message ? err.message : err);
    process.exit(1);
  } finally {
    if (mockServer) mockServer.close();
  }
  process.exit(0);
}

main();
