/**
 * 上下文消息格式端到端自测：
 * 1. 默认 short：其他成员 → "[HH:MM] 名字：正文"；AI 自己的历史 → 只给正文；system 带“今天是 …”
 * 2. useNameField=force：messages 里附带 name 字段
 * 3. contextTimePrefix=full：回退旧包装 [日期][时间][名字]{正文}
 * 4. 模型仍输出旧包装时，服务端把它剥成纯正文入库
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3246;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const LEGACY_REPLY = '收到，我看看';
const SECOND_REPLY = '好的，明白';

let mockServer = null;
let childApp = null;
let logs = '';
let current = null;
const requests = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: chunks }));
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
  if (res.status !== 200 || !cookie) throw new Error(`登录失败：HTTP ${res.status} ${res.body}`);
  return cookie;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shKey(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
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
        requests.push(body);
        // 第一次故意返回旧包装（验证服务端会剥掉），第二次返回纯正文
        const content =
          requests.length === 1
            ? `[2026/09/07][12:00:00][小智]{${LEGACY_REPLY}}`
            : SECOND_REPLY;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            model: 'mock-model',
            choices: [
              { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
            ],
          })
        );
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function writeScenario(name, extraChat) {
  const stamp = `${process.pid}-${Date.now()}`;
  const base = path.join(ROOT, 'test', `.tmp-ctxfmt-${name}-${stamp}`);
  const daysDir = path.join(base, 'days');
  const configPath = path.join(base, 'config.js');
  fs.mkdirSync(daysDir, { recursive: true });

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
        persona: '你是小智。',
        historyCount: 100,
        streamReply: false,
        apiBaseUrl: `http://127.0.0.1:${mockServer.address().port}/v1`,
        apiKey: 'test-key',
        model: 'mock-model',
        maxTokens: 200,
        id: 'xiaozhi',
      },
    ],
    chat: Object.assign(
      {
        aiReplyMode: 'hybrid',
        everyoneKeywords: ['@所有人', '@all'],
        storageDir: path.relative(ROOT, daysDir).replace(/\\/g, '/'),
        storageFile: path.relative(ROOT, path.join(base, 'messages.jsonl')).replace(/\\/g, '/'),
      },
      extraChat || {}
    ),
    memory: { enabled: false, storageDir: path.relative(ROOT, path.join(base, 'memory')).replace(/\\/g, '/') },
  };
  fs.writeFileSync(configPath, `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`);
  current = { base, configPath, today: shKey(Date.now()) };
  return current;
}

function startApp(configPath) {
  logs = '';
  childApp = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CONFIG_FILE: configPath }),
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
    await wait(120);
  }
  throw new Error(`等待超时：${label}\n${logs}`);
}

async function stopScenario() {
  if (childApp) {
    childApp.kill();
    childApp = null;
  }
  if (current) {
    try {
      fs.rmSync(current.base, { recursive: true, force: true });
    } catch (_err) {
      /* ignore */
    }
  }
  current = null;
  await wait(250);
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(text) {
  console.log(`  ✅ ${text}`);
}

async function sendTwoMessages() {
  const cookie = await login('小明', '123456');
  await request('POST', '/api/messages', { text: '第一条' }, cookie);
  await waitFor(() => requests.length >= 1, 15000, '等待第一次 AI 请求');
  await wait(800);
  await request('POST', '/api/messages', { text: '第二条' }, cookie);
  await waitFor(() => requests.length >= 2, 15000, '等待第二次 AI 请求');
  return cookie;
}

async function scenarioShort() {
  console.log('\n[1/3] 默认 short 格式');
  requests.length = 0;
  const paths = writeScenario('short', {});
  startApp(paths.configPath);
  await waitForApp();
  const cookie = await sendTwoMessages();

  const body = requests[requests.length - 1];
  const system = String(body.messages[0].content);
  assert(system.includes(`今天是 ${current.today}`), 'system 里给出“今天是 …”');

  const users = body.messages.filter((m) => m.role === 'user');
  assert(
    /^\[\d{2}:\d{2}\] 小明：第一条$/.test(String(users[0].content)),
    `其他成员消息格式为 [HH:MM] 名字：正文（实际：${users[0].content}）`
  );
  assert(
    /^\[\d{2}:\d{2}\] 小明：第二条$/.test(String(users[users.length - 1].content)),
    `最新一条同样带时间与名字（实际：${users[users.length - 1].content}）`
  );

  const assistants = body.messages.filter((m) => m.role === 'assistant');
  assert(assistants.length >= 1, '上下文包含 AI 自己的历史');
  assert(
    assistants.every((m) => String(m.content).trim() === LEGACY_REPLY),
    `AI 自己的历史只给正文（实际：${assistants.map((m) => m.content).join(' | ')}）`
  );
  assert(
    !body.messages.some((m) => m.name !== undefined),
    '默认不附带 name 字段'
  );
  ok('short：其他成员带 [HH:MM] 名字：，自己的历史只给正文，system 给出今天日期');

  const history = JSON.parse(
    (await request('GET', '/api/history?date=' + current.today, null, cookie)).body
  );
  const aiMsg = history.messages.find((m) => m.role === 'ai');
  assert(aiMsg && aiMsg.text === LEGACY_REPLY, '模型返回旧包装时会被剥成纯正文入库');
  assert(!!aiMsg.time && aiMsg.name === '小智', '时间与名字仍由 time / name 字段保留');
  ok('AI 输出纯正文入库，时间与名字仍在字段里');

  await stopScenario();
}

async function scenarioNameField() {
  console.log('\n[2/3] useNameField=force');
  requests.length = 0;
  const paths = writeScenario('name', { useNameField: 'force' });
  startApp(paths.configPath);
  await waitForApp();
  await sendTwoMessages();

  const body = requests[requests.length - 1];
  const named = body.messages.filter((m) => m.name !== undefined);
  assert(
    named.some((m) => m.name === '小明'),
    `force 时 messages 带 name 字段（实际：${JSON.stringify(named.map((m) => m.name))}）`
  );
  const userWithName = named.find((m) => m.name === '小明');
  assert(
    /^\[\d{2}:\d{2}\] 小明：/.test(String(userWithName.content)),
    'name 字段与正文里的名字同时存在（模型读不到 name 也能知道发言人）'
  );
  ok('useNameField=force：附带 ASCII 名与中文名的 name 字段');

  await stopScenario();
}

async function scenarioFull() {
  console.log('\n[3/3] contextTimePrefix=full（回滚）');
  requests.length = 0;
  const paths = writeScenario('full', { contextTimePrefix: 'full' });
  startApp(paths.configPath);
  await waitForApp();
  await sendTwoMessages();

  const body = requests[requests.length - 1];
  const users = body.messages.filter((m) => m.role === 'user');
  assert(
    /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[小明\]\{第一条\}$/.test(
      String(users[0].content)
    ),
    `full 时回到旧包装（实际：${users[0].content}）`
  );
  const assistants = body.messages.filter((m) => m.role === 'assistant');
  assert(
    assistants.some((m) => /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[小智\]\{/.test(String(m.content))),
    'full 时 AI 自己的历史也带旧包装'
  );
  ok('contextTimePrefix=full：完整回到旧格式');

  await stopScenario();
}

async function main() {
  console.log('上下文消息格式自测开始');
  mockServer = await startMockAI();
  try {
    await scenarioShort();
    await scenarioNameField();
    await scenarioFull();
    console.log('\n🎉 上下文消息格式自测全部通过');
  } catch (err) {
    console.error('\n❌ 上下文消息格式自测失败：', err && err.message ? err.message : err);
    await stopScenario();
    process.exit(1);
  } finally {
    if (mockServer) mockServer.close();
  }
  process.exit(0);
}

main();
