/**
 * 设置界面端到端自测：
 * 1. admin 才能访问设置页面与设置接口，普通账号被拒
 * 2. 保存后立即生效（AI 改名、账号新增、回复模式切换）
 * 3. 改密码会让该账号已有登录态失效
 * 4. 配置落到覆盖文件，重启后仍然生效；恢复默认可清空覆盖
 * 5. 写操作要求同源（Origin/Referer），非法配置被拒绝
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3221;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };
const ORIGIN = `http://127.0.0.1:${APP_PORT}`;

let childApp = null;
let tempConfigPath = null;
let tempSettingsPath = null;
let tempDaysDir = null;
let appLogs = '';

function request(method, apiPath, body, cookie, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body === undefined || body === null ? null : JSON.stringify(body);
    const headers = Object.assign({}, extraHeaders || {});
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
  return { status: res.status, cookie, body: res.body };
}

function writeTempFiles() {
  const stamp = `${process.pid}-${Date.now()}`;
  tempConfigPath = path.join(ROOT, 'test', `.tmp-settings-config-${stamp}.js`);
  tempSettingsPath = path.join(ROOT, 'test', `.tmp-settings-store-${stamp}.json`);
  tempDaysDir = path.join(ROOT, 'test', `.tmp-settings-days-${stamp}`);

  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    sessionDays: 7,
    users: [
      { username: 'admin', password: 'admin-pass', avatar: '🛠️', role: 'admin' },
      { username: 'user2', password: 'user2-pass', avatar: '🙂' },
    ],
    ais: [
      {
        enabled: true,
        id: 'xiaozhi',
        name: '小智',
        avatar: '🤖',
        persona: '你是小智。',
        historyCount: 50,
        prefixAiReplies: true,
        streamReply: false,
        apiBaseUrl: 'http://127.0.0.1:9/v1',
        apiKey: 'sk-test',
        model: 'mock-model',
        temperature: 0.8,
        maxTokens: 300,
        timeoutMs: 5000,
        thinking: { enabled: false, effort: 'medium', sendEffort: false },
      },
    ],
    memory: { enabled: false, storageDir: 'data/memory' },
    chat: {
      aiReplyMode: 'off',
      silentOnHumanOnlyMention: true,
      aiReplyOnAIMention: true,
      aiMentionMaxHops: 2,
      everyoneMaxHops: 1,
      everyoneKeywords: ['@所有人', '@all'],
      selfDecision: { enabled: true, globalConcurrency: 3 },
      storageDir: path.relative(ROOT, tempDaysDir).replace(/\\/g, '/'),
      storageFile: path.relative(ROOT, tempDaysDir).replace(/\\/g, '/') + '/messages.jsonl',
    },
  };

  fs.writeFileSync(tempConfigPath, `'use strict';\nmodule.exports = ${JSON.stringify(cfg, null, 2)};\n`);
  fs.mkdirSync(tempDaysDir, { recursive: true });
}

function startApp() {
  childApp = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      CONFIG_FILE: tempConfigPath,
      SETTINGS_FILE: tempSettingsPath,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  appLogs = '';
  childApp.stdout.on('data', (d) => (appLogs += d));
  childApp.stderr.on('data', (d) => (appLogs += d));
}

async function stopApp() {
  if (!childApp) return;
  const child = childApp;
  childApp = null;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    try {
      child.kill();
    } catch (_err) {
      resolve();
    }
    setTimeout(resolve, 3000);
  });
}

async function waitForApp() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await login('admin', 'admin-pass');
      if (res.status === 200 && res.cookie) return;
    } catch (_err) {
      /* 还没就绪 */
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
  for (const target of [tempConfigPath, tempSettingsPath]) {
    try {
      if (target) fs.unlinkSync(target);
    } catch (_err) {
      /* ignore */
    }
  }
  try {
    if (tempSettingsPath) {
      const dir = path.dirname(tempSettingsPath);
      const prefix = `${path.basename(tempSettingsPath)}.bak-`;
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(prefix)) fs.unlinkSync(path.join(dir, name));
      }
    }
  } catch (_err) {
    /* ignore */
  }
  try {
    if (tempDaysDir) fs.rmSync(tempDaysDir, { recursive: true, force: true });
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
  console.log('设置界面端到端自测开始\n');

  writeTempFiles();
  startApp();
  await waitForApp();
  ok('测试服务启动（admin + 普通账号，aiReplyMode=off）');

  const adminLogin = await login('admin', 'admin-pass');
  const userLogin = await login('user2', 'user2-pass');
  assert(adminLogin.cookie && userLogin.cookie, '两个账号都能登录');

  const meRes = await request('GET', '/api/me', null, adminLogin.cookie);
  const me = JSON.parse(meRes.body);
  assert(me.ok && me.user.role === 'admin', '/api/me 返回 admin 角色');
  ok('/api/me 暴露角色字段');

  const deniedApi = await request('GET', '/api/settings', null, userLogin.cookie);
  assert(deniedApi.status === 403, `普通账号访问设置接口应 403（实际 ${deniedApi.status}）`);
  const deniedPage = await request('GET', '/settings.html', null, userLogin.cookie);
  assert(
    deniedPage.status === 302 && deniedPage.headers.location === '/',
    '普通账号访问设置页面被重定向回聊天室'
  );
  ok('非 admin 无法进入设置界面与设置接口');

  const adminPage = await request('GET', '/settings.html', null, adminLogin.cookie);
  assert(
    adminPage.status === 200 && adminPage.body.includes('设置'),
    'admin 可以打开设置页面'
  );
  const settingsJs = await request('GET', '/js/settings.js', null, adminLogin.cookie);
  const settingsCss = await request('GET', '/css/settings.css', null, adminLogin.cookie);
  assert(settingsJs.status === 200, '设置页脚本可访问');
  assert(settingsCss.status === 200, '设置页样式可访问');
  ok('admin 可以打开设置页面');

  const settingsRes = await request('GET', '/api/settings', null, adminLogin.cookie);
  const settings = JSON.parse(settingsRes.body);
  assert(settings.ok && settings.config && settings.config.port === APP_PORT, '返回完整生效配置');
  assert(
    settings.meta.adminUsers.includes('admin'),
    'meta.adminUsers 包含 admin'
  );
  ok('设置接口返回完整配置与 meta');

  const noOrigin = await request(
    'POST',
    '/api/settings',
    { config: settings.config },
    adminLogin.cookie
  );
  assert(noOrigin.status === 403, `缺少 Origin 的写请求应 403（实际 ${noOrigin.status}）`);
  ok('非同一来源的写请求被拒绝');

  const badConfig = JSON.parse(JSON.stringify(settings.config));
  badConfig.users = [
    { username: 'dup', password: 'a', role: 'admin' },
    { username: 'dup', password: 'b', role: 'user' },
  ];
  const badRes = await request(
    'POST',
    '/api/settings',
    { config: badConfig },
    adminLogin.cookie,
    { Origin: ORIGIN }
  );
  const badData = JSON.parse(badRes.body);
  assert(
    badRes.status === 400 && Array.isArray(badData.errors) && badData.errors.length > 0,
    '重复账号名被拒绝'
  );
  ok('非法配置被校验拦截');

  const noAdminConfig = JSON.parse(JSON.stringify(settings.config));
  noAdminConfig.users = [{ username: 'admin', password: 'admin-pass', role: 'user' }];
  const noAdminRes = await request(
    'POST',
    '/api/settings',
    { config: noAdminConfig },
    adminLogin.cookie,
    { Origin: ORIGIN }
  );
  assert(noAdminRes.status === 400, '不允许去掉最后一个 admin');
  ok('至少保留一个 admin 账号');

  // ---- 各层压缩提示词：长度校验 ----
  const longPromptConfig = JSON.parse(JSON.stringify(settings.config));
  longPromptConfig.memory = Object.assign({}, longPromptConfig.memory, {
    prompts: { daily: 'x'.repeat(4001) },
  });
  const longPromptRes = await request(
    'POST',
    '/api/settings',
    { config: longPromptConfig },
    adminLogin.cookie,
    { Origin: ORIGIN }
  );
  const longPromptData = JSON.parse(longPromptRes.body);
  assert(
    longPromptRes.status === 400 &&
      (longPromptData.errors || []).some((e) => e.includes('memory.prompts.daily')),
    '过长的压缩提示词被拒绝'
  );
  ok('过长的压缩提示词被校验拦截');

  // ---- 保存并立即生效 ----
  const nextConfig = JSON.parse(JSON.stringify(settings.config));
  nextConfig.ais[0].name = '小智改';
  nextConfig.users.push({ username: 'user3', password: 'user3-pass', avatar: '🙂', role: 'user' });
  nextConfig.sessionDays = 3;
  nextConfig.chat.aiReplyMode = 'hybrid';
  nextConfig.memory = Object.assign({}, nextConfig.memory, {
    // 顺手验证「在设置界面里启用记忆 + 自定义提示词」这条路径
    enabled: true,
    prompts: Object.assign({}, nextConfig.memory && nextConfig.memory.prompts, {
      monthly: '自定义月压缩策略：只保留长期事实（最多 {{maxEntries}} 条）',
    }),
  });
  const saveRes = await request(
    'POST',
    '/api/settings',
    { config: nextConfig },
    adminLogin.cookie,
    { Origin: ORIGIN }
  );
  const saved = JSON.parse(saveRes.body);
  assert(saveRes.status === 200 && saved.ok, `保存成功（实际 ${saveRes.status} ${saveRes.body}）`);
  assert(
    Array.isArray(saved.restartRequired) && saved.restartRequired.length === 0,
    '未改动需重启字段时不提示重启'
  );
  ok('保存配置成功');

  const roomRes = await request('GET', '/api/room', null, adminLogin.cookie);
  const room = JSON.parse(roomRes.body);
  assert(room.room.ais[0].name === '小智改', 'AI 改名立即生效');
  const user3Login = await login('user3', 'user3-pass');
  assert(user3Login.status === 200 && user3Login.cookie, '新增账号可以立即登录');
  ok('配置保存后立即生效');

  const afterSettings = JSON.parse(
    (await request('GET', '/api/settings', null, adminLogin.cookie)).body
  );
  assert(
    afterSettings.config.memory &&
      afterSettings.config.memory.prompts &&
      String(afterSettings.config.memory.prompts.monthly).includes('自定义月压缩策略'),
    '压缩提示词保存后立即生效'
  );
  assert(
    Array.isArray(afterSettings.meta.memory.customPrompts) &&
      afterSettings.meta.memory.customPrompts.includes('monthly'),
    `记忆运行状态里标出自定义过提示词的层级（实际 ${JSON.stringify(afterSettings.meta.memory)}）`
  );
  ok('压缩提示词可保存、立即生效，并在记忆状态里标出');

  // ---- 改密码强制下线 ----
  const passwordConfig = JSON.parse(JSON.stringify(nextConfig));
  passwordConfig.users = passwordConfig.users.map((u) =>
    u.username === 'user2' ? Object.assign({}, u, { password: 'new-pass' }) : u
  );
  const pwdRes = await request(
    'POST',
    '/api/settings',
    { config: passwordConfig },
    adminLogin.cookie,
    { Origin: ORIGIN }
  );
  const pwdData = JSON.parse(pwdRes.body);
  assert(pwdRes.status === 200 && pwdData.ok, '改密码保存成功');
  assert(
    Array.isArray(pwdData.forcedLogout) && pwdData.forcedLogout.includes('user2'),
    '响应里标出被强制下线的账号'
  );
  const oldSession = await request('GET', '/api/me', null, userLogin.cookie);
  assert(oldSession.status === 401, '改密码后旧登录态失效');
  ok('改密码会强制该账号重新登录');

  // ---- 重启后仍然生效 ----
  await stopApp();
  startApp();
  await waitForApp();
  const adminAgain = await login('admin', 'admin-pass');
  const afterRestart = JSON.parse(
    (await request('GET', '/api/settings', null, adminAgain.cookie)).body
  );
  assert(afterRestart.ok, '重启后设置接口可用');
  assert(afterRestart.config.ais[0].name === '小智改', '重启后 AI 改名仍然生效');
  assert(
    afterRestart.config.users.some((u) => u.username === 'user3'),
    '重启后新增账号仍然存在'
  );
  ok('配置持久化，重启后仍然生效');

  // ---- 导出 ----
  const exportRes = await request('GET', '/api/settings/export', null, adminAgain.cookie);
  assert(exportRes.status === 200, '导出接口可用');
  assert(
    /attachment/i.test(exportRes.headers['content-disposition'] || ''),
    '导出以附件形式返回'
  );
  const exported = JSON.parse(exportRes.body);
  assert(exported.ais && exported.ais[0].name === '小智改', '导出内容是最新生效配置');
  ok('导出配置可用');

  // ---- 需重启字段提示（放在最后，避免改端口影响后续请求） ----
  const restartConfig = JSON.parse(JSON.stringify(exported));
  restartConfig.port = APP_PORT + 1;
  const restartRes = await request(
    'POST',
    '/api/settings',
    { config: restartConfig },
    adminAgain.cookie,
    { Origin: ORIGIN }
  );
  const restartData = JSON.parse(restartRes.body);
  assert(
    restartRes.status === 200 &&
      Array.isArray(restartData.restartRequired) &&
      restartData.restartRequired.includes('port'),
    '改端口时提示需要重启'
  );
  ok('需重启字段会明确提示');

  // ---- 恢复默认 ----
  const resetRes = await request(
    'POST',
    '/api/settings/reset',
    {},
    adminAgain.cookie,
    { Origin: ORIGIN }
  );
  assert(resetRes.status === 200, `恢复默认成功（实际 ${resetRes.status} ${resetRes.body}）`);
  const afterReset = JSON.parse(
    (await request('GET', '/api/settings', null, adminAgain.cookie)).body
  );
  assert(afterReset.config.ais[0].name === '小智', '恢复默认后 AI 名字回到 config 默认值');
  assert(
    !afterReset.config.users.some((u) => u.username === 'user3'),
    '恢复默认后新增账号被移除'
  );
  assert(afterReset.meta.hasOverride === false, '恢复默认后覆盖文件已删除');
  ok('恢复默认可用');

  console.log('\n🎉 设置界面端到端自测全部通过');
}

main()
  .catch((err) => {
    console.error('\n❌ 自测失败：', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    cleanup();
  });
