/**
 * 流式回复失败自测：
 * 配置 streamReply=true + 模拟 AI 接口固定返回 HTTP 500，
 * 验证服务端先广播 ai_chunk 占位气泡，再广播带 msgId 的 ai_error，
 * 前端据此可清理残留气泡（server 契约；DOM 移除逻辑在 chat.js 中由该 id 触发）。
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3215;

let childApp = null;
let mockServer = null;
let tempConfigPath = null;
let tempStorePath = null;
let tempStoreDir = null;

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
      { hostname: '127.0.0.1', port: APP_PORT, method, path: apiPath, headers },
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

async function connectSSE(cookie) {
  const conn = {
    queue: [],
    waiters: new Map(),
    reader: null,
    abort: null,
    next(eventName, timeoutMs = 5000) {
      return new Promise((nextResolve, nextReject) => {
        const idx = conn.queue.findIndex((item) => item.event === eventName);
        if (idx !== -1) {
          const item = conn.queue.splice(idx, 1)[0];
          nextResolve(item.data);
          return;
        }
        const timer = setTimeout(() => {
          const list = conn.waiters.get(eventName) || [];
          const pos = list.findIndex((w) => w.timer === timer);
          if (pos !== -1) list.splice(pos, 1);
          nextReject(new Error(`等待事件 ${eventName} 超时`));
        }, timeoutMs);
        if (!conn.waiters.has(eventName)) conn.waiters.set(eventName, []);
        conn.waiters.get(eventName).push({ resolve: nextResolve, timer });
      });
    },
    close() {
      try {
        if (conn.reader) conn.reader.cancel();
        if (conn.abort) conn.abort.abort();
      } catch (_err) {
        /* ignore */
      }
    },
  };

  const dispatch = (eventName, data) => {
    const parsed = JSON.parse(data);
    const list = conn.waiters.get(eventName);
    if (list && list.length) {
      const waiter = list.shift();
      clearTimeout(waiter.timer);
      waiter.resolve(parsed);
      return;
    }
    conn.queue.push({ event: eventName, data: parsed });
  };

  conn.abort = new AbortController();
  const res = await fetch(`http://127.0.0.1:${APP_PORT}/api/events`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: conn.abort.signal,
    cache: 'no-store',
  });
  if (res.status !== 200 || !res.body) {
    throw new Error(`SSE 连接失败：HTTP ${res.status}`);
  }
  conn.reader = res.body.getReader();
  const decoder = new TextDecoder();
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await conn.reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let eventName = 'message';
          const dataLines = [];
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
          }
          if (eventName && dataLines.length) dispatch(eventName, dataLines.join('\n'));
        }
      }
    } catch (_err) {
      /* close() 时忽略 */
    }
  })();
  return conn;
}

function startMockAI() {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        req.resume();
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: '模拟服务端故障' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    mockServer.listen(0, '127.0.0.1', () => resolve(mockServer));
  });
}

function writeTempConfig(mockPort) {
  const stamp = `${process.pid}-${Date.now()}`;
  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ais: [
      {
        enabled: true,
        id: 'xiaozhi',
        name: '小智',
        avatar: '🤖',
        persona: '测试人设',
        historyCount: 20,
        contextHours: 24,
        streamReply: true,
        apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'test-secret-key',
        model: 'mock-model',
        temperature: 0.7,
        maxTokens: 128,
        timeoutMs: 5000,
      },
    ],
    chat: {
      aiReplyMode: 'hybrid',
      displayHours: 24,
      storageDir: `test/.tmp-stream-error-store-${stamp}.d`,
      storageFile: `test/.tmp-stream-error-store-${stamp}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-stream-error-config-${stamp}.js`);
  tempStorePath = path.join(ROOT, cfg.chat.storageFile);
  tempStoreDir = path.join(ROOT, cfg.chat.storageDir);
  fs.writeFileSync(
    tempConfigPath,
    `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
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
  for (let i = 0; i < 50; i++) {
    try {
      const res = await request('GET', '/login.html');
      if (res.status === 200) return;
    } catch (_err) {
      /* 还没就绪 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('被测服务启动超时');
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
    if (tempStorePath) fs.unlinkSync(tempStorePath);
  } catch (_err) {
    /* ignore */
  }
  try {
    if (tempStoreDir) fs.rmSync(tempStoreDir, { recursive: true, force: true });
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
  console.log('流式回复失败自测开始\n');

  const mock = await startMockAI();
  const mockPort = mock.address().port;
  writeTempConfig(mockPort);
  startApp();
  await waitForApp();
  ok('模拟 AI（HTTP 500）+ 被测服务启动成功');

  const cookie = await login('小明', '123456');
  const sse = await connectSSE(cookie);
  await sse.next('snapshot');

  const sendRes = await request('POST', '/api/messages', { text: '触发一次失败的流式回复' }, cookie);
  assert(sendRes.status === 200, `发消息成功（实际 HTTP ${sendRes.status}）`);

  const echo = await sse.next('message', 5000);
  assert(echo.message.role === 'user' && echo.message.text === '触发一次失败的流式回复', '收到用户消息');
  ok('用户消息广播成功');

  const chunk = await sse.next('ai_chunk', 5000);
  assert(chunk.message && chunk.message.id > 0, 'AI 失败前先广播占位气泡');
  assert(chunk.message.streaming === true, '占位气泡带 streaming 标记');
  ok(`收到 ai_chunk 占位气泡（id=${chunk.message.id}）`);

  const errEvt = await sse.next('ai_error', 8000);
  assert(errEvt.text && String(errEvt.text).includes('小智'), 'ai_error 带 AI 名字的错误文本');
  assert(
    Number.isInteger(errEvt.msgId) && errEvt.msgId === chunk.message.id,
    `ai_error 携带与占位气泡一致的 msgId（实际 ${errEvt.msgId}）`
  );
  ok('ai_error 携带 msgId，前端可据此移除空气泡');

  sse.close();
  cleanup();
  console.log('\n🎉 流式回复失败自测全部通过');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
