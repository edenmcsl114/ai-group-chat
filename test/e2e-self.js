/**
 * AI 自我判断（self 模式）端到端自测：
 * 1. 普通消息由每个 AI 自己判断，判断为回复才正式生成
 * 2. 判断为不回复时：不落盘、不广播
 * 3. 判断接口失败 / 返回无法解析：回退随机一位 AI 回复
 * 4. @点名：被点名的直接回复；其他 AI 默认不参与判断
 * 5. @所有人、只 @ 人类：保持原有规则
 * 6. AI 消息触发其他 AI 自我判断，受 maxHops 限制
 * 7. 判断阶段与生成阶段的上下文条数分开配置
 * 8. 风暴预算与冷却限制生效，被 @ 的强制回复可以越过冷却
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AI_IDS = ['xiaozhi', 'xiaowu'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shanghaiTodayKey() {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(message) {
  console.log(`  ✅ ${message}`);
}

function requestOn(port, method, apiPath, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path: apiPath, headers },
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

async function connectSSE(port, cookie) {
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
  const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
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
      /* close() 时忽略 */
    }
  })();
  return conn;
}

function startMockAI(harness) {
  return new Promise((resolve, reject) => {
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
        let body;
        try {
          body = JSON.parse(raw);
        } catch (_err) {
          res.writeHead(400);
          res.end();
          return;
        }
        const systemText = String(
          (body.messages && body.messages[0] && body.messages[0].content) || ''
        );
        const isJudge = systemText.includes('只做一件事：判断你是否需要回复');
        const nameMatch = systemText.match(/群聊成员「([^」]+)」/);
        const agentName = nameMatch ? nameMatch[1] : '';
        harness.requests.push({
          kind: isJudge ? 'judge' : 'reply',
          body,
          agentName,
          auth: req.headers.authorization || '',
          receivedAt: Date.now(),
        });

        let content = '收到，我来回应。';
        let delayMs = 0;
        if (isJudge) {
          const spec = harness.judgePlan.shift() || { type: 'silent' };
          delayMs = Number(spec.delayMs) || 0;
          if (spec.type === 'error') {
            const sendError = () => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: { message: '模拟判断接口故障' } }));
            };
            if (delayMs > 0) setTimeout(sendError, delayMs);
            else sendError();
            return;
          }
          if (spec.type === 'garbage') {
            content = '这不是 JSON，也没有布尔值';
          } else if (spec.type === 'reply') {
            content = JSON.stringify({ reply: true, reason: spec.reason || '相关' });
          } else {
            content = JSON.stringify({ reply: false, reason: spec.reason || '不需要回复' });
          }
        }

        const sendOk = () => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              id: `mock-${harness.requests.length}`,
              object: 'chat.completion',
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content },
                  finish_reason: 'stop',
                },
              ],
            })
          );
        };
        if (delayMs > 0) setTimeout(sendOk, delayMs);
        else sendOk();
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function createHarness(options) {
  const harness = {
    label: options.label,
    port: options.port,
    storageTag: options.storageTag,
    selfDecision: options.selfDecision,
    chatJudgeExtra: options.chatJudgeExtra || null,
    agentSelfDecision: options.agentSelfDecision || null,
    aiReplyMode: options.aiReplyMode || 'self',
    legacyRouterConfig: options.legacyRouterConfig === true,
    mockServer: null,
    childApp: null,
    tempConfigPath: null,
    storeDir: null,
    storeFile: null,
    logs: '',
    requests: [],
    judgePlan: [],
    cookie: '',
    conn: null,
  };

  harness.judgeRequests = () => harness.requests.filter((r) => r.kind === 'judge');
  harness.replyRequests = () => harness.requests.filter((r) => r.kind === 'reply');

  harness.writeConfig = (mockPort) => {
    const stamp = `${process.pid}-${Date.now()}-${harness.storageTag}`;
    const cfg = {
      port: harness.port,
      users: [{ username: '小明', password: '123456', avatar: '🙂' }],
      ais: AI_IDS.map((id, i) => {
        const agent = {
          id,
          name: id === 'xiaozhi' ? '小智' : '小悟',
          avatar: id === 'xiaozhi' ? '🤖' : '🦉',
          persona: `你是${id === 'xiaozhi' ? '小智' : '小悟'}。`,
          apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
          apiKey: `test-key-${i}`,
          model: `model-${i}`,
          temperature: 0.7,
          maxTokens: 128,
          historyCount: 50,
          streamReply: false,
          timeoutMs: 10000,
          thinking: { enabled: false, effort: 'medium', sendEffort: false },
        };
        const override = harness.agentSelfDecision && harness.agentSelfDecision[id];
        if (override) agent.selfDecision = override;
        return agent;
      }),
      chat: {
        aiReplyMode: harness.aiReplyMode,
        silentOnHumanOnlyMention: true,
        aiReplyOnAIMention: true,
        everyoneKeywords: ['@所有人', '@all'],
        selfDecision: Object.assign(
          {
            enabled: true,
            judgeHistoryCount: 5,
            replyHistoryCount: 50,
            maxHops: 0,
            maxRepliesPerStorm: 6,
            maxRepliesPerAIPerStorm: 2,
            cooldownMs: 0,
            globalConcurrency: 3,
            forceReplyOnMention: true,
            othersJudgeOnMention: false,
            rateLimit: { perAiPerMinute: 0, totalPerMinute: 0 },
            debug: true,
          },
          harness.selfDecision || {},
          harness.chatJudgeExtra || {}
        ),
        storageDir: `test/.tmp-self-${stamp}.d`,
        storageFile: `test/.tmp-self-${stamp}.jsonl`,
      },
    };
    if (harness.legacyRouterConfig) {
      // 旧配置里的 router 段应该被忽略并告警，行为按 self 处理
      cfg.chat.router = {
        enabled: true,
        historyCount: 10,
        systemPrompt: '旧的调度 AI 配置',
        apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'router-key',
        model: 'router-model',
        temperature: 0,
        maxTokens: 64,
        timeoutMs: 5000,
      };
    }
    harness.tempConfigPath = path.join(ROOT, 'test', `.tmp-self-config-${stamp}.js`);
    harness.storeFile = path.join(ROOT, cfg.chat.storageFile);
    harness.storeDir = path.join(ROOT, cfg.chat.storageDir);
    fs.writeFileSync(
      harness.tempConfigPath,
      `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`
    );
  };

  harness.start = async () => {
    harness.mockServer = await startMockAI(harness);
    harness.writeConfig(harness.mockServer.address().port);
    harness.logs = '';
    harness.childApp = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CONFIG_FILE: harness.tempConfigPath }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    harness.childApp.stdout.on('data', (d) => (harness.logs += d));
    harness.childApp.stderr.on('data', (d) => (harness.logs += d));
    for (let i = 0; i < 80; i++) {
      try {
        const res = await requestOn(harness.port, 'POST', '/api/login', {
          username: '小明',
          password: '123456',
        });
        if (res.status === 200) return;
      } catch (_err) {
        /* 等待 */
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`${harness.label} 启动超时\n${harness.logs}`);
  };

  harness.login = async () => {
    const res = await requestOn(harness.port, 'POST', '/api/login', {
      username: '小明',
      password: '123456',
    });
    const cookie = ((res.headers && res.headers['set-cookie']) || []).length
      ? res.headers['set-cookie'][0].split(';')[0]
      : '';
    if (res.status !== 200 || !cookie) throw new Error(`登录失败：HTTP ${res.status}`);
    harness.cookie = cookie;
    return cookie;
  };

  harness.connect = async () => {
    harness.conn = await connectSSE(harness.port, harness.cookie);
    await harness.conn.next('snapshot', 5000);
    return harness.conn;
  };

  harness.stop = () => {
    try {
      if (harness.conn) harness.conn.close();
    } catch (_err) {
      /* ignore */
    }
    try {
      if (harness.childApp) harness.childApp.kill();
    } catch (_err) {
      /* ignore */
    }
    try {
      if (harness.mockServer) harness.mockServer.close();
    } catch (_err) {
      /* ignore */
    }
    try {
      if (harness.tempConfigPath) fs.unlinkSync(harness.tempConfigPath);
    } catch (_err) {
      /* ignore */
    }
    try {
      if (harness.storeFile) fs.unlinkSync(harness.storeFile);
    } catch (_err) {
      /* ignore */
    }
    try {
      if (harness.storeDir) fs.rmSync(harness.storeDir, { recursive: true, force: true });
    } catch (_err) {
      /* ignore */
    }
  };

  return harness;
}

async function sendAndEcho(harness, text) {
  const res = await requestOn(harness.port, 'POST', '/api/messages', { text }, harness.cookie);
  assert(res.status === 200, `发消息成功（HTTP ${res.status}）`);
  const echo = await harness.conn.next('message', 5000);
  assert(echo.message.role === 'user' && echo.message.text === text, '收到自己的消息');
}

async function waitAnyAI(harness, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const evt = await harness.conn.next('message', Math.max(200, deadline - Date.now()));
    if (evt.message && evt.message.role === 'ai') return evt.message;
  }
}

async function waitAICount(harness, count, timeoutMs = 10000) {
  const received = [];
  const deadline = Date.now() + timeoutMs;
  while (received.length < count) {
    if (Date.now() > deadline) throw new Error(`等待 ${count} 条 AI 回复超时`);
    received.push(await waitAnyAI(harness, Math.max(300, deadline - Date.now())));
  }
  return received;
}

async function expectAISilence(harness, timeoutMs = 1200) {
  const extra = await harness.conn
    .next('message', timeoutMs)
    .then((evt) => evt.message && evt.message.role === 'ai')
    .catch(() => false);
  assert(!extra, '不应出现 AI 回复');
}

async function waitForCount(getter, count, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (getter().length < count) {
    if (Date.now() > deadline) {
      throw new Error(`等待请求数达到 ${count} 超时（当前 ${getter().length}）`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function countPersistedAI(harness) {
  const res = await requestOn(
    harness.port,
    'GET',
    `/api/history?date=${shanghaiTodayKey()}`,
    null,
    harness.cookie
  );
  const data = JSON.parse(res.body);
  const messages = (data && data.messages) || [];
  return messages.filter((m) => m.role === 'ai').length;
}

async function runBasicScenario() {
  console.log('【场景 1】self 模式基础行为\n');
  const harness = createHarness({
    label: '基础场景',
    port: 3240,
    storageTag: 'basic',
    selfDecision: { maxHops: 0 },
  });
  await harness.start();
  ok('self 模式服务启动（两个 AI，maxHops=0）');
  await harness.login();
  await harness.connect();
  try {

  // 1. 普通消息：两个 AI 都判断为回复
  harness.judgePlan = [{ type: 'reply' }, { type: 'reply' }];
  const judgeBase = harness.judgeRequests().length;
  await sendAndEcho(harness, '自我判断测试：大家好，今天谁来聊聊');
  const both = await waitAICount(harness, 2);
  const bothIds = new Set(both.map((m) => m.aiId));
  assert(bothIds.has('xiaozhi') && bothIds.has('xiaowu'), '两个 AI 都判断为回复并发言');
  assert(
    harness.judgeRequests().length - judgeBase === 2,
    '普通消息给每个 AI 各发一次判断请求'
  );
  await expectAISilence(harness);
  ok('普通消息 → 每个 AI 各判断一次，判断为回复才生成');

  // 2. 判断为不回复：不广播、不落盘
  const persistBefore = await countPersistedAI(harness);
  harness.judgePlan = [{ type: 'silent' }, { type: 'silent' }];
  const judgeBeforeSilent = harness.judgeRequests().length;
  await sendAndEcho(harness, '这是一条大家都不会接的闲聊');
  await waitForCount(() => harness.judgeRequests(), judgeBeforeSilent + 2);
  await new Promise((r) => setTimeout(r, 800));
  await expectAISilence(harness, 800);
  const persistAfter = await countPersistedAI(harness);
  assert(persistAfter === persistBefore, '判断为不回复时不会写入任何 AI 消息');
  ok('判断为不回复 → 不广播、不落盘');

  // 3. 判断接口故障：回退随机一位 AI 回复
  harness.judgePlan = [{ type: 'error' }, { type: 'error' }];
  await sendAndEcho(harness, '判断接口故障测试');
  const fallback = await waitAICount(harness, 1);
  assert(AI_IDS.includes(fallback[0].aiId), '判断失败后随机兜底一位 AI 回复');
  await expectAISilence(harness);
  ok('判断接口失败 → 回退随机一位 AI 回复（同一层只兜底一次）');

  // 4. 判断结果无法解析：同样回退
  harness.judgePlan = [{ type: 'garbage' }, { type: 'garbage' }];
  await sendAndEcho(harness, '判断结果无法解析测试');
  const fallback2 = await waitAICount(harness, 1);
  assert(AI_IDS.includes(fallback2[0].aiId), '无法解析判断结果时也回退');
  await expectAISilence(harness);
  ok('判断结果无法解析 → 回退随机一位 AI 回复');

  // 5. @点名：被点名者直接回复，不消耗判断请求，其他 AI 默认不参与
  const judgeBeforeMention = harness.judgeRequests().length;
  await sendAndEcho(harness, '@小悟 点名请回答');
  const named = await waitAICount(harness, 1);
  assert(named[0].aiId === 'xiaowu', '被点名的只有小悟回复');
  await expectAISilence(harness);
  assert(
    harness.judgeRequests().length === judgeBeforeMention,
    '@点名不触发自我判断请求（其他 AI 默认不参与）'
  );
  ok('@小悟 → 小悟直接回复，其他 AI 不判断');

  // 6. @所有人：全部直接回复，同样不判断
  const judgeBeforeEveryone = harness.judgeRequests().length;
  await sendAndEcho(harness, '@所有人 全体集合');
  const all = await waitAICount(harness, 2);
  const allIds = new Set(all.map((m) => m.aiId));
  assert(allIds.has('xiaozhi') && allIds.has('xiaowu'), '@所有人 触发全部 AI');
  await expectAISilence(harness);
  assert(
    harness.judgeRequests().length === judgeBeforeEveryone,
    '@所有人 不触发自我判断请求'
  );
  ok('@所有人 → 全部 AI 直接回复且不重复');

  // 7. 只 @ 人类：AI 沉默且不判断
  const judgeBeforeHuman = harness.judgeRequests().length;
  await sendAndEcho(harness, '@小明 我们单独聊');
  await expectAISilence(harness, 1500);
  assert(
    harness.judgeRequests().length === judgeBeforeHuman,
    '只 @ 人类时不发判断请求'
  );
  ok('只 @ 人类 → 不判断、不回复');

  // 8. 判断阶段与生成阶段上下文条数分开
  harness.judgePlan = [{ type: 'reply' }, { type: 'silent' }];
  await sendAndEcho(harness, '上下文条数测试：判断只看最近几条');
  await waitAICount(harness, 1);
  await expectAISilence(harness);
  const judgeBodies = harness.judgeRequests();
  const lastJudge = judgeBodies[judgeBodies.length - 1];
  const judgeUserCount = lastJudge.body.messages.filter((m) => m.role === 'user').length;
  assert(
    judgeUserCount === 5,
    `判断阶段上下文应为 judgeHistoryCount=5 条（实际 ${judgeUserCount}）`
  );
  assert(
    String(lastJudge.body.messages[0].content).includes('只做一件事：判断'),
    '判断请求使用自我判断提示词'
  );
  const replyBodies = harness.replyRequests();
  const lastReply = replyBodies[replyBodies.length - 1];
  assert(
    lastReply.body.messages.length > lastJudge.body.messages.length,
    '生成阶段上下文条数多于判断阶段（两个配置已分开）'
  );
  ok(
    `判断上下文 ${judgeUserCount} 条，生成上下文 ${lastReply.body.messages.length - 1} 条，两者独立配置`
  );
  } finally {
    harness.stop();
  }
}

async function runAITriggerScenario() {
  console.log('\n【场景 2】AI 消息触发其他 AI 自我判断\n');
  const harness = createHarness({
    label: 'AI 互触发场景',
    port: 3241,
    storageTag: 'aitrigger',
    selfDecision: { maxHops: 1 },
  });
  await harness.start();
  ok('self 模式服务启动（maxHops=1）');
  await harness.login();
  await harness.connect();
  try {

  // @小智 强制回复 → 小智的消息触发小悟自我判断 → 小悟判断为回复
  harness.judgePlan = [{ type: 'reply', reason: '被小智的消息触发' }];
  const judgeBase = harness.judgeRequests().length;
  const replyBase = harness.replyRequests().length;
  await sendAndEcho(harness, '@小智 开始互测');
  const replies = await waitAICount(harness, 2);
  assert(replies[0].aiId === 'xiaozhi', '被点名的小智先回复');
  assert(replies[1].aiId === 'xiaowu', '小智的消息触发小悟自我判断并回复');
  await expectAISilence(harness);
  assert(
    harness.judgeRequests().length - judgeBase === 1,
    'AI 消息只给其他 AI 发一次判断请求（作者本人不再判断）'
  );
  assert(
    harness.replyRequests().length - replyBase === 2,
    '共两次生成：小智强制回复 + 小悟判断后回复'
  );
  ok('AI 消息 → 其他 AI 自行判断是否回复（作者不再判断）');
  ok('maxHops=1 → 小悟回复后不再继续扩散');

  // 判断为不回复时，AI 消息不会引发新的回复
  harness.judgePlan = [];
  await sendAndEcho(harness, '@小智 再来一次');
  await waitAICount(harness, 1);
  await expectAISilence(harness, 1500);
  ok('AI 消息触发的判断结果为不回复 → 不再产生新回复');
  } finally {
    harness.stop();
  }
}

async function runLimitScenario() {
  console.log('\n【场景 3】风暴预算与冷却限制\n');
  const harness = createHarness({
    label: '限制场景',
    port: 3242,
    storageTag: 'limit',
    selfDecision: {
      maxHops: 0,
      maxRepliesPerStorm: 2,
      cooldownMs: 20000,
    },
    aiReplyMode: 'router',
    legacyRouterConfig: true,
  });
  await harness.start();
  ok('旧 router 配置启动（风暴上限 2 条 / 冷却 20 秒）');
  assert(
    harness.logs.includes('chat.router 已废弃'),
    '旧的 chat.router 配置会打印废弃告警'
  );
  assert(
    harness.logs.includes('aiReplyMode="router" 已废弃'),
    'aiReplyMode="router" 会打印废弃告警'
  );
  assert(
    harness.logs.includes('AI 回复模式：self'),
    '废弃的 router 模式按 self 模式运行'
  );
  ok('router 已废弃 → 忽略调度配置、按 self 模式运行并告警');
  await harness.login();
  await harness.connect();
  try {

  // 1. 第一条消息：两个 AI 都回复，正好用满风暴预算
  harness.judgePlan = [{ type: 'reply' }, { type: 'reply' }];
  await sendAndEcho(harness, '限制测试第一条');
  const first = await waitAICount(harness, 2);
  assert(new Set(first.map((m) => m.aiId)).size === 2, '第一条消息两个 AI 都回复');
  await expectAISilence(harness);
  ok('第一条消息 → 两个 AI 回复，用满 maxRepliesPerStorm=2');

  // 2. 第二条消息：判断为回复，但风暴预算已满 → 不生成
  harness.judgePlan = [{ type: 'reply' }, { type: 'reply' }];
  const replyBase = harness.replyRequests().length;
  await sendAndEcho(harness, '限制测试第二条');
  await new Promise((r) => setTimeout(r, 900));
  await expectAISilence(harness, 900);
  assert(
    harness.replyRequests().length === replyBase,
    '预算用满后即使判断为回复也不再生成'
  );
  ok('风暴预算用满 → 判断为回复也不会生成');

  // 3. 新风暴内预算充足，但小智仍在冷却期 → 不生成
  harness.judgePlan = [{ type: 'reply' }, { type: 'reply' }];
  await sendAndEcho(harness, '限制测试第三条');
  await new Promise((r) => setTimeout(r, 900));
  await expectAISilence(harness, 900);
  ok('新风暴内预算充足，但冷却期内的 AI 不会重复发言');

  // 4. @点名：强制回复可以越过冷却与风暴预算
  await sendAndEcho(harness, '@小智 点名强制回复');
  const forced = await waitAICount(harness, 1);
  assert(forced[0].aiId === 'xiaozhi', '点名的小智在冷却期内仍然回复');
  await expectAISilence(harness);
  ok('@点名强制回复可以越过冷却与风暴预算');
  } finally {
    harness.stop();
  }
}

async function runJudgeModelScenario() {
  console.log('\n【场景 4】判断模型单独配置\n');
  const harness = createHarness({
    label: '判断模型场景',
    port: 3243,
    storageTag: 'judgemodel',
    selfDecision: { maxHops: 0 },
    chatJudgeExtra: {
      model: 'judge-shared',
      apiKey: 'judge-shared-key',
      temperature: 0,
      maxTokens: 32,
    },
    agentSelfDecision: {
      xiaozhi: { model: 'judge-zhi', apiKey: 'judge-zhi-key' },
    },
  });
  await harness.start();
  ok('服务启动（全局判断模型 judge-shared，小智覆盖为 judge-zhi）');
  await harness.login();
  await harness.connect();
  try {
    harness.judgePlan = [{ type: 'reply' }, { type: 'reply' }];
    await sendAndEcho(harness, '判断模型配置测试');
    await waitAICount(harness, 2);
    await expectAISilence(harness);

    const judges = harness.judgeRequests();
    const judgeModels = new Set(judges.map((r) => r.body.model));
    assert(judgeModels.has('judge-zhi'), '小智使用自己覆盖的判断模型');
    assert(judgeModels.has('judge-shared'), '小悟继承全局判断模型');
    const zhiJudge = judges.find((r) => r.body.model === 'judge-zhi');
    const sharedJudge = judges.find((r) => r.body.model === 'judge-shared');
    assert(zhiJudge.auth === 'Bearer judge-zhi-key', '小智使用自己覆盖的判断密钥');
    assert(
      sharedJudge.auth === 'Bearer judge-shared-key',
      '小悟使用全局判断接口的密钥'
    );
    assert(
      judges.every((r) => r.body.max_tokens === 32),
      '判断请求使用 selfDecision.maxTokens（未覆盖的字段继承全局值）'
    );

    const replyModels = new Set(harness.replyRequests().map((r) => r.body.model));
    assert(replyModels.has('model-0') && replyModels.has('model-1'), '生成阶段仍用各 AI 自己的模型');
    assert(
      !replyModels.has('judge-shared') && !replyModels.has('judge-zhi'),
      '生成阶段不会误用判断模型'
    );
    ok('判断与生成模型相互独立：判断 judge-zhi / judge-shared，生成 model-0 / model-1');
  } finally {
    harness.stop();
  }
}

async function runAITriggerWithDefaultsScenario() {
  console.log('\n【场景 5】默认限制下 AI 消息触发接话\n');
  const harness = createHarness({
    label: '默认限制场景',
    port: 3244,
    storageTag: 'defaults',
    selfDecision: {
      maxHops: 2,
      cooldownMs: 20000,
      maxRepliesPerStorm: 6,
      maxRepliesPerAIPerStorm: 2,
    },
  });
  await harness.start();
  ok('服务启动（maxHops=2 / 冷却 20 秒 / 单 AI 上限 2 条）');
  await harness.login();
  await harness.connect();
  try {
    harness.judgePlan = [
      { type: 'reply' },
      { type: 'reply' },
      { type: 'reply' },
      { type: 'reply' },
    ];
    await sendAndEcho(harness, '默认限制下的普通消息');
    const replies = await waitAICount(harness, 4);
    await expectAISilence(harness);
    const counts = new Map();
    for (const msg of replies) counts.set(msg.aiId, (counts.get(msg.aiId) || 0) + 1);
    assert(
      counts.get('xiaozhi') === 2 && counts.get('xiaowu') === 2,
      `每个 AI 应在第 0 层和第 1 层各回复一次（实际 ${JSON.stringify([...counts])}）`
    );
    assert(
      harness.replyRequests().length === 4,
      '判断为回复的 AI 消息应该真的产生回复，而不是被静默丢弃'
    );
    ok('每个 AI 各回复 2 次：第 0 层随机/自主 + 第 1 层被对方消息触发');
  } finally {
    harness.stop();
  }
}

async function runSequentialJudgeScenario() {
  console.log('\n【场景 6】随机排序 + 串行判断（避免冷场）\n');
  const harness = createHarness({
    label: '串行判断场景',
    port: 3245,
    storageTag: 'sequential',
    selfDecision: { maxHops: 0, cooldownMs: 0 },
  });
  await harness.start();
  ok('服务启动（maxHops=0，只看同一层判断过程）');
  await harness.login();
  await harness.connect();
  try {
    // 第一个判断的 AI 说不回复，且刻意延迟，验证第二个 AI 一定在其之后判断
    harness.judgePlan = [
      { type: 'silent', reason: '与我无关', delayMs: 250 },
      { type: 'reply', reason: '那我来说两句' },
    ];
    await sendAndEcho(harness, '这条消息会不会冷场');
    await waitAICount(harness, 1);
    await expectAISilence(harness);

    const judges = harness.judgeRequests();
    assert(judges.length === 2, `两个 AI 各判断一次（实际 ${judges.length}）`);
    assert(
      judges[1].receivedAt - judges[0].receivedAt >= 200,
      '同一层判断按顺序串行执行，不会并发'
    );
    const firstPrompt = String(judges[0].body.messages[0].content);
    const secondPrompt = String(judges[1].body.messages[0].content);
    assert(
      firstPrompt.includes('（目前还没有人决定回复）'),
      '第一个判断的 AI 看到的是“还没有人决定回复”'
    );
    assert(
      secondPrompt.includes(judges[0].agentName) && secondPrompt.includes('与我无关'),
      '后面判断的 AI 能在提示词里看到前面 AI 的判断与理由'
    );
    assert(
      secondPrompt.includes('避免冷场') && secondPrompt.includes('避免重复'),
      '判断提示词包含避免冷场与避免重复的规则'
    );
    ok('随机排序 → 串行判断 → 后判断的 AI 看到前面的判断结果与理由');
  } finally {
    harness.stop();
  }
}

process.on('exit', () => {
  /* 各场景结束时已自行清理 */
});

async function main() {
  console.log('AI 自我判断（self 模式）端到端自测开始\n');
  await runBasicScenario();
  await runAITriggerScenario();
  await runLimitScenario();
  await runJudgeModelScenario();
  await runAITriggerWithDefaultsScenario();
  await runSequentialJudgeScenario();
  console.log('\n🎉 AI 自我判断端到端自测全部通过');
}

main().catch((err) => {
  console.error('\n❌ 自测失败：', err.message);
  process.exitCode = 1;
});
