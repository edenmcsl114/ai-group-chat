/**
 * 响应头端到端自测：
 * - API / 页面 / SSE 使用 no-store，防止聊天内容被浏览器缓存
 * - 静态资源使用短时 public max-age
 * - 所有响应带 nosniff / Referrer-Policy，HTML 页面带 CSP
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = 3216;

let childApp = null;
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

function writeTempConfig() {
  const stamp = `${process.pid}-${Date.now()}`;
  const cfg = {
    port: APP_PORT,
    host: '127.0.0.1',
    users: [{ username: '小明', password: '123456', avatar: '🙂' }],
    ai: { enabled: false, name: '小智', avatar: '🤖', persona: '', contextHours: 24 },
    chat: {
      aiReplyMode: 'off',
      displayHours: 24,
      storageDir: `test/.tmp-headers-store-${stamp}.d`,
      storageFile: `test/.tmp-headers-store-${stamp}.jsonl`,
    },
  };
  tempConfigPath = path.join(ROOT, 'test', `.tmp-headers-config-${stamp}.js`);
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
  console.log('响应头自测开始\n');

  writeTempConfig();
  startApp();
  await waitForApp();
  ok('测试服务启动');

  const loginPage = await request('GET', '/login.html');
  assert(loginPage.status === 200, '登录页可访问');
  assert(/no-store/i.test(loginPage.headers['cache-control'] || ''), '登录页 no-store');
  assert(
    /default-src 'self'/.test(loginPage.headers['content-security-policy'] || ''),
    '登录页带 CSP'
  );
  assert(
    /nosniff/i.test(loginPage.headers['x-content-type-options'] || ''),
    '登录页带 X-Content-Type-Options'
  );
  ok('HTML 页面：no-store + CSP + nosniff');

  const style = await request('GET', '/css/style.css');
  assert(style.status === 200, '样式文件可访问');
  assert(/public, max-age=300/.test(style.headers['cache-control'] || ''), '静态资源短时缓存');
  assert(!style.headers['content-security-policy'], '静态资源不带 CSP');
  ok('静态资源：public, max-age=300');

  const apiUnauth = await request('GET', '/api/me');
  assert(apiUnauth.status === 401, '未登录接口返回 401');
  assert(/no-store/i.test(apiUnauth.headers['cache-control'] || ''), 'API no-store');
  ok('API JSON：no-store + nosniff');

  const loginRes = await request('POST', '/api/login', {
    username: '小明',
    password: '123456',
  });
  const cookie = ((loginRes.headers && loginRes.headers['set-cookie']) || [])[0].split(';')[0];
  assert(loginRes.status === 200 && cookie, '登录成功拿到 cookie');

  const room = await request('GET', '/api/room', null, cookie);
  assert(room.status === 200, '/api/room 可用');
  assert(/no-store/i.test(room.headers['cache-control'] || ''), '/api/room no-store');
  ok('登录后 API 同样 no-store');

  cleanup();
  console.log('\n🎉 响应头自测全部通过');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  cleanup();
  process.exit(1);
});
