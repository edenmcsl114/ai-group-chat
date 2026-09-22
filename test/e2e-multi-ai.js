/**
 * 第 2 步 多 AI 调度端到端自测：
 * 两个 AI（小智/小悟）+ 模拟接口，验证：
 * - 普通消息只随机回一个 AI
 * - @小悟 只小悟回
 * - @两个 AI 两个都回
 * - 只 @ 人类：AI 保持沉默
 * - 目标 AI 只把自己过去的话当 assistant，别人（含其他 AI）当 user
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3213;
const AI_IDS = ['xiaozhi', 'xiaowu'];

let mockServer = null;
let childApp = null;
let tempConfigPath = null;
let tempStorePath = null;
let tempStoreDir = null;
let requests = [];
let appLogs = '';
let slowReplyGate = null;
let releaseSlowReply = null;
let holdSystemPart = '';
let holdTextPart = '';
let releaseHold = null;

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
  if (res.status !== 200 || !cookie) throw new Error(`登录失败：HTTP ${res.status}`);
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
  if (res.status !== 200 || !res.body) throw new Error(`SSE 连接失败：HTTP ${res.status}`);
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
      /* close() 忽略 */
    }
  })();
  return conn;
}

function startMockAI() {
  return new Promise((resolve, reject) => {
    slowReplyGate = new Promise((resolveGate) => {
      releaseSlowReply = resolveGate;
    });
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end();
        return;
      }
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push(body);
        const systemText = String((body.messages && body.messages[0] && body.messages[0].content) || '');
        const lastText = String(
          (body.messages && body.messages[body.messages.length - 1] &&
            body.messages[body.messages.length - 1].content) || ''
        );
        let replyContent = '好的，收到！';
        const isSlowFirst =
          lastText.includes('积压测试第一条') && systemText.includes('小智');
        if (isSlowFirst) {
          replyContent = '积压第一条完成';
        } else if (lastText.includes('开始AI互测') && systemText.includes('小智')) {
          replyContent = '收到！@小悟 轮到你了';
        } else if (
          lastText.includes('@所有人') &&
          lastText.includes('全体风暴')
        ) {
          replyContent = '收到！@所有人 全体风暴继续';
        } else if (lastText.includes('风暴甲')) {
          replyContent = '收到甲！@所有人 风暴甲续';
        } else if (lastText.includes('风暴乙')) {
          replyContent = '收到乙！@所有人 风暴乙续';
        }
        const shouldHold = Boolean(
          holdSystemPart &&
            holdTextPart &&
            systemText.includes(holdSystemPart) &&
            lastText.includes(holdTextPart)
        );
        (async () => {
          if (isSlowFirst) await slowReplyGate;
          if (shouldHold) {
            holdSystemPart = '';
            holdTextPart = '';
            await new Promise((resolveHold) => {
              releaseHold = resolveHold;
            });
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              id: `mock-${requests.length}`,
              object: 'chat.completion',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: replyContent },
                  finish_reason: 'stop',
                },
              ],
            })
          );
        })().catch((err) => {
          console.error('[mock AI] 处理失败：', err);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function writeTempConfig(mockPort) {
  const stamp = `${process.pid}-${Date.now()}`;
  const cfg = {
    port: APP_PORT,
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ais: AI_IDS.map((id, i) => ({
      id,
      name: id === 'xiaozhi' ? '小智' : '小悟',
      avatar: id === 'xiaozhi' ? '🤖' : '🦉',
      persona: `你是${id === 'xiaozhi' ? '小智' : '小悟'}。`,
      apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: `test-key-${i}`,
      model: `model-${i}`,
      temperature: 0.7,
      maxTokens: 128,
      contextHours: 24,
      historyCount: 50,
      prefixAiReplies: true,
      streamReply: false,
      timeoutMs: 10000,
      thinking: { enabled: false, effort: 'medium', sendEffort: false },
    })),
    chat: {
      aiReplyMode: 'hybrid',
      silentOnHumanOnlyMention: true,
      aiReplyOnAIMention: true,
      aiMentionMaxHops: 2,
      everyoneMaxHops: 1,
      everyoneKeywords: ['@所有人', '@all'],
      displayHours: 24,
      storageDir: `test/.tmp-multi-${stamp}.d`,
      storageFile: `test/.tmp-multi-${stamp}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-multi-config-${stamp}.js`);
  tempStorePath = path.join(ROOT, cfg.chat.storageFile);
  tempStoreDir = path.join(ROOT, cfg.chat.storageDir);
  fs.writeFileSync(
    tempConfigPath,
    `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
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
  for (let i = 0; i < 60; i++) {
    try {
      const res = await request('POST', '/api/login', { username: '小明', password: '123456' });
      if (res.status === 200) return;
    } catch (_err) {
      /* 等待 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`被测服务启动超时\n${appLogs}`);
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

async function sendAndEcho(cookie, conn, text) {
  const res = await request('POST', '/api/messages', { text }, cookie);
  assert(res.status === 200, `发消息成功（HTTP ${res.status}）`);
  const echo = await conn.next('message', 5000);
  assert(echo.message.role === 'user' && echo.message.text === text, '收到自己的消息');
}

async function waitAnyAI(conn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evt = await conn.next('message', Math.max(200, deadline - Date.now()));
    if (evt.message && evt.message.role === 'ai') return evt.message;
  }
}

async function waitSpecificAI(conn, aiId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evt = await conn.next('message', Math.max(200, deadline - Date.now()));
    if (evt.message && evt.message.role === 'ai' && evt.message.aiId === aiId) return evt.message;
  }
}

async function waitForRequests(minCount, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (requests.length < minCount) {
    if (Date.now() > deadline) {
      throw new Error(`等待模拟接口收到第 ${minCount} 个请求超时`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return requests[requests.length - 1];
}

function countRequestsMatching(systemPart, textPart) {
  return requests.filter((body) => {
    const systemText = String((body.messages && body.messages[0] && body.messages[0].content) || '');
    const allText = (body.messages || []).map((m) => String(m.content)).join('\n');
    return systemText.includes(systemPart) && allText.includes(textPart);
  }).length;
}

async function waitForRequestMatchingCount(systemPart, textPart, count, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (countRequestsMatching(systemPart, textPart) < count) {
    if (Date.now() > deadline) {
      throw new Error(
        `等待 ${systemPart} 含“${textPart}”的请求达到 ${count} 次超时（当前 ${
          countRequestsMatching(systemPart, textPart)
        }）`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function drainUntilAISilence(conn, quietMs = 600, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error('等待 AI 广播清空超时');
    const evt = await conn
      .next('message', quietMs)
      .then((e) => e.message && e.message.role === 'ai')
      .catch(() => false);
    if (!evt) return;
  }
}

async function main() {
  console.log('第 2 步 多 AI 调度端到端自测开始\n');
  mockServer = await startMockAI();
  writeTempConfig(mockServer.address().port);
  startApp();
  await waitForApp();
  ok('双 AI（小智/小悟）测试服务启动');

  const cookie = await login('小明', '123456');
  const roomRes = await request('GET', '/api/room', null, cookie);
  const room = JSON.parse(roomRes.body).room;
  assert(room.ais.length === 2, '房间返回 2 个 AI');
  ok('room.ais 包含小智、小悟');
  assert(
    Array.isArray(room.everyoneKeywords) &&
      room.everyoneKeywords.includes('@所有人') &&
      room.everyoneKeywords.includes('@all'),
    'room 返回 @所有人 关键词列表'
  );
  ok('room.everyoneKeywords 包含 @所有人 / @all（前端 @ 列表由此生成）');

  const conn = await connectSSE(cookie);
  await conn.next('snapshot', 5000);

  // 1. 普通消息：只随机回一个 AI
  await sendAndEcho(cookie, conn, '大家好，这是一条普通消息');
  const first = await waitAnyAI(conn);
  assert(AI_IDS.includes(first.aiId), '随机回复的 AI id 合法');
  const noSecond = await conn
    .next('message', 1200)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!noSecond, '普通消息不会两个 AI 都回复');
  ok(`普通消息随机由「${first.name}」回复（只回一个）`);

  // 2. @小悟：只有小悟回
  await sendAndEcho(cookie, conn, '@小悟 请回答');
  const wu = await waitSpecificAI(conn, 'xiaowu');
  assert(String(wu.text).includes('好的'), '小悟已回复');
  ok('@小悟 → 只有小悟回复');

  // 3. @两个 AI：两个都回
  await sendAndEcho(cookie, conn, '@小智 和 @小悟 都请回复');
  const seen = new Set();
  while (seen.size < 2) {
    const msg = await waitAnyAI(conn, 8000);
    seen.add(msg.aiId);
  }
  assert(seen.has('xiaozhi') && seen.has('xiaowu'), '两个 AI 都被 @ 到并回复');
  ok('@小智 + @小悟 → 两个都回复');

  // 4. 只 @ 人类：AI 沉默
  await sendAndEcho(cookie, conn, '@小明 我们俩聊一下');
  const unexpected = await conn
    .next('message', 1500)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!unexpected, '只 @ 人类时 AI 不回复');
  ok('只 @ 人类 → AI 保持沉默');

  // 5. 上下文角色隔离：让 @小悟 再看一次，检查发给它的历史里
  //    小悟自己的历史是 assistant，小智的历史被当作 user
  await sendAndEcho(cookie, conn, '@小悟 检查一下群聊历史');
  await waitSpecificAI(conn, 'xiaowu');
  const lastBody = requests[requests.length - 1];
  const assistants = lastBody.messages.filter((m) => m.role === 'assistant');
  const aiAsUsers = lastBody.messages.filter(
    (m) => m.role === 'user' && String(m.content).includes('[小智]')
  );
  assert(assistants.length >= 1, '小悟的上下文包含 assistant 历史');
  assert(
    assistants.every((m) => String(m.content).includes('[小悟]') && !String(m.content).includes('[小智]')),
    'assistant 历史里只有小悟自己说的话'
  );
  assert(aiAsUsers.length >= 1, '小智的发言被当作带名字的 user 消息');
  ok('上下文角色隔离正确：自己的话当 assistant，其他 AI 当 user');

  // 6. AI @ AI：小智回复里 @ 小悟，小悟应被触发回复（且不无限循环）
  await sendAndEcho(cookie, conn, '@小智 开始AI互测');
  const zhi = await waitSpecificAI(conn, 'xiaozhi');
  assert(String(zhi.text).includes('@小悟'), '小智在回复里 @ 小悟');
  const wuReply = await waitSpecificAI(conn, 'xiaowu');
  assert(String(wuReply.text).includes('好的，收到！'), '小悟被小智 @ 后主动回复');
  const extraAI = await conn
    .next('message', 1200)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extraAI, '小悟未再 @ 回去，不会造成无限循环');
  ok('AI @ AI 触发成功且不会无限互 @');

  // 7. @所有人：所有 AI 都回复，且每个只回一次
  await sendAndEcho(cookie, conn, '@所有人 全体集合测试');
  const allSeen = new Set();
  while (allSeen.size < AI_IDS.length) {
    const msg = await waitAnyAI(conn, 8000);
    allSeen.add(msg.aiId);
  }
  assert(allSeen.has('xiaozhi') && allSeen.has('xiaowu'), '@所有人 触发全部 AI');
  const extraAll = await conn
    .next('message', 1200)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extraAll, '@所有人 后每个 AI 只回复一次');
  ok('@所有人 → 小智、小悟都回复且不重复');

  // 8. @所有人 与显式 @ 并存时去重（小悟只回一次）
  await sendAndEcho(cookie, conn, '@所有人 @小悟 再次测试');
  const againSeen = new Set();
  while (againSeen.size < AI_IDS.length) {
    const msg = await waitAnyAI(conn, 8000);
    againSeen.add(msg.aiId);
  }
  const extraAgain = await conn
    .next('message', 1200)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extraAgain, '@所有人 与 @小悟 并存时不会重复触发小悟');
  ok('@所有人 @小悟 并存 → 仍各回复一次（已去重）');

  // 补充：@所有人 需要词边界——后紧跟中文字符不算触发（本条含 @小明，AI 应保持沉默）
  await sendAndEcho(cookie, conn, '@所有人都别说话 @小明 我们单独聊');
  const noEveryoneBoundary = await conn
    .next('message', 1500)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!noEveryoneBoundary, '@所有人 后紧跟中文字符时不应触发全部 AI');
  ok('@所有人都别说话 → 不触发 @所有人（词边界生效）');

  // 9. AI 回复里互相 @所有人：走独立轮数上限（everyoneMaxHops），
  //    不会像普通 AI @ AI 那样继续传 2 轮造成刷屏
  await sendAndEcho(cookie, conn, '@所有人 全体风暴测试');
  const stormCounts = new Map();
  let totalStorm = 0;
  while (totalStorm < 4) {
    const msg = await waitAnyAI(conn, 8000);
    totalStorm += 1;
    stormCounts.set(msg.aiId, (stormCounts.get(msg.aiId) || 0) + 1);
  }
  assert(
    stormCounts.get('xiaozhi') === 2 && stormCounts.get('xiaowu') === 2,
    '每个 AI 只回复 2 轮（@所有人 独立上限生效）'
  );
  const extraStorm = await conn
    .next('message', 1500)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extraStorm, 'AI 互相 @所有人 在第 1 轮后停止，不再继续触发');
  ok('AI 回复里互 @所有人 → everyoneMaxHops=1 生效，只多触发一轮');

  // 9b. 两拨独立的 @所有人 风暴互不抑制：
  //     把第一拨“小悟”的续轮请求挂起后发起第二拨，
  //     第二拨小悟的续轮仍应正常执行，而不是被全局去重吞掉。
  holdSystemPart = '小悟';
  holdTextPart = '风暴甲续';
  await sendAndEcho(cookie, conn, '@所有人 风暴甲开始');
  await waitForRequestMatchingCount('小悟', '风暴甲续', 1, 8000);
  // 挂起续轮后，先消费第一拨已完成的 AI 广播，避免污染第二拨的 echo
  await drainUntilAISilence(conn);
  await sendAndEcho(cookie, conn, '@所有人 风暴乙开始');
  releaseHold();
  holdSystemPart = '';
  holdTextPart = '';
  // 小悟应有两笔含“风暴乙”的请求：第一轮直接回复 + 第二拨的续轮回复
  await waitForRequestMatchingCount('小悟', '风暴乙', 2, 12000);
  ok('两拨 @所有人 风暴重叠 → 各自续轮互不吞掉');
  // 收尾：把释放挂起后产生的 5 条 AI 回复消费掉，避免污染后续用例
  const stormDrain = [];
  while (stormDrain.length < 5) {
    stormDrain.push(await waitAnyAI(conn, 10000));
  }
  const extraAfterStorms = await conn
    .next('message', 1500)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extraAfterStorms, '两拨风暴结束后不再有多余 AI 回复');

  // 10. 上下文快照应在任务真正开跑时生成：
  //     先让第一条 @小智 请求被 mock 挂起占住队列，第二条入队后
  //     再出现一条只 @ 人类的新消息，最后确认第二条回复能看到它。
  const requestBase = requests.length;
  await sendAndEcho(cookie, conn, '@小智 积压测试第一条');
  await waitForRequests(requestBase + 1, 8000);
  await sendAndEcho(cookie, conn, '@小智 积压测试第二条');
  await sendAndEcho(cookie, conn, '@小明 排队期间才出现的新消息');
  releaseSlowReply();
  const secondReq = await waitForRequests(requestBase + 2, 8000);
  const secondContent = secondReq.messages.map((m) => String(m.content)).join('\n');
  assert(
    secondContent.includes('排队期间才出现的新消息'),
    '第二条 AI 回复的上下文包含排队期间才出现的新消息'
  );
  assert(secondContent.includes('积压测试第二条'), '第二条 AI 回复的上下文包含触发它的消息');
  ok('快照在任务开跑时生成：积压队列中的回复能看到排队期间的新消息');

  conn.close();
  console.log('\n🎉 第 2 步 多 AI 调度端到端自测全部通过');
}

process.on('exit', cleanup);

main()
  .catch((err) => {
    console.error('\n❌ 自测失败：', err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
