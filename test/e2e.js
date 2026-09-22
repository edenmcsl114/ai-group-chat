/**
 * 端到端自测：需要先启动 `node server.js`
 * 覆盖：登录 / SSE 快照 / 在线列表 / 两个用户互发消息 / 历史记录
 */
'use strict';

const http = require('http');
const path = require('path');
const config = require(path.join(__dirname, '..', 'config.js'));

const BASE = { hostname: '127.0.0.1', port: 3000 };
const HOST = 'http://127.0.0.1:3000';

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
      Object.assign({}, BASE, { method, path: apiPath, headers }),
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

async function connectSSE(cookie) {
  const conn = {
    queue: [],
    waiters: new Map(),
    req: null,
    next(eventName, timeoutMs = 3000) {
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
  const res = await fetch(`http://127.0.0.1:${BASE.port}/api/events`, {
    headers: { Cookie: cookie, Accept: 'text/event-stream' },
    signal: conn.abort.signal,
    cache: 'no-store',
  });
  if (res.status !== 200 || !res.body) {
    throw new Error(`SSE 连接失败：HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  conn.reader = reader;
  const decoder = new TextDecoder();

  // 后台持续读取 SSE 流，解析成事件
  (async () => {
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
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
      /* 连接被 close() 主动关闭时忽略 */
    }
  })();

  return conn;
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

async function waitBothOnline(conn, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evt = await conn.next('presence', Math.max(200, deadline - Date.now()));
    const names = (evt.list || []).map((u) => u.username).sort();
    const expected = [config.users[0].username, config.users[1].username].sort();
    if (JSON.stringify(names) === JSON.stringify(expected)) return names;
  }
  throw new Error('等待两人同时在线超时');
}

async function main() {
  console.log('第 2 步端到端自测开始（服务地址 ' + HOST + '）\n');

  // 两个账号登录
  const accountA = config.users[0];
  const accountB = config.users[1];
  if (!accountA || !accountB) throw new Error('config.js 至少需要两个用户');
  const cookieA = await login(accountA.username, accountA.password);
  const cookieB = await login(accountB.username, accountB.password);
  ok(`${accountA.username}、${accountB.username}分别登录成功`);

  // 两人都打开 SSE
  const userA = await connectSSE(cookieA);
  const userB = await connectSSE(cookieB);
  const snapA = await userA.next('snapshot');
  const snapB = await userB.next('snapshot');
  assert(snapA.me.username === accountA.username, `${accountA.username}快照身份正确`);
  assert(snapB.me.username === accountB.username, `${accountB.username}快照身份正确`);
  assert(Array.isArray(snapA.history), '历史记录为数组');
  ok('两人 SSE 连接成功并收到初始快照');

  // 在线列表：第二位用户连上后，第一位用户应收到在线 2 人的 presence 事件
  const names = await waitBothOnline(userA);
  assert(
    JSON.stringify(names) === JSON.stringify([accountA.username, accountB.username].sort()),
    `${accountA.username}看到两人在线`
  );
  ok(`在线列表实时更新（${accountA.username}、${accountB.username}同时在群）`);

  // 第一位用户发消息 -> 双方都应实时收到
  const text1 = `大家好，我是${accountA.username} 👋`;
  const sendRes = await request('POST', '/api/messages', { text: text1 }, cookieA);
  assert(sendRes.status === 200, `发消息接口返回 200（实际 ${sendRes.status}）`);
  const msgA = await userA.next('message');
  const msgB = await userB.next('message');
  assert(msgA.message.text === text1 && msgA.message.name === accountA.username, `${accountA.username}端收到自己的消息`);
  assert(msgB.message.text === text1 && msgB.message.name === accountA.username, `${accountB.username}端实时收到${accountA.username}的消息`);
  assert(typeof msgB.message.time === 'number' && msgB.message.id > 0, '消息带时间戳与自增 id');
  ok(`${accountA.username}发消息，双方 1 秒内实时收到`);

  // 第二位用户回复
  const text2 = `收到，我是${accountB.username} 😊`;
  const sendRes2 = await request('POST', '/api/messages', { text: text2 }, cookieB);
  assert(sendRes2.status === 200, `${accountB.username}发消息成功`);
  await userA.next('message');
  await userB.next('message');
  ok(`${accountB.username}回复，双方实时收到`);

  // 空消息应被拒绝
  const emptyRes = await request('POST', '/api/messages', { text: '   ' }, cookieA);
  assert(emptyRes.status === 400, '空消息被服务端拒绝');
  ok('空消息被正确拦截');

  // 未登录发消息应被拒绝
  const noAuthRes = await request('POST', '/api/messages', { text: 'x' });
  assert(noAuthRes.status === 401, '未登录发消息返回 401');
  ok('未登录用户不能发消息');

  // 新连接应能看到历史记录
  const reconnA = await connectSSE(cookieA);
  const snapAgain = await reconnA.next('snapshot');
  const texts = snapAgain.history.map((m) => m.text);
  assert(texts.includes(text1) && texts.includes(text2), '历史记录包含刚才两条消息');
  ok('刷新页面后仍能看到历史消息');

  userA.close();
  userB.close();
  reconnA.close();

  console.log('\n🎉 第 2 步端到端自测全部通过');
}

main().catch((err) => {
  console.error('\n❌ 自测失败：', err.message);
  process.exitCode = 1;
});
