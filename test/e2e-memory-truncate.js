/**
 * 记忆压缩健壮性端到端自测：
 * 1. 模型输出被 max_tokens 截断（finish_reason=length）时，
 *    保留已经写完整的条目并正常落盘、推进状态，而不是整层失败
 * 2. 高层（周）压缩失败时，日层仍然照常追平、状态照常推进（不再一坏全坏）
 *
 * 做法：本地起一个模拟 OpenAI 接口，用 system 提示词里的「本周 / 当日」区分压缩层级，
 * 对周压缩分别返回「被截断的 JSON」和「HTTP 500」，再检查记忆文件与 _state.json。
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3238;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

let mockServer = null;
let childApp = null;
let logs = '';
let currentScenario = null;
let weeklyMode = 'truncate';
const memoryRequests = [];

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

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shKey(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dateKeyToUtcMs(key) {
  const parts = String(key).split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2]);
}

function addDaysKey(key, days) {
  const d = new Date(dateKeyToUtcMs(key) + days * 24 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function periodKeyOf(level, key) {
  const d = new Date(dateKeyToUtcMs(key));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  if (level === 'weekly') return addDaysKey(key, -((d.getUTCDay() + 6) % 7));
  if (level === 'monthly') return `${y}-${pad2(m)}`;
  if (level === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (level === 'year') return String(y);
  return key;
}

function latestCompletedKey(level, today) {
  if (level === 'weekly') return addDaysKey(periodKeyOf('weekly', today), -7);
  if (level === 'monthly') {
    const d = new Date(dateKeyToUtcMs(`${periodKeyOf('monthly', today)}-01`));
    return periodKeyOf('monthly', addDaysKey(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-01`, -1));
  }
  if (level === 'quarter') {
    const q = periodKeyOf('quarter', today);
    const y = Number(q.slice(0, 4));
    const index = Number(q.slice(6));
    const startMonth = (index - 1) * 3 + 1;
    return periodKeyOf('quarter', addDaysKey(`${y}-${pad2(startMonth)}-01`, -1));
  }
  if (level === 'year') return String(Number(today.slice(0, 4)) - 1);
  return today;
}

function memoryLevelOf(system) {
  if (system.includes('本年度')) return 'year';
  if (system.includes('本季度')) return 'quarter';
  if (system.includes('本月')) return 'monthly';
  if (system.includes('本周')) return 'weekly';
  return 'daily';
}

function completion(content, finishReason) {
  return JSON.stringify({
    id: 'mock-memory',
    object: 'chat.completion',
    model: 'mock-memory-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason || 'stop',
      },
    ],
  });
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
        const system = String((body.messages && body.messages[0] && body.messages[0].content) || '');
        const level = memoryLevelOf(system);
        memoryRequests.push({ level, system });

        if (level === 'weekly' && weeklyMode === 'fail') {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: { message: 'mock weekly failure' } }));
          return;
        }

        if (level === 'weekly' && weeklyMode === 'truncate') {
          // 模拟撞到 max_tokens：JSON 在半条记录处被切断
          const broken =
            '{"entries":[' +
            '{"category":"事实","member":"小明","time":"2026-09-07 10:00","content":"周一装好了新的记录脚本"},' +
            '{"category":"事件","member":"小明","time":"2026-09-08 11:00","content":"这条被截断的记';
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(completion(broken, 'length'));
          return;
        }

        const entry = {
          category: '事实',
          member: '小明',
          time: `${currentScenario.seedDay} 10:00`,
          content: `${level} 层的正常记忆`,
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(completion(JSON.stringify({ entries: [entry] }), 'stop'));
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function scenarioPaths(name) {
  const stamp = `${process.pid}-${Date.now()}`;
  const base = path.join(ROOT, 'test', `.tmp-memtrunc-${name}-${stamp}`);
  return {
    base,
    daysDir: path.join(base, 'days'),
    memoryDir: path.join(base, 'memory'),
    configPath: path.join(base, 'config.js'),
  };
}

function writeScenario(name, mockPort, options) {
  const paths = scenarioPaths(name);
  memoryRequests.length = 0;
  const today = shKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const weekKey = latestCompletedKey('weekly', today);
  const seedDays = [weekKey, addDaysKey(weekKey, 1)];

  currentScenario = { name, today, yesterday, weekKey, seedDays, seedDay: seedDays[0] };

  fs.mkdirSync(paths.daysDir, { recursive: true });
  for (const dateKey of seedDays) {
    const parts = dateKey.split('-').map(Number);
    const time = Date.UTC(parts[0], parts[1] - 1, parts[2], 2, 0, 0) - SHANGHAI_OFFSET_MS;
    fs.writeFileSync(
      path.join(paths.daysDir, `${dateKey}.jsonl`),
      `${JSON.stringify({
        id: Number(dateKey.replace(/-/g, '')),
        role: 'user',
        name: '小明',
        avatar: '🙂',
        text: `${dateKey} 的群聊内容`,
        time,
      })}\n`,
      'utf8'
    );
  }

  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.memoryDir, '_state.json'),
    JSON.stringify({ lastDailyDate: addDaysKey(weekKey, -1) }, null, 2),
    'utf8'
  );

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
        apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
        apiKey: 'test-key',
        model: 'mock-chat-model',
        id: 'xiaozhi',
      },
    ],
    chat: {
      aiReplyMode: 'off',
      everyoneKeywords: ['@所有人', '@all'],
      storageDir: path.relative(ROOT, paths.daysDir).replace(/\\/g, '/'),
      storageFile: path.relative(ROOT, path.join(paths.base, 'messages.jsonl')).replace(/\\/g, '/'),
    },
    memory: {
      enabled: true,
      debug: false,
      apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: 'test-key',
      model: 'mock-memory-model',
      temperature: 0.2,
      maxTokens: 8192,
      timeoutMs: 30000,
      maxInputChars: 60000,
      backfillOnStartup: options.backfillOnStartup !== false,
      budgets: { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
      prompts: options.prompts || {},
      storageDir: path.relative(ROOT, paths.memoryDir).replace(/\\/g, '/'),
    },
  };
  fs.writeFileSync(paths.configPath, `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`);

  currentScenario.paths = paths;
  return paths;
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
    await new Promise((r) => setTimeout(r, 150));
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
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待超时：${label}\n${logs}`);
}

async function stopScenario() {
  if (childApp) {
    childApp.kill();
    childApp = null;
  }
  const paths = currentScenario && currentScenario.paths;
  if (paths) {
    try {
      fs.rmSync(paths.base, { recursive: true, force: true });
    } catch (_err) {
      /* ignore */
    }
  }
  currentScenario = null;
  await new Promise((r) => setTimeout(r, 250));
}

function readState() {
  return JSON.parse(
    fs.readFileSync(path.join(currentScenario.paths.memoryDir, '_state.json'), 'utf8')
  );
}

function memoryPath(level, key) {
  return path.join(currentScenario.paths.memoryDir, level, `${key}.json`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
}

function ok(text) {
  console.log(`  ✅ ${text}`);
}

async function scenarioTruncated() {
  console.log('\n[1/2] 输出被截断时保留已完整的条目');
  weeklyMode = 'truncate';
  const paths = writeScenario('truncate', mockServer.address().port, {
    prompts: {
      // 自定义 + 占位符；weekly 显式留空，用来验证「留空回退内置默认」
      daily: '自定义日压缩策略：最多 {{maxEntries}} 条，只留长期有用信息。',
      weekly: '',
    },
  });
  startApp(paths.configPath);
  await waitForApp();

  // ---- 各层提示词装配 ----
  await waitFor(() => memoryRequests.some((r) => r.level === 'daily'), 20000, '等待日压缩请求');
  const dailyRequest = memoryRequests.find((r) => r.level === 'daily');
  assert(
    dailyRequest.system.includes('自定义日压缩策略'),
    '设置里的自定义日提示词应进入请求'
  );
  assert(!dailyRequest.system.includes('{{maxEntries}}'), '占位符应被替换成实际数字');
  assert(
    dailyRequest.system.includes('输出格式固定') && dailyRequest.system.includes('"type":"entry"'),
    '固定输出格式与 JSONL 样例仍应追加'
  );
  ok('自定义提示词生效、占位符被替换、输出格式约束保持不变');

  await waitFor(
    () => memoryRequests.some((r) => r.level === 'weekly'),
    20000,
    '等待周压缩请求'
  );
  const weeklyRequest = memoryRequests.find((r) => r.level === 'weekly');
  assert(
    weeklyRequest && weeklyRequest.system.includes('把本周的日记忆上卷成周记忆'),
    '提示词留空的层级应回退到内置默认'
  );
  assert(
    !weeklyRequest.system.includes('自定义日压缩策略'),
    '不同层级的提示词不应互相串用'
  );
  ok('留空的层级回退内置默认，各层互不串用');

  const weeklyFile = memoryPath('weekly', currentScenario.weekKey);
  await waitFor(() => fs.existsSync(weeklyFile), 20000, '等待周记忆（被截断）落盘');
  const weekly = JSON.parse(fs.readFileSync(weeklyFile, 'utf8'));

  assert(weekly.entries.length >= 1, '截断的 JSON 里至少应抢救出 1 条记录');
  assert(
    weekly.entries.some((e) => String(e.content).includes('周一装好了新的记录脚本')),
    '应保留被截断之前已经写完整的条目'
  );
  assert(
    !weekly.entries.some((e) => String(e.content).includes('这条被截断')),
    '不应保留写了一半的条目'
  );
  ok('输出被截断时保留了完整条目，未整层失败');

  await waitFor(
    () =>
      readState().lastWeeklyKey === currentScenario.weekKey &&
      readState().lastDailyDate === currentScenario.yesterday,
    20000,
    '等待状态推进（weekly + daily）'
  );
  ok('状态照常推进：周记忆记为已完成，日层追平到昨天');

  assert(
    fs.existsSync(memoryPath('daily', currentScenario.seedDays[0])),
    '日记忆文件应已生成'
  );
  ok('日层不受影响，照常追平');

  assert(!logs.includes('压缩失败'), `不应出现压缩失败日志\n${logs}`);
  ok('日志中没有压缩失败');

  await stopScenario();
}

async function scenarioDecoupled() {
  console.log('\n[2/2] 高层压缩失败不阻塞日层');
  weeklyMode = 'fail';
  const paths = writeScenario('fail', mockServer.address().port, {});
  startApp(paths.configPath);
  await waitForApp();

  const seedDaily = memoryPath('daily', currentScenario.seedDays[0]);
  await waitFor(
    () => fs.existsSync(seedDaily) && readState().lastDailyDate === currentScenario.yesterday,
    25000,
    '等待日层在周压缩失败的情况下仍然追平'
  );
  ok('周压缩失败时，日层仍然追平到昨天并写入状态');

  await waitFor(
    () => logs.includes('weekly') && logs.includes('失败'),
    15000,
    '等待周压缩失败日志'
  );
  ok('失败被记录到日志（weekly 压缩失败）');

  assert(
    !fs.existsSync(memoryPath('weekly', currentScenario.weekKey)),
    '周压缩确实失败了，不应生成周记忆文件'
  );
  ok('周记忆没有被写入假数据');

  await stopScenario();
}

async function main() {
  console.log('记忆压缩健壮性自测开始');
  mockServer = await startMockAI();
  try {
    await scenarioTruncated();
    await scenarioDecoupled();
    console.log('\n🎉 记忆压缩健壮性自测全部通过');
  } catch (err) {
    console.error('\n❌ 记忆压缩健壮性自测失败：', err && err.message ? err.message : err);
    await stopScenario();
    process.exit(1);
  } finally {
    if (mockServer) mockServer.close();
  }
  process.exit(0);
}

main();
