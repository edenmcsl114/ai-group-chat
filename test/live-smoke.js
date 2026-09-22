/**
 * 真实环境联调自检（可选）：
 * 需要先启动 `node server.js`，且 config.js 中已填写真实的 AI apiKey。
 * 会用 config.js 里的第一个账号发一条消息，验证 AI 真实流式回复。
 * 运行：node test/live-smoke.js
 */
'use strict';

const http = require('http');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.js'));

const PORT = config.port || 3000;
const HOST = `http://127.0.0.1:${PORT}`;

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
      { hostname: '127.0.0.1', port: PORT, method, path: apiPath, headers },
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

async function login(user) {
  const res = await request('POST', '/api/login', {
    username: user.username,
    password: user.password,
  });
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
    next(eventName, timeoutMs = 15000) {
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
  const res = await fetch(`${HOST}/api/events`, {
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
      /* close() 主动关闭时忽略 */
    }
  })();

  return conn;
}

async function main() {
  const user = config.users[0];
  if (!user) throw new Error('config.js 中没有配置任何账号');
  const agents = Array.isArray(config.ais) && config.ais.length ? config.ais : [config.ai];
  if (!agents.length) throw new Error('config.js 中没有任何 AI 成员');
  console.log(
    `真实联调：账号「${user.username}」，AI 成员 ${agents.map((a) => `${a.name}(${a.model})`).join('、')}\n`
  );

  const cookie = await login(user);
  const conn = await connectSSE(cookie);
  await conn.next('snapshot', 5000);

  const ask = '【联调自检】请只回复两个字：收到';
  const sendRes = await request('POST', '/api/messages', { text: ask }, cookie);
  if (sendRes.status !== 200) throw new Error(`发消息失败：HTTP ${sendRes.status} ${sendRes.body}`);

  const echo = await conn.next('message', 5000);
  if (!echo.message || echo.message.role !== 'user') {
    throw new Error('未收到自己的消息广播');
  }

  const final = await conn.next('message', 60000);
  if (!final.message || final.message.role !== 'ai') {
    throw new Error('AI 未返回完整回复');
  }
  console.log(`✅ AI「${final.message.name}」真实回复：${final.message.text}`);
  conn.close();
  console.log('\n🎉 真实联调通过：AI 已能正常访问并回复');
}

main().catch((err) => {
  console.error('\n❌ 真实联调失败：', err.message);
  process.exitCode = 1;
});
