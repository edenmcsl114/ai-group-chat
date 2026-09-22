/**
 * AI 接入端到端自测：
 * 1. 本地启动一个模拟 OpenAI 流式接口
 * 2. 用临时 config 在另一个端口启动被测服务（CONFIG_FILE 指向临时配置）
 * 3. 小明发消息，断言 AI 以群成员身份流式回复、提示词格式、历史记录
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3211;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const AI_TOKENS = ['你好', '呀', ',', '小明', '！'];
const EXPECTED_AI_TEXT = AI_TOKENS.join('');
const OLD_TEXT = '这是一条 25 小时前的旧消息，不该出现在任何上下文里';
const REASONING_TEXT = '【内部思考过程】用户只是在测试，我应该热情简洁地回复，不要跑题。';

let capturedRequest = null;
let mockCallCount = 0;
let childApp = null;
let tempConfigPath = null;
let tempStorePath = null;
let tempStoreDir = null;
let mockServer = null;

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

async function connectSSE(cookie) {
  const conn = {
    queue: [],
    waiters: new Map(),
    reader: null,
    abort: null,
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
      /* close() 主动关闭时忽略 */
    }
  })();

  return conn;
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
        mockCallCount++;
        capturedRequest = {
          body: JSON.parse(raw),
          auth: req.headers.authorization || '',
        };
        const fullText = AI_TOKENS.join('');
        if (capturedRequest.body.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          // 第二次调用故意返回"缺结尾 }"的残缺格式，验证服务端能自动纠错
          const replyContent = mockCallCount === 2
            ? `[2026/09/07][12:00:00][小智]{${fullText}`
            : fullText;
          res.end(
            JSON.stringify({
              id: 'mock-completion-1',
              object: 'chat.completion',
              model: 'mock-model',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: replyContent,
                    reasoning_content: REASONING_TEXT,
                  },
                  finish_reason: 'stop',
                },
              ],
            })
          );
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
        });
        const open = {
          id: 'mock-stream-1',
          object: 'chat.completion.chunk',
          model: 'mock-model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(open)}\n\n`);
        let i = 0;
        const timer = setInterval(() => {
          if (i >= AI_TOKENS.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          const chunk = {
            id: 'mock-stream-1',
            object: 'chat.completion.chunk',
            model: 'mock-model',
            choices: [{ index: 0, delta: { content: AI_TOKENS[i] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          i++;
        }, 20);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function writeTempConfig(mockPort) {
  const cfg = {
    port: APP_PORT,
    users: [
      { username: '小明', password: '123456', avatar: '🙂' },
      { username: '小红', password: '123456', avatar: '😊' },
    ],
    ai: {
      enabled: true,
      name: '小智',
      avatar: '🤖',
      persona: '测试人设：你是「小智」，回答要热情简洁。',
      historyCount: 20,
      contextHours: 24,
      prefixAiReplies: true,
      thinking: {
        enabled: true,
        effort: 'high',
        sendEffort: true,
      },
      apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'test-secret-key',
      model: 'mock-model',
      temperature: 0.7,
      maxTokens: 128,
      timeoutMs: 10000,
    },
    chat: {
      aiReplyMode: 'always',
      displayHours: 24,
      storageDir: `test/.tmp-ai-store-${process.pid}-${Date.now()}.d`,
      storageFile: `test/.tmp-ai-store-${process.pid}-${Date.now()}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-ai-config-${process.pid}-${Date.now()}.js`);
  tempStorePath = path.join(ROOT, cfg.chat.storageFile);
  tempStoreDir = path.join(ROOT, cfg.chat.storageDir);
  fs.writeFileSync(tempConfigPath, `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`);
  // 预置一条 25 小时前的旧消息，用来验证 24 小时窗口过滤
  fs.appendFileSync(
    tempStorePath,
    `${JSON.stringify({
      id: 1,
      role: 'user',
      name: '旧用户',
      avatar: '😴',
      text: OLD_TEXT,
      time: Date.now() - 25 * 60 * 60 * 1000,
    })}\n`,
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
  for (let i = 0; i < 50; i++) {
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

function parseAIBody(text) {
  const m = String(text || '').match(
    /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[小智\]\{(.*)\}$/s
  );
  return m ? m[1] : null;
}

async function main() {
  console.log('第 3 步 AI 端到端自测开始\n');

  mockServer = await startMockAI();
  const mockPort = mockServer.address().port;
  writeTempConfig(mockPort);
  startApp();
  await waitForApp();
  ok('模拟 AI 接口 + 被测服务（含临时配置）启动成功');

  const cookieA = await login('小明', '123456');
  const roomRes = await request('GET', '/api/room', null, cookieA);
  const roomData = JSON.parse(roomRes.body);
  assert(roomData.ok && Array.isArray(roomData.room.ais), '/api/room 返回 AI 列表');
  assert(roomData.room.ais.length === 1 && roomData.room.ais[0].name === '小智', 'AI 列表包含小智');
  ok('AI 配置已归一为列表（room.ais）');

  const userA = await connectSSE(cookieA);
  const snap = await userA.next('snapshot');
  assert(snap.me.username === '小明', '小明身份正确');
  assert(
    !snap.history.some((m) => m.text === OLD_TEXT),
    '实时快照不包含 24 小时前的旧消息'
  );
  ok('实时快照只返回最近 24 小时的消息');

  // 小明发一条消息
  const text = '大家好';
  const sendRes = await request('POST', '/api/messages', { text }, cookieA);
  assert(sendRes.status === 200, `发消息成功（实际 HTTP ${sendRes.status}）`);

  // 先收到自己的消息广播
  const echo = await userA.next('message', 5000);
  assert(echo.message.role === 'user' && echo.message.text === text, '收到小明自己的消息');
  ok('小明发消息成功');

  // 一次性收到 AI 完整回复（非流式）
  const finalMsg = await userA.next('message', 15000);
  assert(finalMsg.message.role === 'ai', '最终消息为 AI 角色');
  assert(finalMsg.message.name === '小智' && finalMsg.message.avatar === '🤖', 'AI 使用配置的名字与头像');
  assert(parseAIBody(finalMsg.message.text) === EXPECTED_AI_TEXT, `AI 回复格式为 [日期][时间][小智]{正文}`);
  assert(finalMsg.message.streaming !== true, '最终消息不再标记流式');
  assert(!String(finalMsg.message.text || '').includes(REASONING_TEXT), '思考过程没有出现在 AI 回复里');
  assert(finalMsg.message.aiId === 'legacy-小智', 'AI 消息带 aiId 标识');
  ok(`AI「小智」一次性完整回复：${finalMsg.message.text}`);

  // 验证发给模拟接口的提示词格式
  assert(capturedRequest, '模拟接口收到请求');
  assert(capturedRequest.auth === 'Bearer test-secret-key', '携带配置的 API Key');
  assert(capturedRequest.body.model === 'mock-model', '使用配置的模型名');
  assert(capturedRequest.body.stream === false, 'AI 请求使用非流式模式');
  assert(capturedRequest.body.reasoning_effort === 'high', '启用思考时发送 reasoning_effort 强度参数');
  const msgs = capturedRequest.body.messages;
  assert(msgs[0].role === 'system' && msgs[0].content.includes('小智'), '第一条是 persona 系统提示');
  const last = msgs[msgs.length - 1];
  assert(last.role === 'user', '最后一条是用户消息');
  assert(
    /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[小明\]\{大家好\}$/.test(last.content),
    `用户消息带 [日期][时间][用户名] 前缀（实际：${last.content}）`
  );
  assert(
    !capturedRequest.body.messages.some((m) => String(m.content).includes(OLD_TEXT)),
    '发给 AI 的上下文不包含 25 小时前的旧消息'
  );
  ok('24 小时窗口正确：旧消息不会发给 AI');

  // 再发一条消息，触发第二次 AI 回复，验证 AI 自己的历史回复也带统一前缀
  const secondText = '再来一条';
  const sendRes2 = await request('POST', '/api/messages', { text: secondText }, cookieA);
  assert(sendRes2.status === 200, '第二次发消息成功');
  const echo2 = await userA.next('message', 5000);
  assert(echo2.message.text === secondText, '收到第二条用户消息');
  const final2 = await userA.next('message', 15000);
  assert(
    final2.message.role === 'ai' && parseAIBody(final2.message.text) === EXPECTED_AI_TEXT,
    '第二条 AI 回复完成'
  );

  const msgs2 = capturedRequest.body.messages;
  const assistant = msgs2.find((m) => m.role === 'assistant');
  assert(assistant, '第二次请求包含上一条 AI 回复作为 assistant 历史');
  assert(
    new RegExp(
      `^\\[\\d{4}/\\d{2}/\\d{2}\\]\\[\\d{2}:\\d{2}:\\d{2}\\]\\[小智\\]\\{${EXPECTED_AI_TEXT.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      )}\\}$`
    ).test(assistant.content),
    `AI 历史回复带 [日期][时间][小智]{内容} 前缀（实际：${assistant.content}）`
  );
  ok('AI 回复在上下文中也遵循统一前缀格式');

  // 重新连接应能看到 AI 回复在历史里
  const reconn = await connectSSE(cookieA);
  const snapAgain = await reconn.next('snapshot');
  const aiMsgs = snapAgain.history.filter((m) => m.role === 'ai');
  assert(
    aiMsgs.length >= 1 && parseAIBody(aiMsgs[aiMsgs.length - 1].text) === EXPECTED_AI_TEXT,
    '历史包含完整 AI 回复'
  );
  assert(aiMsgs[aiMsgs.length - 1].aiId === 'legacy-小智', '历史中的 AI 消息保留 aiId');
  assert(
    !snapAgain.history.some((m) => String(m.text || '').includes(REASONING_TEXT)),
    '思考过程没有写入聊天历史'
  );
  ok('思考模型兼容：effort 参数下发，思考内容不外显、不入库');
  assert(
    !snapAgain.history.some((m) => m.text === OLD_TEXT),
    '实时历史视图不包含 24 小时前的旧消息'
  );
  ok('刷新后 AI 回复仍在历史记录中');

  userA.close();
  reconn.close();
  console.log('\n🎉 第 3 步 AI 端到端自测全部通过');
}

process.on('exit', cleanup);

main()
  .catch((err) => {
    console.error('\n❌ 自测失败：', err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
