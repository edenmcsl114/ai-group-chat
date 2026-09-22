/**
 * session 过期端到端自测：
 * 用临时配置把 sessionDays 设成很小的值启动独立服务，
 * 验证登录后短期内有效、超过有效期后 /api/me 返回 401，且过期后可重新登录。
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3214;
const APP_BASE = { hostname: '127.0.0.1', port: APP_PORT };

let childApp = null;
let tempConfigPath = null;
let tempStorePath = null;
let tempStoreDir = null;

function request(method, apiPath, body, cookie, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (extraHeaders) Object.assign(headers, extraHeaders);
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

function writeTempConfig() {
  const stamp = `${process.pid}-${Date.now()}`;
  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    sessionDays: 0.00001, // ≈ 0.864 秒，用于快速验证过期
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ai: { enabled: false, name: '小智', avatar: '🤖', persona: '', contextHours: 24 },
    chat: {
      aiReplyMode: 'off',
      displayHours: 24,
      storageDir: `test/.tmp-session-store-${stamp}.d`,
      storageFile: `test/.tmp-session-store-${stamp}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-session-config-${stamp}.js`);
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
  console.log('session 过期自测开始\n');

  writeTempConfig();
  startApp();
  await waitForApp();
  ok('测试服务启动（sessionDays ≈ 0.86 秒）');

  // Secure 只应在 HTTPS 下附加，纯 HTTP 不能带（否则本机调试登录会失效）
  const plainLoginRes = await request('POST', '/api/login', {
    username: '小明',
    password: '123456',
  });
  const plainSetCookie = ((plainLoginRes.headers['set-cookie'] || [])[0] || '').toLowerCase();
  assert(plainLoginRes.status === 200, '纯 HTTP 登录成功');
  assert(!plainSetCookie.includes('secure'), '纯 HTTP 登录 Set-Cookie 不应带 Secure');
  ok('纯 HTTP 登录 cookie 不带 Secure');

  const httpsLoginRes = await request(
    'POST',
    '/api/login',
    { username: '小明', password: '123456' },
    null,
    { 'X-Forwarded-Proto': 'https' }
  );
  const httpsSetCookie = ((httpsLoginRes.headers['set-cookie'] || [])[0] || '').toLowerCase();
  assert(httpsLoginRes.status === 200, 'HTTPS（反代透传）登录成功');
  assert(httpsSetCookie.includes('secure'), 'HTTPS 登录 Set-Cookie 应带 Secure');
  ok('X-Forwarded-Proto: https → 登录 cookie 带 Secure');

  const cookie = await login('小明', '123456');
  assert(cookie, '登录返回 session cookie');

  const meBefore = await request('GET', '/api/me', null, cookie);
  assert(meBefore.status === 200, `未过期时 /api/me 可用（实际 HTTP ${meBefore.status}）`);
  ok('登录后 session 有效');

  // 等待超过服务端 session 有效期（864ms）
  await new Promise((r) => setTimeout(r, 1400));

  const meAfter = await request('GET', '/api/me', null, cookie);
  assert(meAfter.status === 401, `过期后 /api/me 返回 401（实际 HTTP ${meAfter.status}）`);
  ok('超过有效期后旧 session 被拒绝');

  const reloginCookie = await login('小明', '123456');
  const meRelogin = await request('GET', '/api/me', null, reloginCookie);
  assert(
    meRelogin.status === 200,
    `过期后可重新登录并访问（实际 HTTP ${meRelogin.status}）`
  );
  ok('过期后可重新登录');

  cleanup();
  console.log('\n🎉 session 过期自测全部通过');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
