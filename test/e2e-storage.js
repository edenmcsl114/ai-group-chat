/**
 * 第 1 步 存储层端到端自测：
 * 预置旧版单文件 → 验证首次启动自动迁移为按日文件 →
 * 发消息 → 杀掉进程重启 → 验证消息仍在、id 继续递增
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3212;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };

let childApp = null;
let tempConfigPath = null;
let tempStorePath = null;
let tempStoreDir = null;
let currentDayFile = null;

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

function writeTempConfig() {
  const stamp = `${process.pid}-${Date.now()}`;
  const cfg = {
    port: APP_PORT,
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ai: { enabled: false, name: '小智', avatar: '🤖', persona: '', contextHours: 24 },
    chat: {
      aiReplyMode: 'always',
      displayHours: 24,
      storageDir: `test/.tmp-store-days-${stamp}.d`,
      storageFile: `test/.tmp-store-legacy-${stamp}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-config-${stamp}.js`);
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

async function stopApp() {
  return new Promise((resolve) => {
    if (!childApp) return resolve();
    childApp.once('exit', () => resolve());
    childApp.kill();
    setTimeout(resolve, 1200);
  });
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
      /* 等待服务就绪 */
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
  try {
    if (currentDayFile) fs.chmodSync(currentDayFile, 0o666);
  } catch (_err) {
    /* ignore */
  }
  if (tempStorePath) {
    const backupPrefix = `${path.basename(tempStorePath)}.migrated-`;
    try {
      for (const name of fs.readdirSync(path.join(ROOT, 'test'))) {
        if (name.startsWith(backupPrefix)) {
          fs.unlinkSync(path.join(ROOT, 'test', name));
        }
      }
    } catch (_err) {
      /* ignore */
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

async function sendAndConfirm(cookie, text, expectedId) {
  const conn = await connectSSE(cookie);
  const snap = await conn.next('snapshot');
  const res = await request('POST', '/api/messages', { text }, cookie);
  assert(res.status === 200, `发送成功（HTTP ${res.status}）`);
  const evt = await conn.next('message');
  assert(evt.message.text === text, '收到刚发的消息');
  assert(evt.message.id === expectedId, `消息 id 应为 ${expectedId}`);
  conn.close();
  return snap;
}

async function main() {
  console.log('第 1 步 存储层端到端自测开始\n');
  writeTempConfig();

  // 预置一条旧版单文件消息（10 分钟前，属于今天），验证自动迁移
  fs.appendFileSync(
    tempStorePath,
    `${JSON.stringify({
      id: 1,
      role: 'user',
      name: '小明',
      avatar: '🙂',
      text: '迁移前的旧格式消息',
      time: Date.now() - 10 * 60 * 1000,
    })}\n`,
    'utf8'
  );

  startApp();
  await waitForApp();
  ok('测试服务启动（旧版单文件已自动迁移为分日目录）');

  const cookie = await login('小明', '123456');
  const firstSnap = await sendAndConfirm(cookie, '第一条持久化消息', 2);
  assert(
    firstSnap.history.some((m) => m.text === '迁移前的旧格式消息'),
    '迁移前的消息进入实时快照'
  );
  await sendAndConfirm(cookie, '第二条持久化消息', 3);
  ok('两条消息发送成功');

  assert(fs.existsSync(tempStoreDir), '分日存储目录已创建');
  const dayFiles = fs.readdirSync(tempStoreDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(n));
  assert(dayFiles.length >= 1, `分日目录至少一个日期文件（实际 ${dayFiles.length}）`);
  const fileLines = fs
    .readFileSync(path.join(tempStoreDir, dayFiles[0]), 'utf8')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert(fileLines.length === 3, `当天分日文件应有 3 行（实际 ${fileLines.length}）`);
  currentDayFile = path.join(tempStoreDir, dayFiles[0]);
  ok('消息按日写入 JSONL 分日文件');

  // 杀掉服务，模拟重启
  await stopApp();
  startApp();
  await waitForApp();

  const cookie2 = await login('小明', '123456');
  const conn2 = await connectSSE(cookie2);
  const snap2 = await conn2.next('snapshot');
  const texts = snap2.history.map((m) => m.text);
  assert(texts.includes('第一条持久化消息'), '重启后第一条消息仍在');
  assert(texts.includes('第二条持久化消息'), '重启后第二条消息仍在');
  conn2.close();
  ok('服务重启后历史消息完整恢复');

  await sendAndConfirm(cookie2, '重启后的第三条', 4);
  ok('重启后消息 id 继续递增（从 4 开始）');

  // 历史接口：按天分组
  const daysRes = await request('GET', '/api/history/days', null, cookie2);
  assert(daysRes.status === 200, '日期列表接口可用');
  const daysData = JSON.parse(daysRes.body);
  assert(daysData.ok && daysData.days.length >= 1, '至少有一个有消息的日期');
  const today = daysData.days[0];
  assert(today.count >= 3, '当天消息数包含三条测试消息');
  ok(`历史日期列表正常（${today.date} · ${today.count} 条）`);

  const dayRes = await request('GET', `/api/history?date=${today.date}`, null, cookie2);
  assert(dayRes.status === 200, '单日历史接口可用');
  const dayData = JSON.parse(dayRes.body);
  const dayTexts = dayData.messages.map((m) => m.text);
  assert(dayTexts.includes('第一条持久化消息'), '单日历史包含第一条');
  assert(dayTexts.includes('重启后的第三条'), '单日历史包含第三条');
  assert(dayData.messages.every((m, i, arr) => i === 0 || arr[i - 1].time <= m.time), '单日历史按时间升序');
  ok('单日历史消息完整且按时间排序');

  // 写失败不再静默：把当天文件设为只读后发送应返回 503
  try {
    fs.chmodSync(currentDayFile, 0o444);
    const failRes = await request(
      'POST',
      '/api/messages',
      { text: '这条应因存储失败被拒绝' },
      cookie2
    );
    assert(failRes.status === 503, `存储失败时发送应返回 503（实际 HTTP ${failRes.status}）`);
    ok('存储写失败时发送者收到明确错误（503），不再静默');
  } finally {
    try {
      fs.chmodSync(currentDayFile, 0o666);
    } catch (_err) {
      /* ignore */
    }
  }

  const noAuthRes = await request('GET', '/api/history/days', null);
  assert(noAuthRes.status === 401, '未登录不能查看历史');
  ok('历史接口已做登录保护');

  console.log('\n🎉 第 1 步 存储层端到端自测全部通过');
}

process.on('exit', cleanup);

main()
  .catch((err) => {
    console.error('\n❌ 自测失败：', err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
