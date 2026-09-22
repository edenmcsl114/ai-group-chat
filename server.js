'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 基础配置文件：默认项目根目录的 config.js；测试可用环境变量 CONFIG_FILE 指定别的配置
const CONFIG_FILE = process.env.CONFIG_FILE
  ? path.resolve(process.env.CONFIG_FILE)
  : path.join(ROOT, 'config.js');
// 设置界面保存的覆盖配置；不修改 config.js，便于回滚与“恢复默认”。
// 测试用 CONFIG_FILE 时，覆盖文件默认落在同目录的 .tmp-settings-*，避免污染真实配置。
const SETTINGS_FILE = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : process.env.CONFIG_FILE
    ? path.join(
        path.dirname(CONFIG_FILE),
        `.tmp-settings-${path.basename(CONFIG_FILE)}.json`
      )
    : path.join(ROOT, 'data', 'settings.json');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepClone(item);
    return out;
  }
  return value;
}

// 深合并：对象递归合并，数组与其他类型整体替换
function mergeConfig(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? deepClone(base) : deepClone(override);
  }
  const merged = {};
  for (const [key, value] of Object.entries(base)) merged[key] = deepClone(value);
  for (const [key, value] of Object.entries(override)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeConfig(merged[key], value)
      : deepClone(value);
  }
  return merged;
}

// 只保留与基础配置不同的字段，作为覆盖层写入；其余字段继续跟随 config.js
function diffConfig(base, next) {
  const out = {};
  for (const [key, value] of Object.entries(next)) {
    const baseValue = isPlainObject(base) ? base[key] : undefined;
    if (isPlainObject(value) && isPlainObject(baseValue)) {
      const sub = diffConfig(baseValue, value);
      if (Object.keys(sub).length > 0) out[key] = sub;
    } else if (JSON.stringify(baseValue) !== JSON.stringify(value)) {
      out[key] = value;
    }
  }
  return out;
}

// 没有 config.js 时退回 config.example.js，保证设置界面能启动起来
function resolveBaseConfigFile() {
  if (fs.existsSync(CONFIG_FILE)) return CONFIG_FILE;
  const fallback = path.join(ROOT, 'config.example.js');
  if (CONFIG_FILE !== fallback && fs.existsSync(fallback)) {
    console.warn(
      `[配置] 未找到 ${path.basename(CONFIG_FILE)}，暂时使用 config.example.js 作为默认配置`
    );
    return fallback;
  }
  return CONFIG_FILE;
}

const BASE_CONFIG_FILE = resolveBaseConfigFile();
const baseConfig = require(BASE_CONFIG_FILE);

function readSettingsOverride() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return isPlainObject(parsed) ? parsed : {};
  } catch (err) {
    console.warn(
      `[配置] 读取 ${SETTINGS_FILE} 失败，已忽略覆盖配置：`,
      err && err.message ? err.message : err
    );
    return {};
  }
}

let settingsOverride = readSettingsOverride();
let config = mergeConfig(baseConfig, settingsOverride);

// 覆盖层存在时明确提示：同名字段（含 users / ais 这类数组，数组是整体替换）
// 会以 data/settings.json 为准，config.js 里的对应内容不再生效。
if (Object.keys(settingsOverride).length > 0) {
  console.log(
    `[配置] 已加载设置覆盖 ${path.relative(ROOT, SETTINGS_FILE) || SETTINGS_FILE}，` +
      '其中保存过的字段会覆盖 config.js（数组整体替换）；可在设置页点「恢复默认」清空'
  );
}

const SESSION_COOKIE = 'sid';
// 登录态有效期：config.sessionDays 可配置（天，支持小数便于测试），默认 7 天
function resolveSessionMaxAgeMs() {
  const days = Number(config.sessionDays);
  if (!Number.isFinite(days) || days <= 0) return 7 * 24 * 60 * 60 * 1000;
  return Math.max(1, Math.round(days * 24 * 60 * 60 * 1000));
}
let sessionMaxAgeMs = resolveSessionMaxAgeMs();
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000; // 群聊统一使用 Asia/Shanghai（UTC+8，无夏令时）
const MESSAGE_MAX_LENGTH = 2000;
const HEARTBEAT_MS = 25000; // SSE 心跳，防止连接被中间设备断开
// 单条 SSE 连接待发送队列上限；超过说明客户端消费太慢，断开让其重连补快照
const SSE_MAX_QUEUE_BYTES = 2 * 1024 * 1024;
const DEFAULT_STORAGE_DIR = 'data/days';
const DEFAULT_LEGACY_STORE = 'data/messages.jsonl';
const DEFAULT_EVERYONE_KEYWORDS = ['@所有人', '@all'];

// 存储布局（方案 B）：
// - 新消息按 Asia/Shanghai 自然日拆成 <storageDir>/YYYY-MM-DD.jsonl
// - 配置 storageDir 时使用该目录；否则沿用旧 storageFile 路径派生独立目录
// - 旧版单文件 messages.jsonl 在首次启动时自动迁移并改名备份
function resolveStoragePaths() {
  const chat = config.chat || {};
  const dirCfg = String(chat.storageDir || '').trim();
  if (dirCfg) {
    return {
      dir: path.resolve(ROOT, dirCfg),
      legacyFile: path.resolve(ROOT, String(chat.storageFile || DEFAULT_LEGACY_STORE).trim()),
    };
  }
  const legacyFile = path.resolve(ROOT, String(chat.storageFile || DEFAULT_LEGACY_STORE).trim());
  const ext = path.extname(legacyFile);
  return {
    dir: ext ? `${legacyFile.slice(0, -ext.length)}.d` : `${legacyFile}.d`,
    legacyFile,
  };
}

const storagePaths = resolveStoragePaths();
const STORAGE_DIR = storagePaths.dir;
const LEGACY_STORAGE_FILE = storagePaths.legacyFile;
const MEMORY_DIR = path.resolve(
  ROOT,
  String((config.memory && config.memory.storageDir) || 'data/memory')
);

const sessions = new Map(); // sid -> { username, createdAt }
const sseClients = new Set(); // { res, username }
const presenceCounts = new Map(); // username -> 活跃 SSE 连接数
let lastPresenceKey = '';
const aiQueues = new Map(); // aiId -> 该 AI 独立的回复队列（Promise 链）
// "stormId:aiId:深度"：同一风暴里同一 AI 同一层只排一次；不同风暴互不影响
const everyonePending = new Set();
let aiUnconfiguredNotified = false;

// ---------------- AI 配置归一（兼容旧的单 ai，也支持新的 ais 数组） ----------------

function buildAiAgents() {
  const source = Array.isArray(config.ais) && config.ais.length ? config.ais : [config.ai];
  const agents = [];
  const idOwners = new Map();
  for (const raw of source) {
    if (!raw || raw.enabled === false) continue;
    const merged = Object.assign({}, config.ai || {}, raw);
    const name = String(merged.name || 'AI');
    const configuredId =
      merged.id == null ? '' : String(merged.id).trim();
    let id = configuredId || `legacy-${name}`;

    if (idOwners.has(id)) {
      if (configuredId) {
        throw new Error(
          `AI 成员 id 重复：${id}（涉及成员：${idOwners.get(id)}、${name}）`
        );
      }
      let suffix = 2;
      while (idOwners.has(`${id}-${suffix}`)) suffix += 1;
      id = `${id}-${suffix}`;
    }

    idOwners.set(id, name);
    agents.push(
      Object.assign({}, merged, {
        id,
        name,
        avatar: merged.avatar || '🤖',
      })
    );
  }
  return agents;
}

let aiAgents = buildAiAgents();

// ---------------- 持久化存储（按日 JSONL + 内存热窗口） ----------------

// 实时窗口与 AI 上下文都改为“今天 00:00 起”，内存热窗口留一点余量即可
const HOT_HOURS = 26;

let history = []; // 热窗口消息
let nextMessageId = 1;
const dayCache = new Map(); // dateKey -> 按需读取的完整日消息（LRU）
const dayMeta = new Map(); // dateKey -> { count, firstTime, lastTime }
const DAY_CACHE_LIMIT = 20;
let appendChain = Promise.resolve(); // 异步串行写入队列

function cacheDay(dateKey, messages) {
  if (dayCache.has(dateKey)) dayCache.delete(dateKey);
  dayCache.set(dateKey, messages);
  while (dayCache.size > DAY_CACHE_LIMIT) {
    dayCache.delete(dayCache.keys().next().value);
  }
}

function normalizeLoadedMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = Number(raw.id);
  const time = Number(raw.time);
  if (!Number.isFinite(id) || !Number.isFinite(time)) return null;
  if (raw.role !== 'user' && raw.role !== 'ai') return null;
  const text = String(raw.text == null ? '' : raw.text);
  const name = String(raw.name == null ? '' : raw.name);
  if (!name) return null;
  const msg = { id, role: raw.role, name, avatar: String(raw.avatar || ''), text, time };
  if (raw.aiId) msg.aiId = String(raw.aiId);
  return msg;
}

function isDayFileName(name) {
  return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name);
}

function dayFilePath(dateKey) {
  return path.join(STORAGE_DIR, `${dateKey}.jsonl`);
}

function trimHotHistory() {
  const cutoff = Date.now() - HOT_HOURS * 60 * 60 * 1000;
  if (history.length === 0 || history[0].time >= cutoff) return;
  history = history.filter((m) => m.time >= cutoff);
}

// 逐行读取一个分日文件，去重并按 (time, id) 排序
async function readDayFileRaw(dateKey) {
  const file = dayFilePath(dateKey);
  if (!fs.existsSync(file)) return [];
  const messages = [];
  const seenIds = new Set();
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = normalizeLoadedMessage(JSON.parse(trimmed));
        if (msg && !seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          messages.push(msg);
        }
      } catch (_err) {
        console.error('[存储] 忽略无法解析的历史行');
      }
    }
  } finally {
    rl.close();
  }
  messages.sort((a, b) => a.time - b.time || a.id - b.id);
  return messages;
}

// 某一天完整消息：首次访问读文件，随后 LRU 缓存
async function getDayMessages(dateKey) {
  const cached = dayCache.get(dateKey);
  if (cached) {
    cacheDay(dateKey, cached);
    return cached;
  }
  const messages = await readDayFileRaw(dateKey);
  cacheDay(dateKey, messages);
  return messages;
}

async function buildDayMeta() {
  dayMeta.clear();
  const files = (await fs.promises.readdir(STORAGE_DIR))
    .filter(isDayFileName)
    .sort();
  for (const name of files) {
    const dateKey = name.slice(0, 10);
    const messages = await readDayFileRaw(dateKey);
    if (messages.length === 0) continue;
    dayMeta.set(dateKey, {
      count: messages.length,
      firstTime: messages[0].time,
      lastTime: messages[messages.length - 1].time,
    });
  }
}

// 旧版单文件迁移：按 Asia/Shanghai 日拆分写入，成功后原文件改名为备份
async function migrateLegacyStoreIfNeeded() {
  if (!fs.existsSync(LEGACY_STORAGE_FILE)) return;
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  const grouped = new Map();
  const seenIds = new Set();
  let parsedCount = 0;
  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(LEGACY_STORAGE_FILE, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = normalizeLoadedMessage(JSON.parse(trimmed));
        if (!msg || seenIds.has(msg.id)) continue;
        seenIds.add(msg.id);
        parsedCount += 1;
        const key = serverDateKey(msg.time);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(msg);
      } catch (_err) {
        console.error('[存储] 迁移时忽略无法解析的历史行');
      }
    }
    rl.close();
  } catch (err) {
    console.error('[存储] 读取旧存储文件失败：', err.message);
    return;
  }
  if (parsedCount === 0) {
    console.warn(`[存储] 旧文件 ${LEGACY_STORAGE_FILE} 没有可迁移的消息`);
    return;
  }
  for (const [dateKey, msgs] of grouped) {
    const existing = await readDayFileRaw(dateKey);
    const existingIds = new Set(existing.map((m) => m.id));
    const missing = msgs
      .filter((m) => !existingIds.has(m.id))
      .sort((a, b) => a.time - b.time || a.id - b.id);
    if (missing.length === 0) continue;
    const lines = missing.map((m) => `${JSON.stringify(m)}\n`).join('');
    await fs.promises.appendFile(dayFilePath(dateKey), lines, 'utf8');
  }
  const backup = `${LEGACY_STORAGE_FILE}.migrated-${Date.now()}`;
  await fs.promises.rename(LEGACY_STORAGE_FILE, backup);
  console.log(`[存储] 旧存储文件已迁移到 ${STORAGE_DIR}（备份：${backup}）`);
}

// 启动扫描：只把热窗口消息载入内存；历史日列表改为打开历史面板时按需读取
async function initializeStorage() {
  await migrateLegacyStoreIfNeeded();
  await fs.promises.mkdir(STORAGE_DIR, { recursive: true });
  const files = (await fs.promises.readdir(STORAGE_DIR)).filter(isDayFileName).sort();
  const hotCutoff = Date.now() - HOT_HOURS * 60 * 60 * 1000;
  const hotDateKey = serverDateKey(hotCutoff);
  let maxId = 0;
  let foundMaxId = false;
  for (const name of files.slice().reverse()) {
    const dateKey = name.slice(0, 10);
    if (foundMaxId && dateKey < hotDateKey) break;
    const messages = await readDayFileRaw(dateKey);
    if (!foundMaxId && messages.length > 0) {
      for (const msg of messages) {
        if (msg.id > maxId) maxId = msg.id;
      }
      foundMaxId = true;
    }
    if (dateKey >= hotDateKey) {
      for (const msg of messages) {
        if (msg.time >= hotCutoff) history.push(msg);
      }
    }
  }
  history.sort((a, b) => a.time - b.time || a.id - b.id);
  nextMessageId = maxId + 1;
  await buildDayMeta();
}

function updateDayMeta(msg) {
  const dateKey = serverDateKey(msg.time);
  const meta = dayMeta.get(dateKey);
  if (!meta) {
    dayMeta.set(dateKey, { count: 1, firstTime: msg.time, lastTime: msg.time });
    return;
  }
  meta.count += 1;
  if (msg.time < meta.firstTime) meta.firstTime = msg.time;
  if (msg.time > meta.lastTime) meta.lastTime = msg.time;
}

function updateDayCacheAfterPersist(msg) {
  const dateKey = serverDateKey(msg.time);
  const cached = dayCache.get(dateKey);
  if (cached) {
    cached.push(msg);
    if (cached.length < 2 || msg.time < cached[cached.length - 2].time) {
      cached.sort((a, b) => a.time - b.time || a.id - b.id);
    }
    cacheDay(dateKey, cached);
  }
  updateDayMeta(msg);
}

async function persistMessage(msg) {
  const file = dayFilePath(serverDateKey(msg.time));
  const line = `${JSON.stringify(msg)}\n`;
  const task = appendChain.then(() => fs.promises.appendFile(file, line, 'utf8'));
  appendChain = task.then(
    () => {},
    () => {}
  );
  await task;
  updateDayCacheAfterPersist(msg);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------- 基础工具 ----------------

function findByUsername(username) {
  return (config.users || []).find((u) => u.username === username) || null;
}

function parseCookies(req) {
  const result = {};
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch (_err) {
      // 保留原始值
    }
    result[key] = value;
  }
  return result;
}

function createSession(username) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { username, createdAt: Date.now() });
  return sid;
}

function destroySession(sid) {
  sessions.delete(sid);
}

// ---------------- 登录防暴力破解 ----------------

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BASE_FAILURES = 5;
const LOGIN_DELAY_MS = 1000;
const LOGIN_MAX_DELAY_MS = 5000;
const loginFailures = new Map(); // key -> { count, windowStart }

function clientIp(req) {
  if (config.trustProxy) {
    const xff = req && req.headers && req.headers['x-forwarded-for'];
    if (xff) {
      const first = String(xff).split(',')[0].trim();
      if (first) return first;
    }
  }
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginFailureKeys(req, username) {
  const ip = clientIp(req);
  const name = String(username || '').trim().toLowerCase();
  return {
    pairKey: ip && name ? `pair:${ip}:${name}` : '',
    userKey: name ? `user:${name}` : '',
    ipKey: ip ? `ip:${ip}` : '',
  };
}

function loginDelayMs(keys) {
  let delay = 0;
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (!key) continue;
    const entry = loginFailures.get(key);
    if (!entry) continue;
    if (Date.now() - entry.windowStart >= LOGIN_WINDOW_MS) {
      loginFailures.delete(key);
      continue;
    }
    if (entry.count >= LOGIN_BASE_FAILURES) {
      const extra = entry.count - LOGIN_BASE_FAILURES;
      const next = LOGIN_DELAY_MS * Math.pow(2, extra);
      delay = Math.max(delay, Math.min(LOGIN_MAX_DELAY_MS, next));
    }
  }
  return delay;
}

function recordLoginFailure(keys) {
  const now = Date.now();
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (!key) continue;
    let entry = loginFailures.get(key);
    if (!entry || now - entry.windowStart >= LOGIN_WINDOW_MS) {
      entry = { count: 0, windowStart: now };
    }
    entry.count += 1;
    loginFailures.set(key, entry);
  }
}

function clearLoginFailures(keys) {
  for (const key of Array.isArray(keys) ? keys : [keys]) {
    if (key) loginFailures.delete(key);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------- 群聊状态 ----------------

async function addMessage(role, name, avatar, text, forcedId, aiId, time) {
  const msg = {
    id: forcedId || nextMessageId++,
    role,
    name,
    avatar: avatar || '',
    text,
    time: time || Date.now(),
  };
  if (aiId) msg.aiId = aiId;
  // 先落盘成功，再进入内存/热窗口；写失败会向上抛出，调用方不会广播假消息
  await persistMessage(msg);
  history.push(msg);
  trimHotHistory();
  return msg;
}

// 把时间戳拆成 Asia/Shanghai 的日历字段，不依赖服务器本机时区
function shanghaiClock(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

// 今天 00:00（Asia/Shanghai）对应的 epoch 毫秒
function todayStartMs() {
  const p = shanghaiClock(Date.now());
  return Date.UTC(p.year, p.month - 1, p.day) - SHANGHAI_OFFSET_MS;
}

// 只取今天 00:00 起的消息（用于实时显示与 AI 上下文）
function recentToday() {
  const cutoff = todayStartMs();
  return history.filter((m) => m.time >= cutoff);
}

// 按 Asia/Shanghai 固定时区的自然日分组
function serverDateKey(ts) {
  const p = shanghaiClock(ts);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function serverDateLabel(dateKey) {
  const todayKey = serverDateKey(Date.now());
  if (dateKey === todayKey) return '今天';
  const yesterdayKey = serverDateKey(Date.now() - 24 * 60 * 60 * 1000);
  if (dateKey === yesterdayKey) return '昨天';
  const parts = String(dateKey).split('-').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dateKey;
  return `${parts[0]}年${parts[1]}月${parts[2]}日`;
}

async function buildHistoryDays() {
  const days = [];
  for (const [dateKey, meta] of dayMeta) {
    if (!meta || meta.count === 0) continue;
    days.push({
      date: dateKey,
      label: serverDateLabel(dateKey),
      count: meta.count,
      firstTime: meta.firstTime,
      lastTime: meta.lastTime,
    });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1));
  return days;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 生成 [2026/09/06][19:07:23] 形式的时间前缀（Asia/Shanghai）
function formatPromptPrefix(ts, name) {
  const p = shanghaiClock(ts);
  const datePart = `${p.year}/${pad2(p.month)}/${pad2(p.day)}`;
  const timePart = `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  return `[${datePart}][${timePart}][${name}]{`;
}

// 统一判断 API Key / Base URL 是否为“未填写”或示例占位符，
// 避免 config.example.js 复制后未改 key 时被误认为已配置。
function isBlankOrPlaceholder(value) {
  const v = String(value || '').trim();
  if (!v) return true;
  return /填写|请替换|your[-_ ]?key|sk-xxx|changeme/i.test(v);
}

function isUsableApiKey(value) {
  return !isBlankOrPlaceholder(value);
}

function isUsableBaseUrl(value) {
  const v = String(value || '').trim();
  return v.length > 0 && !isBlankOrPlaceholder(v);
}

// ---------------- 分层长期记忆（日 / 周 / 月 / 季 / 年 压缩） ----------------

const MEMORY_LEVEL_ORDER = ['daily', 'weekly', 'monthly', 'quarter', 'year'];
const MEMORY_CATEGORIES = ['事实', '事件', '偏好', '计划', '情绪/状态', '临时信息', '无意义闲聊'];
const MEMORY_DROP_CATEGORY = '无意义闲聊';
let memoryChain = Promise.resolve(); // 串行执行跨天压缩，避免并发写同一批文件

function getMemorySettings() {
  const raw = config.memory;
  if (!raw || raw.enabled === false) return null;
  const fallback = aiAgents.find((a) => aiIsConfigured(a)) || {};
  const budgets = Object.assign(
    { daily: 2000, weekly: 3000, monthly: 5000, quarter: 6000, year: 8000 },
    raw.budgets || {}
  );
  return Object.assign({}, raw, {
    apiBaseUrl: String(raw.apiBaseUrl || fallback.apiBaseUrl || '')
      .trim()
      .replace(/\/+$/, ''),
    apiKey: String(raw.apiKey || fallback.apiKey || '').trim(),
    model: String(raw.model || fallback.model || '').trim(),
    maxInputChars: Math.max(1, Number(raw.maxInputChars) || 60000),
    backfillOnStartup: raw.backfillOnStartup !== false,
    budgets,
  });
}

function memoryIsReady(settings) {
  return !!(
    settings &&
    isUsableBaseUrl(settings.apiBaseUrl) &&
    isUsableApiKey(settings.apiKey) &&
    settings.model
  );
}

function memoryFilePath(level, key) {
  return path.join(MEMORY_DIR, level, `${key}.json`);
}

function parseDateKey(key) {
  const parts = String(key).split('-').map(Number);
  return { y: parts[0], m: parts[1], d: parts[2] };
}

function dateKeyFromParts(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function dateKeyToUtcMs(key) {
  const { y, m, d } = parseDateKey(key);
  return Date.UTC(y, m - 1, d);
}

function dateKeyFromUtcMs(ms) {
  const d = new Date(ms);
  return dateKeyFromParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

function addDaysKey(key, days) {
  return dateKeyFromUtcMs(dateKeyToUtcMs(key) + days * 24 * 60 * 60 * 1000);
}

function dateKeyCompare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// 周一是每周第 0 天（Asia/Shanghai 自然周）
function isoWeekdayMondayIndex(key) {
  return (new Date(dateKeyToUtcMs(key)).getUTCDay() + 6) % 7;
}

function periodRange(level, dateKey) {
  const { y, m } = parseDateKey(dateKey);
  if (level === 'daily') return { start: dateKey, end: dateKey };
  if (level === 'weekly') {
    const monday = addDaysKey(dateKey, -isoWeekdayMondayIndex(dateKey));
    return { start: monday, end: addDaysKey(monday, 6) };
  }
  if (level === 'monthly') {
    return {
      start: dateKeyFromParts(y, m, 1),
      end: dateKeyFromParts(y, m, daysInMonth(y, m)),
    };
  }
  if (level === 'quarter') {
    const quarterStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
    const endMonth = quarterStartMonth + 2;
    return {
      start: dateKeyFromParts(y, quarterStartMonth, 1),
      end: dateKeyFromParts(y, endMonth, daysInMonth(y, endMonth)),
    };
  }
  if (level === 'year') {
    return { start: dateKeyFromParts(y, 1, 1), end: dateKeyFromParts(y, 12, 31) };
  }
  throw new Error(`未知记忆层级 ${level}`);
}

function periodKey(level, dateKey) {
  const { y, m } = parseDateKey(dateKey);
  if (level === 'daily') return dateKey;
  if (level === 'weekly') return addDaysKey(dateKey, -isoWeekdayMondayIndex(dateKey));
  if (level === 'monthly') return `${y}-${pad2(m)}`;
  if (level === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
  if (level === 'year') return String(y);
  throw new Error(`未知记忆层级 ${level}`);
}

// 层级 key -> 该周期内的一个代表日期，供 periodRange 使用
function periodDateKey(level, key) {
  if (level === 'daily' || level === 'weekly') return key;
  if (level === 'monthly') return `${key}-01`;
  if (level === 'quarter') {
    const y = Number(key.slice(0, 4));
    const q = Number(key.slice(6));
    return dateKeyFromParts(y, (q - 1) * 3 + 1, 1);
  }
  if (level === 'year') return `${key}-01-01`;
  throw new Error(`未知记忆层级 ${level}`);
}

function nextPeriodKey(level, key) {
  if (level === 'weekly') return addDaysKey(key, 7);
  if (level === 'monthly') {
    const { y, m } = parseDateKey(`${key}-01`);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    return dateKeyFromParts(nextY, nextM, 1).slice(0, 7);
  }
  if (level === 'quarter') {
    const y = Number(key.slice(0, 4));
    const q = Number(key.slice(6));
    return q === 4 ? `${y + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  if (level === 'year') return String(Number(key) + 1);
  throw new Error(`未知记忆层级 ${level}`);
}

function latestCompletedPeriodKey(level, today) {
  const { y, m } = parseDateKey(today);
  if (level === 'weekly') {
    return addDaysKey(addDaysKey(today, -isoWeekdayMondayIndex(today)), -7);
  }
  if (level === 'monthly') {
    return periodKey('monthly', addDaysKey(dateKeyFromParts(y, m, 1), -1));
  }
  if (level === 'quarter') {
    return periodKey('quarter', addDaysKey(periodRange('quarter', today).start, -1));
  }
  if (level === 'year') return String(y - 1);
  throw new Error(`未知记忆层级 ${level}`);
}

function memoryStateDefaults() {
  const today = serverDateKey(Date.now());
  const { y, m } = parseDateKey(today);
  const currentWeekMonday = addDaysKey(today, -isoWeekdayMondayIndex(today));
  return {
    lastDailyDate: addDaysKey(today, -1),
    lastWeeklyKey: addDaysKey(currentWeekMonday, -7),
    lastMonthlyKey: periodKey('monthly', addDaysKey(dateKeyFromParts(y, m, 1), -1)),
    lastQuarterKey: periodKey('quarter', addDaysKey(periodRange('quarter', today).start, -1)),
    lastYearKey: String(y - 1),
  };
}

async function readMemoryState() {
  try {
    return JSON.parse(await fs.promises.readFile(path.join(MEMORY_DIR, '_state.json'), 'utf8'));
  } catch (_err) {
    return null;
  }
}

async function writeMemoryState(state) {
  await fs.promises.mkdir(MEMORY_DIR, { recursive: true });
  await fs.promises.writeFile(
    path.join(MEMORY_DIR, '_state.json'),
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

function isValidMemoryFile(obj) {
  return Boolean(obj && typeof obj === 'object' && Array.isArray(obj.entries));
}

async function inspectMemoryFile(level, key) {
  const file = memoryFilePath(level, key);
  try {
    const obj = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    return isValidMemoryFile(obj)
      ? { status: 'valid', data: obj }
      : { status: 'invalid' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { status: 'missing' };
    console.error(`[记忆] 读取失败 ${file}：`, err && err.message ? err.message : err);
    return { status: 'invalid' };
  }
}

async function readMemoryFile(level, key) {
  const result = await inspectMemoryFile(level, key);
  return result.status === 'valid' ? result.data : null;
}

async function writeMemoryFile(level, key, obj) {
  const file = memoryFilePath(level, key);
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file);
}

async function deleteMemoryFile(level, key) {
  await fs.promises.rm(memoryFilePath(level, key), { force: true });
}

function formatMessageForMemory(m) {
  let content = stripAllRecordPrefixes(m.text);
  if (content === null) content = String(m.text || '');
  if (!isFormattedReply(content)) {
    content = formatPromptPrefix(m.time, m.name || '未知用户') + content + '}';
  }
  return content;
}

function formatMemoryEntries(entries) {
  return entries
    .map((e) => `[${e.time || ''}][${e.member || '未知'}][${e.category || '事实'}]${e.content}`)
    .join('\n');
}

function splitByCodePoint(text, limit) {
  const chars = Array.from(String(text || ''));
  const chunks = [];
  for (let offset = 0; offset < chars.length; offset += limit) {
    chunks.push(chars.slice(offset, offset + limit).join(''));
  }
  return chunks.length > 0 ? chunks : [''];
}

function splitBySentence(text, limit) {
  const sentences = String(text || '').split(/(?<=[。！？!?；;\n])/u);
  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (!sentence) continue;
    if (sentence.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitByCodePoint(sentence, limit));
      continue;
    }

    if (current && current.length + sentence.length > limit) {
      chunks.push(current);
      current = sentence;
    } else {
      current += sentence;
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedRecord(record, limit) {
  const text = String(record || '');
  const prefixMatch = text.match(/^(\[[^\]]*\]\[[^\]]*\]\[[^\]]*\]\{?)/);
  if (!prefixMatch) return splitBySentence(text, limit);

  const prefix = prefixMatch[1];
  let body = text.slice(prefix.length);
  const closeBrace = prefix.endsWith('{') && body.endsWith('}');
  if (closeBrace) body = body.slice(0, -1);

  const reserved = prefix.length + (closeBrace ? 1 : 0);
  const bodyLimit = limit - reserved;
  if (bodyLimit <= 0) return splitByCodePoint(text, limit);

  const bodyChunks = splitBySentence(body, bodyLimit);
  return bodyChunks.map((chunk, index) => {
    const suffix = closeBrace && index === bodyChunks.length - 1 ? '}' : '';
    return prefix + chunk + suffix;
  });
}

function splitMemoryInput(parts, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  const chunks = [];
  let current = [];
  let size = 0;

  const flushCurrent = () => {
    if (current.length === 0) return;
    chunks.push(current.join('\n'));
    current = [];
    size = 0;
  };

  for (let part of parts) {
    const text = String(part || '');
    if (text.length <= limit) {
      const addSize = text.length + (current.length ? 1 : 0);
      if (current.length && size + addSize > limit) flushCurrent();
      current.push(text);
      size += text.length + (current.length > 1 ? 1 : 0);
      continue;
    }

    flushCurrent();
    for (const chunk of splitOversizedRecord(text, limit)) {
      chunks.push(chunk);
    }
  }

  flushCurrent();
  return chunks;
}

function dedupeMemoryEntries(entries) {
  const seen = new Set();
  const result = [];

  for (const entry of entries) {
    const key = `${entry.category}|${entry.member}|${entry.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }

  return result;
}

function normalizeMemoryCategory(value) {
  const v = String(value || '').trim();
  if (!v) return '事实';
  const hit = MEMORY_CATEGORIES.find((c) => c === v || c.includes(v) || v.includes(c));
  return hit || '事实';
}

function parseMemoryEntries(rawReply, fallbackMember, fallbackTime) {
  const cleaned = String(rawReply || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let value = null;
  try {
    value = JSON.parse(cleaned);
  } catch (_err) {
    value = null;
  }
  const valid =
    value !== null &&
    typeof value === 'object' &&
    (Array.isArray(value) ||
      Array.isArray(value.entries) ||
      Array.isArray(value.items) ||
      Array.isArray(value.list));
  const rawItems = [];
  const collect = (v) => {
    if (Array.isArray(v)) {
      for (const item of v) collect(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v.entries)) {
      collect(v.entries);
      return;
    }
    if (v.category !== undefined || v.content !== undefined || v.member !== undefined) {
      rawItems.push(v);
      return;
    }
    for (const key of ['entries', 'items', 'list']) {
      if (Array.isArray(v[key])) collect(v[key]);
    }
  };
  collect(value);

  const entries = [];
  const seen = new Set();
  for (const item of rawItems) {
    const content = String(item.content == null ? '' : item.content).trim();
    if (!content) continue;
    const category = normalizeMemoryCategory(item.category);
    if (category === MEMORY_DROP_CATEGORY) continue;
    const member = String(item.member == null ? fallbackMember || '' : item.member).trim();
    const time = String(item.time == null ? fallbackTime || '' : item.time).trim();
    const dedupeKey = `${category}|${member}|${time}|${content}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    entries.push({ category, member, time, content });
  }
  return { valid, entries };
}

function memorySystemPrompt(level, budget, isUpRoll) {
  const levelLabel = {
    daily: '当日',
    weekly: '本周',
    monthly: '本月',
    quarter: '本季度',
    year: '本年度',
  }[level];
  const parts = [
    `你是群聊长期记忆压缩助手。请把给定的群聊记录压缩成${levelLabel || ''}结构化记忆，供群成员 AI 之后参考。`,
    '必须区分「哪个成员」和「什么时间」。',
    `分类只允许：${MEMORY_CATEGORIES.join('、')}。`,
    `「${MEMORY_DROP_CATEGORY}」不要输出；「临时信息」保留并标注。`,
    '只输出一个 JSON 对象，不要代码块、不要解释：{"entries":[{"category":"事实","member":"小智","time":"2026-09-10 14:03","content":"..."}]}。',
    `总输出控制在 ${budget} tokens 以内；同一成员、同一主题尽量合并，不要重复。`,
  ];
  if (isUpRoll) {
    parts.push('输入已经是较低层级的记忆条目：请更新旧信息、合并同类项，新信息覆盖旧信息，避免重复。');
  }
  return parts.join('\n');
}

async function requestMemoryCompression(settings, level, content, budget, isUpRoll) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(settings.timeoutMs) || 60000);
  const body = {
    model: settings.model,
    messages: [
      { role: 'system', content: memorySystemPrompt(level, budget, isUpRoll) },
      { role: 'user', content },
    ],
    stream: false,
    temperature: Number.isFinite(Number(settings.temperature))
      ? Number(settings.temperature)
      : 0.2,
    max_tokens: Math.max(1, Math.min(budget, Number(settings.maxTokens) || 8192)),
  };
  const thinking = settings.thinking || {};
  if (
    thinking.enabled &&
    thinking.sendEffort &&
    ['low', 'medium', 'high'].includes(thinking.effort)
  ) {
    body.reasoning_effort = thinking.effort;
  }
  try {
    const res = await fetch(`${settings.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try {
        detail = await res.text();
        const parsed = JSON.parse(detail);
        detail = (parsed.error && (parsed.error.message || parsed.error.code)) || detail;
      } catch (_err) {
        // 保留原始文本
      }
      throw new Error(`记忆压缩接口返回 HTTP ${res.status}：${String(detail).slice(0, 200)}`);
    }
    const payload = await res.json();
    const contentText =
      (payload.choices &&
        payload.choices[0] &&
        payload.choices[0].message &&
        payload.choices[0].message.content) ||
      '';
    if (!String(contentText).trim()) throw new Error('记忆压缩返回内容为空');
    return String(contentText);
  } finally {
    clearTimeout(timer);
  }
}

async function generateDailyMemory(dateKey) {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return { status: 'skipped' };

  const messages = await getDayMessages(dateKey);
  const usable = messages.filter((m) => m.role === 'user' || m.role === 'ai');
  if (usable.length === 0) return { status: 'skipped' };

  const parts = usable.map(formatMessageForMemory);
  const chunks = splitMemoryInput(parts, settings.maxInputChars);
  const budget = Math.max(1, Number(settings.budgets.daily) || 2000);
  const budgetPerChunk = Math.max(1, Math.floor(budget / chunks.length));
  const allEntries = [];

  for (const chunk of chunks) {
    const raw = await requestMemoryCompression(settings, 'daily', chunk, budgetPerChunk, false);
    const parsed = parseMemoryEntries(raw, '', dateKey);
    if (!parsed.valid) {
      throw new Error(`日压缩返回无法解析的内容：${dateKey}`);
    }
    if (parsed.entries.length) allEntries.push(...parsed.entries);
  }

  const entries = dedupeMemoryEntries(allEntries);

  await writeMemoryFile('daily', dateKey, {
    level: 'daily',
    key: dateKey,
    createdAt: Date.now(),
    range: { start: dateKey, end: dateKey },
    entries,
  });

  if (settings.debug) {
    console.log(`[记忆] 日压缩完成 ${dateKey}：${entries.length} 条`);
  }
  return { status: 'done' };
}

async function ensureValidSources(startDate, endDate, maxLevel) {
  const maxIndex = MEMORY_LEVEL_ORDER.indexOf(maxLevel);
  let cursor = startDate;

  while (dateKeyCompare(cursor, endDate) <= 0) {
    let advanced = false;

    for (let i = maxIndex; i >= 0; i--) {
      const level = MEMORY_LEVEL_ORDER[i];
      const range = periodRange(level, cursor);
      if (dateKeyCompare(range.start, startDate) < 0 || dateKeyCompare(range.end, endDate) > 0) {
        continue;
      }

      const key = periodKey(level, cursor);
      const status = await inspectMemoryFile(level, key);

      if (status.status === 'valid') {
        cursor = addDaysKey(range.end, 1);
        advanced = true;
        break;
      }

      if (status.status === 'invalid') {
        await repairMemoryFile(level, key);
        cursor = addDaysKey(range.end, 1);
        advanced = true;
        break;
      }

      // missing：继续尝试更低层
    }

    if (!advanced) cursor = addDaysKey(cursor, 1);
  }
}

async function repairMemoryFile(level, key) {
  const result =
    level === 'daily'
      ? await generateDailyMemory(key)
      : await generatePeriodMemory(level, periodDateKey(level, key));

  if (result.status === 'skipped') {
    await deleteMemoryFile(level, key);
  }

  return result;
}

async function ensureLatestCompletedPeriodsValid(today) {
  for (const level of ['weekly', 'monthly', 'quarter', 'year']) {
    const key = latestCompletedPeriodKey(level, today);
    const status = await inspectMemoryFile(level, key);
    if (status.status !== 'valid') {
      await repairMemoryFile(level, key);
    }
  }
}

async function gatherMemorySources(startDate, endDate, maxLevel, options = {}) {
  const shouldRepair = options.repair !== false;
  if (shouldRepair) {
    await ensureValidSources(startDate, endDate, maxLevel);
  }

  const maxIndex = MEMORY_LEVEL_ORDER.indexOf(maxLevel);
  const sources = [];
  let cursor = startDate;

  while (dateKeyCompare(cursor, endDate) <= 0) {
    let picked = false;

    for (let i = maxIndex; i >= 0; i--) {
      const level = MEMORY_LEVEL_ORDER[i];
      const range = periodRange(level, cursor);
      if (dateKeyCompare(range.start, startDate) < 0 || dateKeyCompare(range.end, endDate) > 0) {
        continue;
      }

      const key = periodKey(level, cursor);
      const mem = await readMemoryFile(level, key);

      if (isValidMemoryFile(mem) && mem.entries.length > 0) {
        sources.push({
          level,
          key,
          start: range.start,
          end: range.end,
          entries: mem.entries,
        });
        cursor = addDaysKey(range.end, 1);
        picked = true;
        break;
      }
    }

    if (!picked) cursor = addDaysKey(cursor, 1);
  }

  return sources;
}

async function generatePeriodMemory(level, refDateKey) {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return { status: 'skipped' };

  const range = periodRange(level, refDateKey);
  const lowerLevel = MEMORY_LEVEL_ORDER[MEMORY_LEVEL_ORDER.indexOf(level) - 1];
  const sources = await gatherMemorySources(range.start, range.end, lowerLevel);

  const entries = [];
  for (const source of sources) {
    entries.push(...source.entries);
  }

  if (entries.length === 0) return { status: 'skipped' };

  const parts = entries.map((entry) => formatMemoryEntries([entry]));
  const chunks = splitMemoryInput(parts, settings.maxInputChars);
  const budget = Math.max(1, Number(settings.budgets[level]) || 3000);
  const budgetPerChunk = Math.max(1, Math.floor(budget / chunks.length));
  const allEntries = [];

  for (const chunk of chunks) {
    const raw = await requestMemoryCompression(settings, level, chunk, budgetPerChunk, true);
    const parsed = parseMemoryEntries(raw, '', refDateKey);
    if (!parsed.valid) {
      throw new Error(`${level} 压缩返回无法解析的内容：${refDateKey}`);
    }
    if (parsed.entries.length) allEntries.push(...parsed.entries);
  }

  const merged = dedupeMemoryEntries(allEntries);

  const key = periodKey(level, refDateKey);
  await writeMemoryFile(level, key, {
    level,
    key,
    createdAt: Date.now(),
    range,
    entries: merged,
  });

  if (settings.debug) {
    console.log(`[记忆] ${level} 压缩完成 ${key}：${merged.length} 条`);
  }

  return { status: 'done' };
}

async function ensureMemoryCaughtUp() {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return;
  const today = serverDateKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const persistedState = await readMemoryState();
  const state = Object.assign({}, memoryStateDefaults(), persistedState || {});
  let changed = false;
  let aborted = false;

  // 首次启用且还没有状态文件时，先把基线状态落盘。
  // 否则内存中的默认 lastDailyDate 已经是“昨天”，今天不会产生 changed，
  // 明天再次启动又会重新得到同样的默认值，导致已经结束的日期永远不会被压缩。
  if (!persistedState) {
    await writeMemoryState(state);
  }

  // 1. 修复最近已完成周期里损坏的高层文件
  try {
    await ensureLatestCompletedPeriodsValid(today);
  } catch (err) {
    console.error('[记忆] 修复损坏记忆失败，等待下次重试：', err.message);
    aborted = true;
  }

  // 2. 日层追平
  if (!aborted && dateKeyCompare(state.lastDailyDate, yesterday) < 0) {
    let cursor = addDaysKey(state.lastDailyDate, 1);
    while (dateKeyCompare(cursor, yesterday) <= 0) {
      try {
        await generateDailyMemory(cursor);
        state.lastDailyDate = cursor;
        changed = true;
        cursor = addDaysKey(cursor, 1);
      } catch (err) {
        console.error(`[记忆] 日压缩失败，等待下次重试：${cursor}`, err.message);
        aborted = true;
        break;
      }
    }
  }

  // 3. 周/月/季/年追平
  if (!aborted) {
    for (const level of ['weekly', 'monthly', 'quarter', 'year']) {
      const latestKey = latestCompletedPeriodKey(level, today);
      if (dateKeyCompare(state[`last${capitalize(level)}Key`], latestKey) >= 0) continue;
      let cursor = nextPeriodKey(level, state[`last${capitalize(level)}Key`]);
      while (dateKeyCompare(cursor, latestKey) <= 0) {
        try {
          await generatePeriodMemory(level, periodDateKey(level, cursor));
          state[`last${capitalize(level)}Key`] = cursor;
          changed = true;
          cursor = nextPeriodKey(level, cursor);
        } catch (err) {
          console.error(`[记忆] ${level} 压缩失败，等待下次重试：${cursor}`, err.message);
          aborted = true;
          break;
        }
      }
      if (aborted) break;
    }
  }

  if (changed) await writeMemoryState(state);
}

function capitalize(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

async function memoryHasAnyLevelFile() {
  for (const level of MEMORY_LEVEL_ORDER) {
    try {
      const files = await fs.promises.readdir(path.join(MEMORY_DIR, level));
      if (files.some((name) => name.endsWith('.json'))) return true;
    } catch (_err) {
      // 该层级目录不存在，继续检查下一层
    }
  }
  return false;
}

// 拼装给群成员 AI 看的长期记忆：
// 覆盖“上一个自然年 1 月 1 日 到 昨天”，按由粗到细的层级补齐时间范围，
// 避免只取每层最新一份时漏掉今年更早的已完成季度/月份。
async function buildMemorySummary() {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return '';
  if (!(await memoryHasAnyLevelFile())) return '';
  const today = serverDateKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const { y } = parseDateKey(today);
  const startDate = dateKeyFromParts(y - 1, 1, 1);
  const sources = await gatherMemorySources(startDate, yesterday, 'year', {
    repair: false,
  });
  const entries = sources.flatMap((source) => source.entries);
  if (entries.length === 0) return '';
  return '【群聊长期记忆】\n' + formatMemoryEntries(entries);
}

async function listCompletedDayKeys(today) {
  const yesterday = addDaysKey(today, -1);
  const files = await fs.promises.readdir(STORAGE_DIR).catch(() => []);
  return files
    .filter(isDayFileName)
    .map((name) => name.slice(0, 10))
    .filter((dateKey) => dateKeyCompare(dateKey, yesterday) <= 0)
    .sort();
}

function periodStartDateKey(level, dateKey) {
  if (level === 'daily') return dateKey;
  const { y, m } = parseDateKey(dateKey);
  if (level === 'weekly') return addDaysKey(dateKey, -isoWeekdayMondayIndex(dateKey));
  if (level === 'monthly') return dateKeyFromParts(y, m, 1);
  if (level === 'quarter') return dateKeyFromParts(y, Math.floor((m - 1) / 3) * 3 + 1, 1);
  if (level === 'year') return dateKeyFromParts(y, 1, 1);
  throw new Error(`未知记忆层级 ${level}`);
}

function advancePeriodStart(level, dateKey) {
  if (level === 'weekly') return addDaysKey(dateKey, 7);

  const { y, m } = parseDateKey(dateKey);
  if (level === 'monthly') {
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    return dateKeyFromParts(nextY, nextM, 1);
  }
  if (level === 'quarter') {
    const nextMonth = m + 3;
    const nextY = nextMonth > 12 ? y + 1 : y;
    const nextM = nextMonth > 12 ? nextMonth - 12 : nextMonth;
    return dateKeyFromParts(nextY, nextM, 1);
  }
  if (level === 'year') return dateKeyFromParts(y + 1, 1, 1);
  throw new Error(`未知记忆层级 ${level}`);
}

async function ensureDailyFilesForRange(startDate, endDate) {
  let cursor = startDate;
  while (dateKeyCompare(cursor, endDate) <= 0) {
    const status = await inspectMemoryFile('daily', cursor);
    if (status.status === 'invalid') {
      await repairMemoryFile('daily', cursor);
    } else if (status.status === 'missing') {
      await generateDailyMemory(cursor);
    }
    cursor = addDaysKey(cursor, 1);
  }
}

async function ensurePeriodFilesForRange(level, startDate, endDate) {
  let cursor = periodStartDateKey(level, startDate);
  while (true) {
    const range = periodRange(level, cursor);
    if (dateKeyCompare(range.end, endDate) > 0) break;

    const key = periodKey(level, cursor);
    const status = await inspectMemoryFile(level, key);
    if (status.status === 'invalid') {
      await repairMemoryFile(level, key);
    } else if (status.status === 'missing') {
      await generatePeriodMemory(level, periodDateKey(level, key));
    }

    cursor = advancePeriodStart(level, cursor);
  }
}

async function auditMemoryFilesAtStartup() {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return;

  const today = serverDateKey(Date.now());
  const yesterday = addDaysKey(today, -1);
  const dayKeys = await listCompletedDayKeys(today);
  if (dayKeys.length === 0) return;

  const startDate = dayKeys[0];

  await ensureDailyFilesForRange(startDate, yesterday);
  for (const level of ['weekly', 'monthly', 'quarter', 'year']) {
    await ensurePeriodFilesForRange(level, startDate, yesterday);
  }

  await writeMemoryState({
    lastDailyDate: yesterday,
    lastWeeklyKey: latestCompletedPeriodKey('weekly', today),
    lastMonthlyKey: latestCompletedPeriodKey('monthly', today),
    lastQuarterKey: latestCompletedPeriodKey('quarter', today),
    lastYearKey: latestCompletedPeriodKey('year', today),
  });
}

let startupMemoryAuditQueued = false;

// 启动时执行一次，之后由每日 Asia/Shanghai 00:00 定时器调用。
// 消息发送和 AI 回复不再同步等待它，避免历史回填阻塞聊天。
function enqueueMemoryCatchUp() {
  const settings = getMemorySettings();
  if (!memoryIsReady(settings)) return memoryChain;

  if (!startupMemoryAuditQueued) {
    startupMemoryAuditQueued = true;
    if (settings.backfillOnStartup) {
      memoryChain = memoryChain
        .then(() => auditMemoryFilesAtStartup())
        .catch((err) => {
          console.error('[记忆] 启动审计失败，将在下次启动时重试：', err && err.message ? err.message : err);
        });
    }
  }

  memoryChain = memoryChain
    .then(() => ensureMemoryCaughtUp())
    .catch((err) => {
      console.error('[记忆] 压缩任务失败：', err && err.message ? err.message : err);
    });
  return memoryChain;
}

function nextShanghaiMidnightMs() {
  const p = shanghaiClock(Date.now());
  return Date.UTC(p.year, p.month - 1, p.day) - SHANGHAI_OFFSET_MS + 24 * 60 * 60 * 1000;
}

function scheduleDailyMemoryCatchUp() {
  const delay = Math.max(1000, nextShanghaiMidnightMs() - Date.now() + 1000);
  const timer = setTimeout(() => {
    enqueueMemoryCatchUp();
    scheduleDailyMemoryCatchUp();
  }, delay);
  timer.unref();
  return timer;
}

// 把历史快照转成发给指定 AI 的 messages。
// 关键：目标 AI 自己的历史是 assistant；其他所有人（含其他 AI）都是带名字的 user，
// 避免 AI 把别人的发言误当成自己说的。
async function buildAIMessages(snapshot, agent) {
  const replyRule =
    `【输出格式规则】` +
    `你必须严格按照以下格式输出回复：` +
    `严格要求：` +
    `1. 整条回复只能包含上述这一条群聊记录。` +
    `2. 必须以 '[YYYY/MM/DD][HH:MM:SS][${agent.name}]' 开头。` +
    `3. 时间必须使用 24 小时制 'HH:MM:SS'。` +
    `4. 角色名称必须严格使用 '${agent.name}'。` +
    `5. 角色名称后的正文必须放在一对 '{}' 内。` +
    `6. '['、']'、'{'、'}' 的位置必须严格按照格式，不得改变。` +
    `7. 除上述群聊记录外，不得输出任何其他内容。` +
    `8. 不得输出 Markdown、代码块、解释、分析、前缀、后缀或格式说明。` +
    `9. 正文为空时也必须保留 '{}'。` +
    `10. 每次回复只能生成一条群聊记录，禁止重复生成格式。` +
    `11. {} 内的内容才是实际发送给群成员的消息。` +
    `输出前请自行检查，确保最终输出完全符合上述格式。` +
    `【正确示例】` +
    `[2026/09/10][21:30:15][${agent.name}]{你好呀，今天过得怎么样？}` +
    `【错误示例】` +
    `回复：[2026/09/10][21:30:15][${agent.name}]{你好}` +
    `[2026/09/10][21:30:15][${agent.name}]{你好}这是一个很好的思路` +
    '```text' +
    `[2026/09/10][21:30:15][${agent.name}]{你好}`;
  const memorySummary = await buildMemorySummary();
  const systemContent = [agent.persona || '', memorySummary, replyRule]
    .filter(Boolean)
    .join('\n\n');
  const messages = [{ role: 'system', content: systemContent }];

  const formatContent = (m) => {
    let content = stripAllRecordPrefixes(m.text);
    if (content === null) content = m.text;
    if (!isFormattedReply(content)) {
      content = formatPromptPrefix(m.time, m.name || '未知用户') + content + '}';
    }
    return content;
  };

  for (const m of snapshot) {
    const isOwn =
      m.role === 'ai' &&
      ((m.aiId && m.aiId === agent.id) || (!m.aiId && m.name === agent.name));
    if (isOwn) {
      messages.push({ role: 'assistant', content: formatContent(m) });
    } else {
      messages.push({ role: 'user', content: formatContent(m) });
    }
  }
  return messages;
}

function isFormattedReply(text) {
  return /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[^\]]*\]\{/.test(String(text).trimStart());
}

// 识别并剥离一次 [日期][时间][名字]{ ... } 前缀（结尾 } 可有可无）
function stripRecordPrefix(text) {
  const str = String(text || '');
  const matched = str.match(
    /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[^\]]*\]\{/
  );
  if (!matched) return null;
  let body = str.slice(matched[0].length).trim();
  if (body.endsWith('}')) body = body.slice(0, -1).trimEnd();
  return body;
}

// 连续剥离嵌套/残缺的记录前缀（最多 3 层，防模型重复套壳）
function stripAllRecordPrefixes(text) {
  let current = String(text || '');
  for (let i = 0; i < 3; i++) {
    const next = stripRecordPrefix(current);
    if (next === null) return current;
    current = next;
  }
  return current;
}

// 把模型输出规范成 [日期][时间][AI名]{正文}，时间与名字一律以服务器为准
function normalizeAIReply(rawText, ts, aiName) {
  const body = stripAllRecordPrefixes(String(rawText || '').trim());
  if (!body.trim()) throw new Error('AI 只输出了格式前缀，没有正文');
  return formatPromptPrefix(ts, aiName) + body + '}';
}

function aiIsConfigured(agent) {
  return (
    isUsableApiKey(agent.apiKey) &&
    isUsableBaseUrl(agent.apiBaseUrl) &&
    String(agent.model || '').trim().length > 0
  );
}

function notifyAIUnconfigured() {
  if (aiUnconfiguredNotified) return;
  aiUnconfiguredNotified = true;
  const names = aiAgents
    .filter((a) => !aiIsConfigured(a))
    .map((a) => a.name)
    .join('、');
  if (!names) return;
  broadcastSSE('message', {
    message: {
      id: nextMessageId++,
      role: 'system',
      name: '',
      avatar: '',
      text: `⚠️ AI 成员（${names}）尚未配置完整：请检查 config.js 中的 apiBaseUrl / apiKey`,
      time: Date.now(),
    },
  });
}

async function performAIReply(agent, snapshot, depth, stormId) {
  const apiKey = String(agent.apiKey || '').trim();
  const baseUrl = String(agent.apiBaseUrl || '').trim().replace(/\/+$/, '');
  const aiName = agent.name;
  const aiAvatar = agent.avatar;
  const useStream = agent.streamReply === true;

  const msgId = nextMessageId++;
  const startedAt = Date.now();
  const partial = {
    id: msgId,
    role: 'ai',
    aiId: agent.id,
    name: aiName,
    avatar: aiAvatar,
    text: '',
    time: startedAt,
    streaming: true,
  };
  if (useStream) {
    // 流式模式下先广播空消息，前端立刻显示"正在输入"气泡
    broadcastSSE('ai_chunk', { message: partial });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), agent.timeoutMs || 60000);
  let fullText = '';

  try {
    // 上下文拼装放在 try 内：这里出错也要带上 msgId，
    // 否则前端清不掉已经广播出去的流式占位气泡。
    const body = {
      model: agent.model,
      messages: await buildAIMessages(snapshot, agent),
      stream: useStream,
      temperature: Number.isFinite(agent.temperature) ? agent.temperature : 0.7,
      max_tokens: agent.maxTokens || 1024,
    };
    // 思考模型兼容：按配置附带 reasoning_effort（只发给支持的服务商）
    const thinking = agent.thinking || {};
    if (
      thinking.enabled &&
      thinking.sendEffort &&
      ['low', 'medium', 'high'].includes(thinking.effort)
    ) {
      body.reasoning_effort = thinking.effort;
    }

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      let detail = '';
      try {
        detail = await res.text();
        const parsed = JSON.parse(detail);
        detail = (parsed.error && (parsed.error.message || parsed.error.code)) || detail;
      } catch (_err) {
        // detail 保持原始文本
      }
      throw new Error(`AI 接口返回 HTTP ${res.status}：${String(detail).slice(0, 200)}`);
    }

    if (useStream) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handleSseLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) return;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const obj = JSON.parse(data);
          const delta =
            obj.choices &&
            obj.choices[0] &&
            obj.choices[0].delta &&
            obj.choices[0].delta.content;
          if (delta) {
            fullText += delta;
            broadcastSSE('ai_chunk', { message: Object.assign({}, partial, { text: fullText }) });
          }
        } catch (_err) {
          // 忽略无法解析的中间行
        }
      };

      const drainLines = () => {
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          handleSseLine(line);
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        drainLines();
      }

      // 冲刷最后一个多字节字符，并处理没有换行结尾的最后一行 data:
      buffer += decoder.decode();
      if (buffer.trim()) handleSseLine(buffer);
    } else {
      const payload = await res.json();
      fullText =
        (payload.choices &&
          payload.choices[0] &&
          payload.choices[0].message &&
          payload.choices[0].message.content) ||
        '';
    }

    if (!fullText.trim()) throw new Error('AI 返回内容为空');

    const saveTime = Date.now();
    const finalText = normalizeAIReply(fullText, saveTime, aiName);
    let final;
    try {
      final = await addMessage('ai', aiName, aiAvatar, finalText, msgId, agent.id, saveTime);
    } catch (saveErr) {
      const wrapped = new Error(
        `AI 回复生成成功，但保存到磁盘失败：${saveErr && saveErr.message ? saveErr.message : saveErr}`
      );
      if (saveErr && typeof saveErr === 'object') wrapped.cause = saveErr;
      throw wrapped;
    }
    broadcastSSE('message', { message: final });
    return final;
  } catch (err) {
    // 流式模式下可能已经广播了"正在输入"占位气泡，
    // 带上 msgId 让前端能按 id 清理，避免残留空气泡
    if (err && typeof err === 'object') err.msgId = msgId;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// 生成前的统一闸门：self 模式下按风暴预算 / 冷却 / 频率限制决定是否真的调用接口。
// hybrid（随机）与旧模式不经过这些限制，保持原有行为。
async function runAIReplyFor(agent, depth, stormId, triggerKind) {
  const mode = getReplyMode();
  const settings = getSelfDecisionSettings(agent);
  const forced = triggerKind === 'mention' || triggerKind === 'everyone';
  const storm = stormId ? aiStorms.get(stormId) : null;
  const replyDepth = depth || 0;

  if (mode === 'self') {
    const now = Date.now();
    if (!forced) {
      if (storm && !stormAllowsReply(storm, agent.id, settings)) {
        console.log(
          `[AI 回复] ${agent.name} 跳过：本轮风暴回复额度已用完（已回 ${storm.replies} 条，单 AI 已回 ${
            storm.perAi.get(agent.id) || 0
          } 条）`
        );
        return;
      }
      // 冷却只限制“AI 自主回复用户消息”，避免同一个 AI 对用户消息刷屏；
      // AI 消息触发的接话（depth >= 1）由 maxHops 与风暴预算控制，不能被静默吞掉。
      if (replyDepth === 0 && cooldownBlocked(agent, settings, now)) {
        console.log(
          `[AI 回复] ${agent.name} 跳过：距离上次发言不足 ${Math.round(
            settings.cooldownMs / 1000
          )} 秒（cooldownMs）`
        );
        return;
      }
    }
    if (!checkReplyRate(agent, settings, now)) {
      console.warn(
        `[AI 回复] ${agent.name} 触发频率上限，本次跳过（${forced ? '点名' : '自主'}）`
      );
      return;
    }
  }

  const snapshot =
    mode === 'self' ? replySnapshotForAgent(agent, settings) : snapshotForAgent(agent);

  await acquireAiSlot();
  let final = null;
  try {
    final = await performAIReply(agent, snapshot, replyDepth, stormId);
  } finally {
    releaseAiSlot();
  }
  if (!final) return;

  if (mode === 'self') {
    const now = Date.now();
    recordReplyRate(agent, now);
    aiLastReplyAt.set(agent.id, now);
    if (storm) registerStormReply(storm, agent.id);
  }
  triggerAIFromAIMessage(final, agent, replyDepth, stormId);
}

// ---------------- 多 AI 调度：随机 / @ 指定 ----------------

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAtText(text) {
  return String(text || '').replace(/＠/g, '@');
}

// 文本里 @ 了哪些 AI（按名字精确匹配）
function extractMentionedAgentIds(text) {
  const normalized = normalizeAtText(text);
  const ids = new Set();
  for (const agent of aiAgents) {
    const re = new RegExp(`@\\s*${escapeRegExp(agent.name)}(?![\\p{L}\\p{N}])`, 'u');
    if (re.test(normalized)) ids.add(agent.id);
  }
  return ids;
}

function hasHumanMention(text) {
  const normalized = normalizeAtText(text);
  for (const user of config.users || []) {
    const re = new RegExp(`@\\s*${escapeRegExp(user.username)}(?![\\p{L}\\p{N}])`, 'u');
    if (re.test(normalized)) return true;
  }
  return false;
}

function getEveryoneKeywords() {
  const configured = config.chat && Array.isArray(config.chat.everyoneKeywords)
    ? config.chat.everyoneKeywords.filter((keyword) => String(keyword || '').trim())
    : [];
  return configured.length > 0 ? configured : DEFAULT_EVERYONE_KEYWORDS;
}

function isEveryoneMention(text) {
  const normalized = normalizeAtText(text);
  const keywords = getEveryoneKeywords();
  return keywords.some((keyword) => {
    let kw = normalizeAtText(String(keyword || '')).trim();
    if (!kw) return false;
    if (kw.startsWith('@')) kw = kw.slice(1).trim();
    if (!kw) return false;
    // 关键词后必须不是字母/数字（含中文），避免 "@所有人都别说话" 这类误触发；
    // 纯 ASCII 关键词（如 @all）再做一次大小写不敏感匹配
    const flags = /^[a-zA-Z0-9]+$/.test(kw) ? 'iu' : 'u';
    const re = new RegExp(`@\\s*${escapeRegExp(kw)}(?![\\p{L}\\p{N}])`, flags);
    return re.test(normalized);
  });
}

function pickRandomAgent(pool) {
  const agents = Array.isArray(pool) ? pool : aiAgents;
  if (agents.length === 0) return null;
  return agents[crypto.randomInt(agents.length)];
}

function shuffleAgents(agents) {
  const list = Array.isArray(agents) ? agents.slice() : aiAgents.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function takeRecentSnapshot(count) {
  const recent = recentToday();
  const maxCount = Math.max(1, Number(count) || 1);
  return recent.slice(-Math.min(maxCount, recent.length));
}

function snapshotForAgent(agent, countOverride) {
  const override = Number(countOverride);
  const maxCount =
    Number.isFinite(override) && override > 0 ? override : Number(agent.historyCount) || 20;
  return takeRecentSnapshot(maxCount);
}

function enqueueAIReply(agent, depth, triggerKind, stormId) {
  const stormPart = stormId ? `${stormId}:` : '';
  const key = `${stormPart}${agent.id}:${depth || 0}`;
  const everyoneTrigger = triggerKind === 'everyone';
  if (everyoneTrigger) {
    if (everyonePending.has(key)) return null;
    everyonePending.add(key);
  }
  const previous = aiQueues.get(agent.id) || Promise.resolve();
  // 快照在任务真正开跑时生成，而不是入队时生成：
  // 排队期间新到的消息也会进入该回复的上下文，避免慢 AI 积压时答非所问
  // 记忆追平由每日 00:00 后台任务负责，这里不再等待，避免阻塞 AI 回复。
  const task = previous.then(() =>
    runAIReplyFor(agent, depth || 0, stormId, triggerKind || '')
  );
  const guarded = task.catch((err) => {
    const cause = err && err.cause;
    const detail = cause ? `（${cause.code ? `${cause.code}: ` : ''}${cause.message || ''}）` : '';
    const message = `「${agent.name}」回复失败：${err && err.message ? err.message : err}${detail}`;
    console.error('[AI 回复失败]', message);
    const payload = { text: message };
    if (err && Number.isInteger(err.msgId)) payload.msgId = err.msgId;
    broadcastSSE('ai_error', payload);
  });
  if (everyoneTrigger) {
    guarded.finally(() => everyonePending.delete(key));
  }
  aiQueues.set(agent.id, guarded);
  return guarded;
}

// AI 的回复触发其他 AI：
// - self 模式：除作者外所有 AI 都自行判断是否接话；AI 回复里被 @ 到的成员强制回复，
//   整体受 maxHops / 风暴预算 / 冷却 / 频率限制
// - hybrid 模式：保持旧行为，只有 @ 到其他 AI 或 @所有人 才触发，
//   分别受 aiMentionMaxHops / everyoneMaxHops 限制
function triggerAIFromAIMessage(aiMessage, author, depth, stormId) {
  const chatOptions = config.chat || {};
  const mode = getReplyMode();
  if (mode === 'off') return;
  if (chatOptions.aiReplyOnAIMention === false) return;
  const authorDepth = depth || 0;

  if (mode === 'self') {
    const chatSettings = getSelfDecisionSettings(null);
    if (!chatSettings.enabled) return;
    const authorSettings = getSelfDecisionSettings(author);
    if (authorDepth >= authorSettings.maxHops) return;

    let storm = stormId ? aiStorms.get(stormId) : null;
    if (!storm) {
      const newStormId = `ai-${aiMessage.id}`;
      storm = createStorm(newStormId, aiMessage.id);
      stormId = newStormId;
    }

    const nextDepth = authorDepth + 1;
    const everyone = isEveryoneMention(aiMessage.text);
    const mentionedIds = everyone ? null : extractMentionedAgentIds(aiMessage.text);
    const targets = shuffleAgents(
      aiAgents.filter((agent) => agent.id !== author.id && aiIsConfigured(agent))
    );
    // 被点名 / @所有人 的成员直接回复，并先记入本层判断列表，让其他 AI 知道已经有人接话
    for (const target of targets) {
      const forced = everyone || (mentionedIds && mentionedIds.has(target.id));
      if (!forced) continue;
      if (!reserveStormDecision(storm, target.id, nextDepth)) continue;
      recordJudgeOutcome(storm, nextDepth, {
        aiId: target.id,
        name: target.name,
        reply: true,
        reason: everyone ? '被 @所有人，直接回复' : '被点名，直接回复',
      });
      enqueueStormGeneration(
        storm,
        target,
        nextDepth,
        everyone ? 'everyone' : 'mention',
        stormId
      );
    }
    // 其余成员按随机顺序依次自我判断，后面的 AI 能看到前面 AI 的判断结果
    for (const target of targets) {
      const forced = everyone || (mentionedIds && mentionedIds.has(target.id));
      if (forced) continue;
      const targetSettings = getSelfDecisionSettings(target);
      if (!targetSettings.enabled) continue;
      if (!reserveStormDecision(storm, target.id, nextDepth)) continue;
      enqueueSelfJudgement(target, nextDepth, stormId);
    }
    return;
  }

  const everyone = isEveryoneMention(aiMessage.text);
  // AI 回复首次触发 @所有人 且不属于已有风暴时，以这条 AI 消息作为新的风暴根
  if (everyone && !stormId) stormId = `ai-${aiMessage.id}`;
  const maxHops = everyone
    ? chatOptions.everyoneMaxHops == null
      ? 1
      : Math.max(0, Number(chatOptions.everyoneMaxHops) || 0)
    : chatOptions.aiMentionMaxHops == null
      ? 2
      : Math.max(0, Number(chatOptions.aiMentionMaxHops) || 0);
  if (authorDepth >= maxHops) return;

  let targets;
  if (everyone) {
    targets = aiAgents.filter((agent) => agent.id !== author.id);
  } else {
    const mentionedIds = extractMentionedAgentIds(aiMessage.text);
    targets = aiAgents.filter(
      (agent) => mentionedIds.has(agent.id) && agent.id !== author.id
    );
  }
  targets = targets.filter((agent) => aiIsConfigured(agent));
  if (targets.length === 0) return;
  if (everyone) targets = shuffleAgents(targets);

  for (const target of targets) {
    enqueueAIReply(
      target,
      authorDepth + 1,
      everyone ? 'everyone' : 'mention',
      everyone ? stormId : undefined
    );
  }
}

// ---------------- AI 自我判断（self 模式：每个 AI 先判断再回复） ----------------

const SELF_DECISION_DEFAULTS = {
  enabled: true,
  judgeHistoryCount: 30,
  replyHistoryCount: 1024,
  maxHops: 2,
  maxRepliesPerStorm: 6,
  maxRepliesPerAIPerStorm: 2,
  cooldownMs: 20000,
  globalConcurrency: 3,
  forceReplyOnMention: true,
  othersJudgeOnMention: false,
  rateLimit: { perAiPerMinute: 6, totalPerMinute: 20 },
  debug: false,
};

const AI_RATE_WINDOW_MS = 60 * 1000;
const STORM_TTL_MS = 10 * 60 * 1000;
// 判断与生成共用同一个并发闸门，避免一条消息把接口打爆；
// 每次读取配置而不是缓存，设置界面修改后立即生效。
function getAiConcurrencyLimit() {
  return Math.max(1, getSelfDecisionSettings(null).globalConcurrency);
}
let aiApiInFlight = 0;
const aiApiWaiters = [];
const aiLastReplyAt = new Map(); // aiId -> 最近一次成功回复时间
const aiReplyTimestamps = new Map(); // aiId -> 最近一分钟内的回复时间戳
let globalReplyTimestamps = [];
const aiStorms = new Map(); // stormId -> 风暴计数

function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// 合并 chat.selfDecision 与单个 AI 的 selfDecision 覆盖项
function getSelfDecisionSettings(agent) {
  const chat = config.chat || {};
  const base = chat.selfDecision || {};
  const perAgent = (agent && agent.selfDecision) || {};
  const merged = Object.assign({}, SELF_DECISION_DEFAULTS, base, perAgent);
  const rateLimit = Object.assign(
    {},
    SELF_DECISION_DEFAULTS.rateLimit,
    base.rateLimit || {},
    perAgent.rateLimit || {}
  );
  return {
    enabled: merged.enabled !== false,
    judgeHistoryCount: Math.max(
      1,
      toNonNegativeInt(merged.judgeHistoryCount, SELF_DECISION_DEFAULTS.judgeHistoryCount)
    ),
    replyHistoryCount: Math.max(
      1,
      toNonNegativeInt(merged.replyHistoryCount, SELF_DECISION_DEFAULTS.replyHistoryCount)
    ),
    maxHops: toNonNegativeInt(merged.maxHops, SELF_DECISION_DEFAULTS.maxHops),
    maxRepliesPerStorm: toNonNegativeInt(
      merged.maxRepliesPerStorm,
      SELF_DECISION_DEFAULTS.maxRepliesPerStorm
    ),
    maxRepliesPerAIPerStorm: toNonNegativeInt(
      merged.maxRepliesPerAIPerStorm,
      SELF_DECISION_DEFAULTS.maxRepliesPerAIPerStorm
    ),
    cooldownMs: toNonNegativeInt(merged.cooldownMs, SELF_DECISION_DEFAULTS.cooldownMs),
    globalConcurrency: Math.max(
      1,
      toNonNegativeInt(merged.globalConcurrency, SELF_DECISION_DEFAULTS.globalConcurrency)
    ),
    forceReplyOnMention: merged.forceReplyOnMention !== false,
    othersJudgeOnMention: merged.othersJudgeOnMention === true,
    rateLimit: {
      perAiPerMinute: toNonNegativeInt(
        rateLimit.perAiPerMinute,
        SELF_DECISION_DEFAULTS.rateLimit.perAiPerMinute
      ),
      totalPerMinute: toNonNegativeInt(
        rateLimit.totalPerMinute,
        SELF_DECISION_DEFAULTS.rateLimit.totalPerMinute
      ),
    },
    debug: merged.debug === true,
  };
}

// router 已废弃：配置成 router 时按 self 处理；hybrid / always 等旧值保持随机模式
function getReplyMode() {
  const raw = String((config.chat && config.chat.aiReplyMode) || '')
    .trim()
    .toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'self') return 'self';
  if (raw === 'router') return 'self';
  return 'hybrid';
}

function createStorm(stormId, rootMessageId) {
  const existing = aiStorms.get(stormId);
  if (existing) return existing;
  const storm = {
    id: stormId,
    rootMessageId: rootMessageId == null ? null : rootMessageId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    judged: new Set(), // `${aiId}:${depth}`：同一风暴同一层每个 AI 只判断/触发一次
    silent: new Set(), // 已明确判断为不回复的 AI，兜底时避开
    replies: 0,
    perAi: new Map(),
    judgeLog: new Map(), // depth -> 该层已完成的判断（后面的 AI 能看到）
    judgeChains: new Map(), // depth -> 该层串行判断链
    genChain: Promise.resolve(), // 同一风暴内串行生成，后面的 AI 能看到前面的回复
  };
  aiStorms.set(stormId, storm);
  return storm;
}

function cleanupAiStorms() {
  const cutoff = Date.now() - STORM_TTL_MS;
  for (const [id, storm] of aiStorms) {
    if (storm.updatedAt < cutoff) aiStorms.delete(id);
  }
  pruneRateWindow(Date.now());
}

function reserveStormDecision(storm, agentId, depth) {
  if (!storm) return true;
  const key = `${agentId}:${depth || 0}`;
  if (storm.judged.has(key)) return false;
  storm.judged.add(key);
  storm.updatedAt = Date.now();
  return true;
}

function stormAllowsReply(storm, agentId, settings) {
  if (!storm) return true;
  if (settings.maxRepliesPerStorm > 0 && storm.replies >= settings.maxRepliesPerStorm) {
    return false;
  }
  if (settings.maxRepliesPerAIPerStorm > 0) {
    const used = storm.perAi.get(agentId) || 0;
    if (used >= settings.maxRepliesPerAIPerStorm) return false;
  }
  return true;
}

function registerStormReply(storm, agentId) {
  if (!storm) return;
  storm.replies += 1;
  storm.perAi.set(agentId, (storm.perAi.get(agentId) || 0) + 1);
  storm.updatedAt = Date.now();
}

function getJudgeLog(storm, depth) {
  if (!storm) return [];
  if (!storm.judgeLog.has(depth)) storm.judgeLog.set(depth, []);
  return storm.judgeLog.get(depth);
}

// 记录一层里已经完成的判断，后面的 AI 判断时会被写进提示词
function recordJudgeOutcome(storm, depth, entry) {
  if (!storm) return;
  getJudgeLog(storm, depth).push(entry);
  storm.updatedAt = Date.now();
}

function acquireAiSlot() {
  if (aiApiInFlight < getAiConcurrencyLimit()) {
    aiApiInFlight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => aiApiWaiters.push(resolve));
}

function releaseAiSlot() {
  const next = aiApiWaiters.shift();
  if (next) {
    next();
    return;
  }
  aiApiInFlight = Math.max(0, aiApiInFlight - 1);
}

function pruneRateWindow(now) {
  const cutoff = now - AI_RATE_WINDOW_MS;
  globalReplyTimestamps = globalReplyTimestamps.filter((ts) => ts > cutoff);
  for (const [aiId, list] of aiReplyTimestamps) {
    const kept = list.filter((ts) => ts > cutoff);
    if (kept.length > 0) aiReplyTimestamps.set(aiId, kept);
    else aiReplyTimestamps.delete(aiId);
  }
}

function checkReplyRate(agent, settings, now) {
  pruneRateWindow(now);
  const perAi = settings.rateLimit.perAiPerMinute;
  if (perAi > 0 && (aiReplyTimestamps.get(agent.id) || []).length >= perAi) return false;
  const total = settings.rateLimit.totalPerMinute;
  if (total > 0 && globalReplyTimestamps.length >= total) return false;
  return true;
}

function recordReplyRate(agent, now) {
  const list = aiReplyTimestamps.get(agent.id) || [];
  list.push(now);
  aiReplyTimestamps.set(agent.id, list);
  globalReplyTimestamps.push(now);
}

function cooldownBlocked(agent, settings, now) {
  if (settings.cooldownMs <= 0) return false;
  const last = aiLastReplyAt.get(agent.id) || 0;
  return now - last < settings.cooldownMs;
}

function judgeSnapshotForAgent(agent, settings) {
  const perAgent = toNonNegativeInt(
    agent && agent.selfDecision && agent.selfDecision.judgeHistoryCount,
    0
  );
  return takeRecentSnapshot(perAgent > 0 ? perAgent : settings.judgeHistoryCount);
}

function replySnapshotForAgent(agent, settings) {
  const own = toNonNegativeInt(agent && agent.historyCount, 0);
  return takeRecentSnapshot(own > 0 ? own : settings.replyHistoryCount);
}

// 判断阶段的记录格式与群成员 AI 看到的保持一致，保证 [日期][时间][名字] 信息完整
function formatJudgeRecord(m) {
  let content = stripAllRecordPrefixes(m.text);
  if (content === null) content = String(m.text || '');
  if (!isFormattedReply(content)) {
    content = formatPromptPrefix(m.time, m.name || '未知用户') + content + '}';
  }
  return content;
}

// 判断提示词：带上同一层前面 AI 已经做出的判断，避免所有人都以为“别人会回”而冷场，
// 也避免有人已经接了话还重复接话。
function buildJudgeMessages(snapshot, agent, priorJudgements) {
  const roster = aiAgents
    .map((a) => (a.id === agent.id ? `${a.name}（你自己）` : a.name))
    .join('、');
  const prior = Array.isArray(priorJudgements) ? priorJudgements : [];
  const priorText =
    prior.length > 0
      ? prior
          .map(
            (item) =>
              `- ${item.name}：${
                item.reply === true
                  ? '决定回复'
                  : item.reply === false
                    ? '不回复'
                    : '判断失败'
              }${item.reason ? `（${item.reason}）` : ''}`
          )
          .join('\n')
      : '（目前还没有人决定回复）';
  const system = [
    `你是群聊成员「${agent.name}」。现在只做一件事：判断你是否需要回复群聊里的最新一条消息，不要生成回复内容。`,
    `【群成员】${roster}`,
    `【本层已有判断】\n${priorText}`,
    '【判断标准】',
    '1. 被点名 @ 到你，必须回复。',
    '2. 话题与你的设定、专长或职责相关，或者你能补充有价值的信息，应该回复。',
    '3. 别人已经回答得足够好、只是闲聊、或与你无关，就不要回复。',
    '4. 不要为了刷存在感而回复，也不要重复别人已经说过的内容。',
    '5. 避免冷场：如果目前还没有任何成员决定回复，而这条消息确实值得有人接话，你应该回复，不要假设别人会回。',
    '6. 避免重复：如果已经有成员决定回复，只有你能补充不同视角或更准确的信息时才回复。',
    '【输出要求】只输出一个 JSON 对象，不要代码块、不要解释：{"reply":true,"reason":"一句话理由"}。',
  ].join('\n');
  const messages = [{ role: 'system', content: system }];
  for (const m of snapshot) {
    messages.push({ role: 'user', content: formatJudgeRecord(m) });
  }
  return messages;
}

function parseBooleanFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1', '是', '回', '回复', '要回', '需要回复', '应该回复'].includes(v)) {
      return true;
    }
    if (
      ['false', 'no', 'n', '0', '否', '不回', '不回复', '不需要回复', '不该回复', '沉默'].includes(v)
    ) {
      return false;
    }
  }
  return null;
}

function pickFirstField(obj, keys) {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

// 解析判断结果：decided=false 表示无法解析，调用方按“判断失败”回退随机回复
function parseSelfJudgement(rawReply) {
  const cleaned = String(rawReply || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const result = { decided: false, reply: false, reason: '' };
  let value = null;
  try {
    value = JSON.parse(cleaned);
  } catch (_err) {
    value = null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const flag = pickFirstField(value, [
      'reply',
      'shouldReply',
      'should_reply',
      'respond',
      'needReply',
      'need_reply',
      'answer',
      'speak',
      'talk',
    ]);
    const parsed = parseBooleanFlag(flag);
    if (parsed !== null) {
      result.decided = true;
      result.reply = parsed;
      result.reason = String(
        pickFirstField(value, ['reason', 'why', 'note', 'comment']) || ''
      ).trim();
      return result;
    }
  }
  // 非 JSON 时只接受“整段就是一个是/否词”的极简回复，避免把含“是”的普通句子误判成回复
  const compact = cleaned.replace(/[\s"'`。！？!?，,.]/g, '').toLowerCase();
  const yesWords = ['true', 'yes', 'y', '1', '是', '回', '回复', '要回', '需要回复', '应该回复'];
  const noWords = ['false', 'no', 'n', '0', '否', '不回', '不回复', '不需要回复', '不该回复', '沉默', '无需回复'];
  if (noWords.includes(compact)) {
    result.decided = true;
    result.reply = false;
  } else if (yesWords.includes(compact)) {
    result.decided = true;
    result.reply = true;
  }
  return result;
}

// 判断阶段可以单独用一个更便宜/更快的模型：
// - 配在 chat.selfDecision 下作为全局默认
// - 配在单个 AI 的 selfDecision 下覆盖全局
// - 留空则沿用该 AI 自己的接口、密钥与模型
function judgeOverride(agent, key) {
  const chatBase = (config.chat && config.chat.selfDecision) || {};
  const perAgent = (agent && agent.selfDecision) || {};
  for (const source of [perAgent, chatBase]) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    return value;
  }
  return undefined;
}

function resolveJudgeEndpoint(agent) {
  const apiBaseUrl = judgeOverride(agent, 'apiBaseUrl');
  const apiKey = judgeOverride(agent, 'apiKey');
  const model = judgeOverride(agent, 'model');
  const temperature = Number(judgeOverride(agent, 'temperature'));
  const maxTokens = Number(judgeOverride(agent, 'maxTokens'));
  const timeoutMs = Number(judgeOverride(agent, 'timeoutMs'));
  const thinking = judgeOverride(agent, 'thinking');
  return {
    apiBaseUrl: String(apiBaseUrl || agent.apiBaseUrl || '')
      .trim()
      .replace(/\/+$/, ''),
    apiKey: String(apiKey || agent.apiKey || '').trim(),
    model: String(model || agent.model || '').trim(),
    temperature: Number.isFinite(temperature) ? temperature : 0.1,
    maxTokens: Math.max(1, maxTokens || 64),
    timeoutMs: Math.max(1000, timeoutMs || Number(agent.timeoutMs) || 30000),
    thinking: thinking || agent.thinking || {},
  };
}

async function requestSelfJudgement(agent, snapshot, priorJudgements) {
  const endpoint = resolveJudgeEndpoint(agent);
  if (
    !isUsableBaseUrl(endpoint.apiBaseUrl) ||
    !isUsableApiKey(endpoint.apiKey) ||
    !endpoint.model
  ) {
    throw new Error('判断模型未配置完整');
  }
  const body = {
    model: endpoint.model,
    messages: buildJudgeMessages(snapshot, agent, priorJudgements),
    stream: false,
    temperature: endpoint.temperature,
    max_tokens: endpoint.maxTokens,
  };
  const thinking = endpoint.thinking || {};
  if (
    thinking.enabled &&
    thinking.sendEffort &&
    ['low', 'medium', 'high'].includes(thinking.effort)
  ) {
    body.reasoning_effort = thinking.effort;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  try {
    const res = await fetch(`${endpoint.apiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      let detail = '';
      try {
        detail = await res.text();
        const parsed = JSON.parse(detail);
        detail = (parsed.error && (parsed.error.message || parsed.error.code)) || detail;
      } catch (_err) {
        // 保留原始文本
      }
      throw new Error(`判断接口返回 HTTP ${res.status}：${String(detail).slice(0, 200)}`);
    }
    const payload = await res.json();
    const content =
      (payload.choices &&
        payload.choices[0] &&
        payload.choices[0].message &&
        payload.choices[0].message.content) ||
      '';
    if (!String(content).trim()) throw new Error('判断接口返回内容为空');
    return { raw: String(content), parsed: parseSelfJudgement(content) };
  } finally {
    clearTimeout(timer);
  }
}

// 判断失败（网络错误 / 空返回 / 无法解析）时回退随机回复，同一风暴同一层只兜底一次
function fallbackRandomReply(storm, depth, settings) {
  const ready = aiAgents.filter((agent) => aiIsConfigured(agent));
  if (ready.length === 0) return;
  const level = depth || 0;
  if (storm) {
    const key = `fallback:${level}`;
    if (storm.judged.has(key)) return;
    storm.judged.add(key);
  }
  const pool = ready.filter((agent) => {
    if (storm && storm.silent.has(`${agent.id}:${level}`)) return false;
    return !storm || stormAllowsReply(storm, agent.id, getSelfDecisionSettings(agent));
  });
  if (pool.length === 0) return;
  const agent = pool.length === 1 ? pool[0] : pool[crypto.randomInt(pool.length)];
  if (settings && settings.debug) {
    console.warn(`[AI 自我判断] 判断失败，回退随机回复：${agent.name}`);
  }
  enqueueStormGeneration(storm, agent, level, 'fallback', storm ? storm.id : undefined);
}

async function judgeAndMaybeReply(agent, depth, stormId) {
  const settings = getSelfDecisionSettings(agent);
  if (!settings.enabled) return;
  const storm = stormId ? aiStorms.get(stormId) : null;
  const level = depth || 0;
  if (storm && !stormAllowsReply(storm, agent.id, settings)) {
    console.log(`[AI 自我判断] ${agent.name} 跳过：本轮风暴回复额度已用完，不再发起判断`);
    return;
  }
  // 同一层随机顺序串行判断：这里能看到排在前面的 AI 已经做出的判断
  const priorJudgements = storm ? getJudgeLog(storm, level).slice() : [];

  let judgement = null;
  let failure = null;
  await acquireAiSlot();
  try {
    judgement = await requestSelfJudgement(
      agent,
      judgeSnapshotForAgent(agent, settings),
      priorJudgements
    );
  } catch (err) {
    failure = err;
  } finally {
    releaseAiSlot();
  }

  if (!judgement) {
    console.warn(
      `[AI 自我判断] ${agent.name} 判断失败，回退随机回复：${
        failure && failure.message ? failure.message : failure
      }`
    );
    recordJudgeOutcome(storm, level, {
      aiId: agent.id,
      name: agent.name,
      reply: null,
      reason: '判断失败，已回退随机回复',
    });
    fallbackRandomReply(storm, level, settings);
    return;
  }

  const parsed = judgement.parsed;
  if (parsed.decided && parsed.reply === false) {
    if (storm) storm.silent.add(`${agent.id}:${level}`);
    recordJudgeOutcome(storm, level, {
      aiId: agent.id,
      name: agent.name,
      reply: false,
      reason: parsed.reason,
    });
    if (settings.debug) {
      console.log(
        `[AI 自我判断] ${agent.name} → 不回复${parsed.reason ? `（${parsed.reason}）` : ''}`
      );
    }
    return;
  }
  if (parsed.decided && parsed.reply === true) {
    recordJudgeOutcome(storm, level, {
      aiId: agent.id,
      name: agent.name,
      reply: true,
      reason: parsed.reason,
    });
    if (settings.debug) {
      console.log(
        `[AI 自我判断] ${agent.name} → 回复${parsed.reason ? `（${parsed.reason}）` : ''}`
      );
    }
    enqueueStormGeneration(storm, agent, level, 'self', stormId);
    return;
  }

  console.warn(
    `[AI 自我判断] ${agent.name} 判断结果无法解析，回退随机回复：${judgement.raw.slice(0, 120)}`
  );
  recordJudgeOutcome(storm, level, {
    aiId: agent.id,
    name: agent.name,
    reply: null,
    reason: '判断结果无法解析，已回退随机回复',
  });
  fallbackRandomReply(storm, level, settings);
}

function enqueueSelfJudgement(agent, depth, stormId) {
  const settings = getSelfDecisionSettings(agent);
  if (!settings.enabled) return null;
  const storm = stormId ? aiStorms.get(stormId) : null;
  const level = depth || 0;
  const run = () =>
    judgeAndMaybeReply(agent, level, stormId).catch((err) => {
      console.error('[AI 自我判断失败]', err && err.message ? err.message : err);
    });
  if (!storm) return run();
  // 同一风暴同一层的判断按入队顺序串行执行（调用方已随机排序），
  // 这样后面的 AI 判断时能看到前面 AI 的判断结果，减少“都以为别人会回”的冷场
  const previous = storm.judgeChains.get(level) || Promise.resolve();
  const chained = previous.then(run, run);
  storm.judgeChains.set(
    level,
    chained.then(
      () => {},
      () => {}
    )
  );
  return chained;
}

// 同一风暴内的生成串行排队：后面的 AI 能在快照里看到前面 AI 已经发出的回复
function enqueueStormGeneration(storm, agent, depth, triggerKind, stormId) {
  if (!storm) return enqueueAIReply(agent, depth, triggerKind, stormId);
  const run = () => enqueueAIReply(agent, depth, triggerKind, stormId);
  const task = storm.genChain.then(run, run);
  storm.genChain = task.then(
    () => {},
    () => {}
  );
  storm.updatedAt = Date.now();
  return task;
}

// 群消息触发规则：
// - self 模式：普通消息由每个 AI 自己判断是否回复；被 @ 的 AI 直接回复，
//   其他 AI 默认不参与判断（othersJudgeOnMention）；整体受风暴预算 / 冷却 / 频率限制
// - hybrid 模式：普通消息随机选一位 AI；@ 到谁谁回复，保持旧行为
function triggerAIForUserMessage(text, messageId) {
  if (aiAgents.length === 0) return;
  const chatOptions = config.chat || {};
  const mode = getReplyMode();
  if (mode === 'off') return;

  const everyone = isEveryoneMention(text);
  const mentionedIds = extractMentionedAgentIds(text);
  const ready = aiAgents.filter((agent) => aiIsConfigured(agent));
  if (ready.length === 0) {
    if (aiAgents.length > 0) notifyAIUnconfigured();
    return;
  }

  if (mode === 'self') {
    const settings = getSelfDecisionSettings(null);
    const stormId = messageId != null ? `user-${messageId}` : `user-${Date.now()}`;
    const storm = createStorm(stormId, messageId);

    if (everyone) {
      for (const agent of shuffleAgents(ready)) {
        reserveStormDecision(storm, agent.id, 0);
        enqueueStormGeneration(storm, agent, 0, 'everyone', stormId);
      }
      return;
    }

    if (mentionedIds.size > 0) {
      const named = ready.filter((agent) => mentionedIds.has(agent.id));
      for (const agent of named) {
        if (!reserveStormDecision(storm, agent.id, 0)) continue;
        if (settings.forceReplyOnMention) {
          recordJudgeOutcome(storm, 0, {
            aiId: agent.id,
            name: agent.name,
            reply: true,
            reason: '被点名，直接回复',
          });
          enqueueStormGeneration(storm, agent, 0, 'mention', stormId);
        } else {
          enqueueSelfJudgement(agent, 0, stormId);
        }
      }
      if (settings.othersJudgeOnMention) {
        for (const agent of shuffleAgents(ready)) {
          if (mentionedIds.has(agent.id)) continue;
          if (!getSelfDecisionSettings(agent).enabled) continue;
          if (!reserveStormDecision(storm, agent.id, 0)) continue;
          enqueueSelfJudgement(agent, 0, stormId);
        }
      }
      return;
    }

    if (hasHumanMention(text) && chatOptions.silentOnHumanOnlyMention !== false) return;
    if (!settings.enabled) return;

    // 随机排序后依次判断：后面的 AI 能看到前面 AI 的判断结果，避免都判断为不回复而冷场
    for (const agent of shuffleAgents(ready)) {
      if (!getSelfDecisionSettings(agent).enabled) continue;
      if (!reserveStormDecision(storm, agent.id, 0)) continue;
      enqueueSelfJudgement(agent, 0, stormId);
    }
    return;
  }

  let targets = [];
  if (everyone) {
    targets = aiAgents;
  } else if (mentionedIds.size > 0) {
    targets = aiAgents.filter((a) => mentionedIds.has(a.id));
  } else if (hasHumanMention(text) && chatOptions.silentOnHumanOnlyMention !== false) {
    return; // 只 @ 人类 → AI 保持沉默
  } else {
    const randomAgent = pickRandomAgent(ready);
    if (randomAgent) targets = [randomAgent];
    else notifyAIUnconfigured();
  }

  const readyTargets = targets.filter((agent) => aiIsConfigured(agent));
  if (readyTargets.length === 0) {
    if (targets.length > 0) notifyAIUnconfigured();
    return;
  }

  // 用户消息触发 @所有人 时以消息 id 作为风暴根，后续 AI 互 @ 沿用同一风暴
  const stormId = everyone && messageId != null ? `user-${messageId}` : undefined;
  const replyTargets = everyone ? shuffleAgents(readyTargets) : readyTargets;
  for (const agent of replyTargets) {
    enqueueAIReply(agent, 0, everyone ? 'everyone' : '', stormId);
  }
}

function getPresenceList() {
  return (config.users || [])
    .filter((u) => (presenceCounts.get(u.username) || 0) > 0)
    .map((u) => ({ username: u.username, avatar: u.avatar || '' }));
}

function isSessionValid(sid) {
  if (!sid) return false;
  const session = sessions.get(sid);
  if (!session) return false;
  if (Date.now() - session.createdAt >= sessionMaxAgeMs) {
    sessions.delete(sid);
    return false;
  }
  const user = findByUsername(session.username);
  if (!user) {
    sessions.delete(sid);
    return false;
  }
  return true;
}

function isSSEClientDead(client) {
  return (
    client.res.writableEnded ||
    client.res.destroyed ||
    !client.socket ||
    client.socket.destroyed
  );
}

// 逐条排空客户端队列；write() 返回 false 表示内核缓冲已满，
// 等待 drain 事件后再继续，避免无限制往慢客户端里塞数据。
function pumpSSEClient(client) {
  if (client.draining) return;
  for (;;) {
    if (isSSEClientDead(client)) {
      removeSSEClient(client);
      return;
    }
    if (!isSessionValid(client.sid)) {
      dropSSEClient(client);
      return;
    }
    if (client.queue.length === 0) return;

    const payload = client.queue.shift();
    client.queueBytes -= Buffer.byteLength(payload);
    let flushed = true;
    try {
      flushed = client.res.write(payload);
    } catch (_err) {
      removeSSEClient(client);
      return;
    }
    if (!flushed) {
      client.draining = true;
      client.res.once('drain', () => {
        client.draining = false;
        pumpSSEClient(client);
      });
      return;
    }
  }
}

function dropSSEClient(client) {
  removeSSEClient(client);
  try {
    client.res.destroy();
  } catch (_err) {
    /* ignore */
  }
}

function enqueueSSEPayload(client, payload, options) {
  if (isSSEClientDead(client)) {
    removeSSEClient(client);
    return false;
  }
  if (!isSessionValid(client.sid)) {
    dropSSEClient(client);
    return false;
  }
  // 心跳是可丢的：积压时不再追加，避免占满队列
  if (options && options.dropWhenBackpressured && client.draining) return false;
  client.queue.push(payload);
  client.queueBytes += Buffer.byteLength(payload);
  // 先尝试立即写出；只有真正排不出去、积压超过上限时才断开
  pumpSSEClient(client);
  if (client.queueBytes > SSE_MAX_QUEUE_BYTES) {
    console.warn('[SSE] 客户端消费过慢，断开连接等待自动重连');
    dropSSEClient(client);
    return false;
  }
  return true;
}

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    enqueueSSEPayload(client, payload);
  }
}

function refreshPresence() {
  const list = getPresenceList();
  const key = list.map((u) => u.username).join('\u0000');
  if (key === lastPresenceKey) return false;
  lastPresenceKey = key;
  broadcastSSE('presence', { list });
  return true;
}

function removeSSEClient(client) {
  if (!sseClients.has(client)) return;
  sseClients.delete(client);
  client.queue = [];
  client.queueBytes = 0;
  client.draining = false;
  const remain = (presenceCounts.get(client.username) || 0) - 1;
  if (remain <= 0) presenceCounts.delete(client.username);
  else presenceCounts.set(client.username, remain);
  refreshPresence();
}

// 周期性校正：清理已断开但事件没触发的僵尸连接，并重算在线列表
function syncPresenceFromClients() {
  const staleClients = [];
  for (const client of sseClients) {
    if (isSSEClientDead(client) || !isSessionValid(client.sid)) {
      staleClients.push(client);
    }
  }
  for (const client of staleClients) {
    dropSSEClient(client);
  }

  presenceCounts.clear();
  for (const client of sseClients) {
    presenceCounts.set(client.username, (presenceCounts.get(client.username) || 0) + 1);
  }
  refreshPresence();
}

// SSE 长连接：登录后浏览器通过 EventSource 连到这里收消息
function handleEvents(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { ok: false, message: '未登录' });
    return;
  }

  applySecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const sid = parseCookies(req)[SESSION_COOKIE];
  const client = {
    res,
    socket: req.socket,
    username: user.username,
    sid,
    queue: [],
    queueBytes: 0,
    draining: false,
  };
  sseClients.add(client);
  presenceCounts.set(user.username, (presenceCounts.get(user.username) || 0) + 1);

  // 先发一次完整快照（历史消息 + 当前在线列表 + 当前用户）
  const snapshot = {
    history: recentToday(),
    presence: getPresenceList(),
    me: {
      username: user.username,
      avatar: user.avatar || '',
      role: String(user.role || 'user'),
    },
  };
  enqueueSSEPayload(client, 'retry: 3000\n\n');
  enqueueSSEPayload(client, `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);

  refreshPresence();

  const onClose = () => removeSSEClient(client);
  res.on('close', onClose);
  res.on('error', onClose);
  if (req.socket) req.socket.on('close', onClose);
}

function getSessionUser(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!isSessionValid(sid)) return null;
  return findByUsername(sessions.get(sid).username);
}

// Secure 只在真正走 HTTPS 时附加（直接 TLS 或反代透传 X-Forwarded-Proto），
// 避免本机纯 HTTP 调试时浏览器拒绝保存登录 cookie。
function isSecureCookieRequest(req) {
  if (req && req.socket && req.socket.encrypted) return true;
  const forwardedProto = String(
    (req && req.headers && req.headers['x-forwarded-proto']) || ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwardedProto === 'https';
}

function setSessionCookie(req, res, sid) {
  const maxAgeSec = Math.max(1, Math.floor(sessionMaxAgeMs / 1000));
  const secure = isSecureCookieRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`
  );
}

function clearSessionCookie(req, res) {
  const secure = isSecureCookieRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

// ---------------- HTTP 响应 ----------------

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const STATIC_MAX_AGE_SECONDS = 300;

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
}

function applyNoStore(res) {
  res.setHeader('Cache-Control', 'no-store');
}

function applyPageHeaders(res) {
  applySecurityHeaders(res);
  applyNoStore(res);
  res.setHeader('Content-Security-Policy', PAGE_CSP);
}

function applyStaticCacheHeaders(res) {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', `public, max-age=${STATIC_MAX_AGE_SECONDS}`);
}

function applyStaticSvgHeaders(res) {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', `public, max-age=${STATIC_MAX_AGE_SECONDS}`);
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'"
  );
}

function sendJson(res, status, data) {
  applySecurityHeaders(res);
  applyNoStore(res);
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  applySecurityHeaders(res);
  applyNoStore(res);
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function redirect(res, location) {
  applySecurityHeaders(res);
  applyNoStore(res);
  res.writeHead(302, { Location: location });
  res.end();
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, '404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') applyPageHeaders(res);
    else if (ext === '.svg') applyStaticSvgHeaders(res);
    else applyStaticCacheHeaders(res);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function readJsonBody(req, limitBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_err) {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------- 设置（admin + 配置覆盖层） ----------------

// 这些字段改了需要重启进程才会真正生效，保存时会明确提示
const SETTINGS_RESTART_FIELDS = [
  ['port', 'port'],
  ['host', 'host'],
  ['chat.storageDir', 'chat.storageDir'],
  ['chat.storageFile', 'chat.storageFile'],
  ['memory.storageDir', 'memory.storageDir'],
];

function getByPath(obj, pathStr) {
  return String(pathStr)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function isAdminUser(user) {
  return !!user && String(user.role || '').trim().toLowerCase() === 'admin';
}

// 仅返回 admin 用户；未登录或非 admin 返回 null
function getAdminUser(req) {
  const user = getSessionUser(req);
  return user && isAdminUser(user) ? user : null;
}

function buildRoomInfo() {
  return {
    title: 'AI 群聊',
    everyoneKeywords: getEveryoneKeywords(),
    ais: aiAgents.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar })),
    ai: aiAgents[0]
      ? { enabled: true, name: aiAgents[0].name, avatar: aiAgents[0].avatar }
      : { enabled: false, name: '', avatar: '' },
  };
}

// 写操作要求同源：优先看浏览器的 Sec-Fetch-Site，其次比对 Origin/Referer 的主机
function isSameOriginRequest(req) {
  const headers = (req && req.headers) || {};
  const fetchSite = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite === 'same-origin' || fetchSite === 'none') return true;
  const host = String(headers.host || '').toLowerCase();
  if (!host) return false;
  const source = headers.origin || headers.referer || '';
  if (!source) return false;
  try {
    return new URL(String(source)).host.toLowerCase() === host;
  } catch (_err) {
    return false;
  }
}

function changedRestartFields(prev, next) {
  const changed = [];
  for (const [pathStr, label] of SETTINGS_RESTART_FIELDS) {
    if (JSON.stringify(getByPath(prev, pathStr)) !== JSON.stringify(getByPath(next, pathStr))) {
      changed.push(label);
    }
  }
  return changed;
}

// 把界面/导入来的值归一成期望类型，避免 "3000" 这类字符串直接落进运行时
function normalizeSettings(raw) {
  const cfg = deepClone(isPlainObject(raw) ? raw : {});
  const num = (obj, key) => {
    if (!isPlainObject(obj) || obj[key] === undefined || obj[key] === null || obj[key] === '') return;
    const n = Number(obj[key]);
    if (Number.isFinite(n)) obj[key] = n;
  };
  const bool = (obj, key) => {
    if (!isPlainObject(obj) || obj[key] === undefined) return;
    if (typeof obj[key] === 'string') {
      const text = obj[key].trim().toLowerCase();
      if (text === 'true') obj[key] = true;
      else if (text === 'false') obj[key] = false;
    } else if (obj[key] === 0) {
      obj[key] = false;
    } else if (obj[key] === 1) {
      obj[key] = true;
    }
  };
  const str = (obj, key) => {
    if (!isPlainObject(obj) || obj[key] === undefined) return;
    if (obj[key] === null) obj[key] = '';
    else if (typeof obj[key] !== 'string') obj[key] = String(obj[key]);
  };
  const normalizeThinking = (thinking) => {
    if (!isPlainObject(thinking)) return;
    bool(thinking, 'enabled');
    bool(thinking, 'sendEffort');
    str(thinking, 'effort');
  };
  const normalizeSelfDecision = (sd) => {
    if (!isPlainObject(sd)) return;
    for (const key of ['enabled', 'forceReplyOnMention', 'othersJudgeOnMention', 'debug']) bool(sd, key);
    for (const key of [
      'judgeHistoryCount',
      'replyHistoryCount',
      'maxHops',
      'maxRepliesPerStorm',
      'maxRepliesPerAIPerStorm',
      'cooldownMs',
      'globalConcurrency',
      'temperature',
      'maxTokens',
      'timeoutMs',
    ]) {
      num(sd, key);
    }
    for (const key of ['model', 'apiBaseUrl', 'apiKey']) str(sd, key);
    normalizeThinking(sd.thinking);
    if (isPlainObject(sd.rateLimit)) {
      num(sd.rateLimit, 'perAiPerMinute');
      num(sd.rateLimit, 'totalPerMinute');
    }
  };

  num(cfg, 'port');
  num(cfg, 'sessionDays');
  bool(cfg, 'trustProxy');

  if (Array.isArray(cfg.users)) {
    for (const user of cfg.users) {
      if (!isPlainObject(user)) continue;
      str(user, 'username');
      str(user, 'avatar');
      if (user.password !== undefined && user.password !== null && typeof user.password !== 'string') {
        user.password = String(user.password);
      }
      if (user.role !== undefined) user.role = String(user.role).trim().toLowerCase();
    }
  }

  if (Array.isArray(cfg.ais)) {
    for (const ai of cfg.ais) {
      if (!isPlainObject(ai)) continue;
      for (const key of ['enabled', 'prefixAiReplies', 'streamReply']) bool(ai, key);
      for (const key of ['historyCount', 'contextHours', 'temperature', 'maxTokens', 'timeoutMs']) num(ai, key);
      for (const key of ['id', 'name', 'avatar', 'persona', 'apiBaseUrl', 'apiKey', 'model']) str(ai, key);
      normalizeThinking(ai.thinking);
      normalizeSelfDecision(ai.selfDecision);
    }
  }

  if (isPlainObject(cfg.chat)) {
    if (cfg.chat.aiReplyMode !== undefined) {
      cfg.chat.aiReplyMode = String(cfg.chat.aiReplyMode).trim().toLowerCase();
    }
    for (const key of ['silentOnHumanOnlyMention', 'aiReplyOnAIMention']) bool(cfg.chat, key);
    for (const key of ['aiMentionMaxHops', 'everyoneMaxHops', 'displayHours']) num(cfg.chat, key);
    if (Array.isArray(cfg.chat.everyoneKeywords)) {
      cfg.chat.everyoneKeywords = cfg.chat.everyoneKeywords.map((k) => String(k == null ? '' : k));
    }
    for (const key of ['storageDir', 'storageFile']) str(cfg.chat, key);
    normalizeSelfDecision(cfg.chat.selfDecision);
  }

  if (isPlainObject(cfg.memory)) {
    for (const key of ['enabled', 'debug', 'backfillOnStartup']) bool(cfg.memory, key);
    for (const key of ['temperature', 'maxTokens', 'timeoutMs', 'maxInputChars']) num(cfg.memory, key);
    for (const key of ['apiBaseUrl', 'model', 'apiKey', 'storageDir']) str(cfg.memory, key);
    normalizeThinking(cfg.memory.thinking);
    if (isPlainObject(cfg.memory.budgets)) {
      for (const key of ['daily', 'weekly', 'monthly', 'quarter', 'year']) num(cfg.memory.budgets, key);
    }
  }
  return cfg;
}

function validateThinking(thinking, label, errors, numeric, boolean) {
  if (thinking === undefined) return;
  if (!isPlainObject(thinking)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  if (thinking.enabled !== undefined) boolean(thinking.enabled, `${label}.enabled`);
  if (thinking.sendEffort !== undefined) boolean(thinking.sendEffort, `${label}.sendEffort`);
  if (thinking.effort !== undefined && !['low', 'medium', 'high'].includes(String(thinking.effort))) {
    errors.push(`${label}.effort 只能是 low / medium / high`);
  }
}

function validateSelfDecision(sd, label, errors, numeric, boolean) {
  if (sd === undefined) return;
  if (!isPlainObject(sd)) {
    errors.push(`${label} 必须是对象`);
    return;
  }
  for (const key of ['enabled', 'forceReplyOnMention', 'othersJudgeOnMention', 'debug']) {
    if (sd[key] !== undefined) boolean(sd[key], `${label}.${key}`);
  }
  if (sd.judgeHistoryCount !== undefined) {
    numeric(sd.judgeHistoryCount, `${label}.judgeHistoryCount`, { integer: true, min: 1 });
  }
  if (sd.replyHistoryCount !== undefined) {
    numeric(sd.replyHistoryCount, `${label}.replyHistoryCount`, { integer: true, min: 1 });
  }
  for (const key of ['maxHops', 'maxRepliesPerStorm', 'maxRepliesPerAIPerStorm', 'cooldownMs']) {
    if (sd[key] !== undefined) numeric(sd[key], `${label}.${key}`, { integer: true, min: 0 });
  }
  if (sd.globalConcurrency !== undefined) {
    numeric(sd.globalConcurrency, `${label}.globalConcurrency`, { integer: true, min: 1 });
  }
  if (sd.temperature !== undefined) numeric(sd.temperature, `${label}.temperature`, { min: 0, max: 2 });
  if (sd.maxTokens !== undefined) numeric(sd.maxTokens, `${label}.maxTokens`, { integer: true, min: 1 });
  if (sd.timeoutMs !== undefined) numeric(sd.timeoutMs, `${label}.timeoutMs`, { integer: true, min: 1000 });
  validateThinking(sd.thinking, `${label}.thinking`, errors, numeric, boolean);
  if (sd.rateLimit !== undefined) {
    if (!isPlainObject(sd.rateLimit)) {
      errors.push(`${label}.rateLimit 必须是对象`);
    } else {
      for (const key of ['perAiPerMinute', 'totalPerMinute']) {
        if (sd.rateLimit[key] !== undefined) {
          numeric(sd.rateLimit[key], `${label}.rateLimit.${key}`, { integer: true, min: 0 });
        }
      }
    }
  }
}

function validateSettings(cfg) {
  const errors = [];
  const numeric = (value, label, opts = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      errors.push(`${label} 必须是数字`);
      return;
    }
    if (opts.integer && !Number.isInteger(n)) errors.push(`${label} 必须是整数`);
    if (opts.min !== undefined && n < opts.min) errors.push(`${label} 不能小于 ${opts.min}`);
    if (opts.max !== undefined && n > opts.max) errors.push(`${label} 不能大于 ${opts.max}`);
  };
  const boolean = (value, label) => {
    if (typeof value !== 'boolean') errors.push(`${label} 必须是布尔值`);
  };

  numeric(cfg.port, 'port', { integer: true, min: 1, max: 65535 });
  if (!String(cfg.host == null ? '' : cfg.host).trim()) errors.push('host 不能为空');
  numeric(cfg.sessionDays, 'sessionDays', { min: 0.0001 });
  if (cfg.trustProxy !== undefined) boolean(cfg.trustProxy, 'trustProxy');

  if (!Array.isArray(cfg.users) || cfg.users.length === 0) {
    errors.push('至少需要一个登录账号');
  } else {
    const names = new Set();
    let admins = 0;
    cfg.users.forEach((user, index) => {
      const label = `users[${index}]`;
      if (!isPlainObject(user)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      const username = String(user.username == null ? '' : user.username).trim();
      if (!username) errors.push(`${label}.username 不能为空`);
      else if (names.has(username)) errors.push(`账号名重复：${username}`);
      else names.add(username);
      if (user.password === undefined || String(user.password) === '') {
        errors.push(`${label}.password 不能为空`);
      }
      const role = String(user.role == null ? 'user' : user.role).trim().toLowerCase();
      if (role !== 'admin' && role !== 'user') errors.push(`${label}.role 只能是 admin 或 user`);
      if (role === 'admin') admins += 1;
    });
    if (admins === 0) errors.push('至少需要保留一个 admin 账号，否则将无法进入设置');
  }

  if (cfg.ais !== undefined && !Array.isArray(cfg.ais)) errors.push('ais 必须是数组');
  if (Array.isArray(cfg.ais)) {
    const ids = new Set();
    cfg.ais.forEach((ai, index) => {
      const label = `ais[${index}]`;
      if (!isPlainObject(ai)) {
        errors.push(`${label} 必须是对象`);
        return;
      }
      if (!String(ai.name == null ? '' : ai.name).trim()) errors.push(`${label}.name 不能为空`);
      const id = String(ai.id == null ? '' : ai.id).trim();
      if (id) {
        if (ids.has(id)) errors.push(`AI id 重复：${id}`);
        else ids.add(id);
      }
      if (ai.enabled !== undefined) boolean(ai.enabled, `${label}.enabled`);
      if (ai.historyCount !== undefined) numeric(ai.historyCount, `${label}.historyCount`, { integer: true, min: 1 });
      if (ai.temperature !== undefined) numeric(ai.temperature, `${label}.temperature`, { min: 0, max: 2 });
      if (ai.maxTokens !== undefined) numeric(ai.maxTokens, `${label}.maxTokens`, { integer: true, min: 1 });
      if (ai.timeoutMs !== undefined) numeric(ai.timeoutMs, `${label}.timeoutMs`, { integer: true, min: 1000 });
      for (const key of ['prefixAiReplies', 'streamReply']) {
        if (ai[key] !== undefined) boolean(ai[key], `${label}.${key}`);
      }
      validateThinking(ai.thinking, `${label}.thinking`, errors, numeric, boolean);
      validateSelfDecision(ai.selfDecision, `${label}.selfDecision`, errors, numeric, boolean);
    });
  }

  if (!isPlainObject(cfg.chat)) {
    errors.push('chat 必须是对象');
  } else {
    const mode = String(cfg.chat.aiReplyMode || '').trim().toLowerCase();
    if (!['self', 'hybrid', 'off', 'router'].includes(mode)) {
      errors.push('chat.aiReplyMode 只能是 self / hybrid / off');
    }
    for (const key of ['silentOnHumanOnlyMention', 'aiReplyOnAIMention']) {
      if (cfg.chat[key] !== undefined) boolean(cfg.chat[key], `chat.${key}`);
    }
    for (const key of ['aiMentionMaxHops', 'everyoneMaxHops']) {
      if (cfg.chat[key] !== undefined) numeric(cfg.chat[key], `chat.${key}`, { integer: true, min: 0 });
    }
    if (cfg.chat.everyoneKeywords !== undefined) {
      if (!Array.isArray(cfg.chat.everyoneKeywords)) {
        errors.push('chat.everyoneKeywords 必须是数组');
      } else if (cfg.chat.everyoneKeywords.every((k) => !String(k || '').trim())) {
        errors.push('chat.everyoneKeywords 至少要有一个非空关键词');
      }
    }
    validateSelfDecision(cfg.chat.selfDecision, 'chat.selfDecision', errors, numeric, boolean);
  }

  if (cfg.memory !== undefined && !isPlainObject(cfg.memory)) {
    errors.push('memory 必须是对象');
  } else if (isPlainObject(cfg.memory)) {
    for (const key of ['enabled', 'debug', 'backfillOnStartup']) {
      if (cfg.memory[key] !== undefined) boolean(cfg.memory[key], `memory.${key}`);
    }
    for (const key of ['temperature', 'maxTokens', 'timeoutMs', 'maxInputChars']) {
      if (cfg.memory[key] !== undefined) numeric(cfg.memory[key], `memory.${key}`, { min: 0 });
    }
    if (isPlainObject(cfg.memory.budgets)) {
      for (const key of ['daily', 'weekly', 'monthly', 'quarter', 'year']) {
        if (cfg.memory.budgets[key] !== undefined) {
          numeric(cfg.memory.budgets[key], `memory.budgets.${key}`, { integer: true, min: 1 });
        }
      }
    }
    validateThinking(cfg.memory.thinking, 'memory.thinking', errors, numeric, boolean);
  }

  return { ok: errors.length === 0, errors };
}

function backupSettingsFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak-${Date.now()}`);
    const dir = path.dirname(SETTINGS_FILE);
    const prefix = `${path.basename(SETTINGS_FILE)}.bak-`;
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort();
    while (backups.length > 5) {
      const name = backups.shift();
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch (_err) {
        /* ignore */
      }
    }
  } catch (err) {
    console.warn('[设置] 备份旧配置失败：', err && err.message ? err.message : err);
  }
}

function writeSettingsOverrideFile(override) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(override, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

// 删除账号 / 改密码 / 取消 admin 时，需要让该账号已有登录态失效
function collectForcedLogouts(prevUsers, nextUsers) {
  const toMap = (list) =>
    new Map((Array.isArray(list) ? list : []).map((u) => [String(u && u.username), u]));
  const prev = toMap(prevUsers);
  const next = toMap(nextUsers);
  const out = [];
  for (const [name, before] of prev) {
    if (!name) continue;
    const after = next.get(name);
    if (!after) {
      out.push(name);
      continue;
    }
    if (String(before.password) !== String(after.password)) {
      out.push(name);
      continue;
    }
    const wasAdmin = String(before.role || 'user').toLowerCase() === 'admin';
    const nowAdmin = String(after.role || 'user').toLowerCase() === 'admin';
    if (wasAdmin && !nowAdmin) out.push(name);
  }
  return out;
}

function forceLogoutUsers(usernames) {
  const set = new Set(usernames);
  if (set.size === 0) return;
  for (const [sid, session] of Array.from(sessions)) {
    if (set.has(session.username)) sessions.delete(sid);
  }
  for (const client of Array.from(sseClients)) {
    if (set.has(client.username)) dropSSEClient(client);
  }
}

// 应用新配置：重建派生值并通知前端；port/host/存储目录等需要重启才生效
function applyConfig(nextConfig) {
  const prevConfig = config;
  const prevAgents = aiAgents;
  let nextAgents;
  try {
    config = nextConfig;
    nextAgents = buildAiAgents();
  } catch (err) {
    config = prevConfig;
    aiAgents = prevAgents;
    throw err;
  }
  aiAgents = nextAgents;
  sessionMaxAgeMs = resolveSessionMaxAgeMs();
  aiUnconfiguredNotified = false;
  const forcedLogout = collectForcedLogouts(prevConfig.users, nextConfig.users);
  forceLogoutUsers(forcedLogout);
  broadcastSSE('room', { room: buildRoomInfo() });
  return {
    config,
    forcedLogout,
    restartRequired: changedRestartFields(prevConfig, config),
  };
}

function saveSettings(raw) {
  const normalized = normalizeSettings(raw);
  const effective = mergeConfig(baseConfig, diffConfig(baseConfig, normalized));
  const validation = validateSettings(effective);
  if (!validation.ok) return { ok: false, errors: validation.errors };
  let result;
  try {
    result = applyConfig(effective);
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
  const override = diffConfig(baseConfig, effective);
  backupSettingsFile();
  try {
    writeSettingsOverrideFile(override);
  } catch (err) {
    console.error('[设置] 保存覆盖配置失败：', err && err.message ? err.message : err);
    return { ok: false, errors: [`保存配置失败：${err && err.message ? err.message : err}`] };
  }
  settingsOverride = override;
  return { ok: true, ...result };
}

function resetSettings() {
  let result;
  try {
    result = applyConfig(mergeConfig(baseConfig, {}));
  } catch (err) {
    return { ok: false, errors: [err && err.message ? err.message : String(err)] };
  }
  backupSettingsFile();
  try {
    if (fs.existsSync(SETTINGS_FILE)) fs.unlinkSync(SETTINGS_FILE);
  } catch (err) {
    console.error('[设置] 删除覆盖配置失败：', err && err.message ? err.message : err);
    return { ok: false, errors: [`恢复默认失败：${err && err.message ? err.message : err}`] };
  }
  settingsOverride = {};
  return { ok: true, ...result };
}

// ---------------- API 路由 ----------------

function handleApi(req, res, url) {
  if (url.pathname === '/api/login' && req.method === 'POST') {
    readJsonBody(req)
      .then(async (body) => {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const user = findByUsername(username);
        const keys = loginFailureKeys(req, username);
        const delayMs = loginDelayMs([keys.pairKey, user ? keys.userKey : '', keys.ipKey]);
        if (delayMs > 0) {
          await sleep(delayMs);
        }

        if (!user || user.password !== password) {
          recordLoginFailure([keys.pairKey, user ? keys.userKey : '', keys.ipKey]);
          sendJson(res, 401, { ok: false, message: '用户名或密码错误' });
          return;
        }

        clearLoginFailures([keys.pairKey, keys.userKey]);
        const sid = createSession(user.username);
        setSessionCookie(req, res, sid);
        sendJson(res, 200, {
          ok: true,
          user: {
            username: user.username,
            avatar: user.avatar || '',
            role: String(user.role || 'user'),
          },
        });
      })
      .catch(() => sendJson(res, 400, { ok: false, message: '请求格式错误' }));
    return true;
  }

  if (url.pathname === '/api/logout' && req.method === 'POST') {
    const sid = parseCookies(req)[SESSION_COOKIE];
    if (sid) destroySession(sid);
    clearSessionCookie(req, res);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (url.pathname === '/api/me' && req.method === 'GET') {
    const user = getSessionUser(req);
    if (!user) {
      sendJson(res, 401, { ok: false, message: '未登录' });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      user: {
        username: user.username,
        avatar: user.avatar || '',
        role: String(user.role || 'user'),
      },
    });
    return true;
  }

  // 返回聊天室公开信息（不含任何密钥/账号密码），用于前端展示 AI 成员
  if (url.pathname === '/api/room' && req.method === 'GET') {
    if (!getSessionUser(req)) {
      sendJson(res, 401, { ok: false, message: '未登录' });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      room: buildRoomInfo(),
    });
    return true;
  }

  // 历史消息：所有有记录的日期（倒序，含条数）
  if (url.pathname === '/api/history/days' && req.method === 'GET') {
    if (!getSessionUser(req)) {
      sendJson(res, 401, { ok: false, message: '未登录' });
      return true;
    }
    buildHistoryDays()
      .then((days) => sendJson(res, 200, { ok: true, days }))
      .catch((err) => {
        console.error('[存储] 读取历史日期失败：', err && err.message ? err.message : err);
        sendJson(res, 500, { ok: false, message: '历史读取失败，请稍后重试' });
      });
    return true;
  }

  // 历史消息：查看某一天（按需读取分日文件，带 LRU 缓存）
  if (url.pathname === '/api/history' && req.method === 'GET') {
    if (!getSessionUser(req)) {
      sendJson(res, 401, { ok: false, message: '未登录' });
      return true;
    }
    const date = (url.searchParams.get('date') || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      sendJson(res, 400, { ok: false, message: '日期格式应为 YYYY-MM-DD' });
      return true;
    }
    getDayMessages(date)
      .then((messages) => {
        sendJson(res, 200, {
          ok: true,
          date,
          label: serverDateLabel(date),
          count: messages.length,
          messages,
        });
      })
      .catch((err) => {
        console.error('[存储] 读取单日历史失败：', err.message);
        sendJson(res, 500, { ok: false, message: '历史读取失败，请稍后重试' });
      });
    return true;
  }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    handleEvents(req, res);
    return true;
  }

  if (url.pathname === '/api/messages' && req.method === 'POST') {
    const user = getSessionUser(req);
    if (!user) {
      sendJson(res, 401, { ok: false, message: '未登录' });
      return true;
    }
    readJsonBody(req)
      .then((body) => {
        const text = String(body.text || '').trim();
        if (!text) {
          sendJson(res, 400, { ok: false, message: '消息不能为空' });
          return;
        }
        if (text.length > MESSAGE_MAX_LENGTH) {
          sendJson(res, 400, { ok: false, message: `单条消息不能超过 ${MESSAGE_MAX_LENGTH} 字` });
          return;
        }
        addMessage('user', user.username, user.avatar, text)
          .then((msg) => {
            broadcastSSE('message', { message: msg });
            // 非阻塞触发：用于压缩失败后的快速重试；正常跨日由每日 00:00 定时器负责。
            enqueueMemoryCatchUp();
            triggerAIForUserMessage(text, msg.id);
            sendJson(res, 200, { ok: true, message: msg });
          })
          .catch((err) => {
            console.error('[存储] 用户消息保存失败：', err && err.message ? err.message : err);
            sendJson(res, 503, { ok: false, message: '消息保存失败，请检查服务器存储后重试' });
          });
      })
      .catch(() => sendJson(res, 400, { ok: false, message: '请求格式错误' }));
    return true;
  }

  // ---------------- 设置（仅 admin；写操作要求同源） ----------------

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    if (!getAdminUser(req)) {
      sendJson(res, 403, { ok: false, message: '仅管理员可用' });
      return true;
    }
    let savedAt = null;
    let hasOverride = false;
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        hasOverride = true;
        savedAt = fs.statSync(SETTINGS_FILE).mtimeMs;
      }
    } catch (_err) {
      hasOverride = false;
    }
    sendJson(res, 200, {
      ok: true,
      config,
      meta: {
        baseFile: path.basename(BASE_CONFIG_FILE),
        settingsFile: path.basename(SETTINGS_FILE),
        hasOverride,
        savedAt,
        restartFields: SETTINGS_RESTART_FIELDS.map(([, label]) => label),
        adminUsers: (config.users || []).filter(isAdminUser).map((u) => u.username),
        currentUser: (getSessionUser(req) || {}).username || '',
      },
    });
    return true;
  }

  if (
    (url.pathname === '/api/settings' || url.pathname === '/api/settings/import') &&
    req.method === 'POST'
  ) {
    if (!getAdminUser(req)) {
      sendJson(res, 403, { ok: false, message: '仅管理员可用' });
      return true;
    }
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { ok: false, message: '请求来源校验失败，请刷新页面后重试' });
      return true;
    }
    readJsonBody(req, 512 * 1024)
      .then((body) => {
        const payload = isPlainObject(body) && body.config !== undefined ? body.config : body;
        const result = saveSettings(payload);
        if (!result.ok) {
          sendJson(res, 400, {
            ok: false,
            errors: result.errors,
            message: (result.errors && result.errors[0]) || '配置校验失败',
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          config: result.config,
          forcedLogout: result.forcedLogout || [],
          restartRequired: result.restartRequired || [],
        });
      })
      .catch((err) =>
        sendJson(res, 400, {
          ok: false,
          message: err && err.message ? err.message : '请求格式错误',
        })
      );
    return true;
  }

  if (url.pathname === '/api/settings/reset' && req.method === 'POST') {
    if (!getAdminUser(req)) {
      sendJson(res, 403, { ok: false, message: '仅管理员可用' });
      return true;
    }
    if (!isSameOriginRequest(req)) {
      sendJson(res, 403, { ok: false, message: '请求来源校验失败，请刷新页面后重试' });
      return true;
    }
    const result = resetSettings();
    if (!result.ok) {
      sendJson(res, 400, {
        ok: false,
        errors: result.errors,
        message: (result.errors && result.errors[0]) || '恢复默认失败',
      });
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      config: result.config,
      forcedLogout: result.forcedLogout || [],
      restartRequired: result.restartRequired || [],
    });
    return true;
  }

  if (url.pathname === '/api/settings/export' && req.method === 'GET') {
    if (!getAdminUser(req)) {
      sendJson(res, 403, { ok: false, message: '仅管理员可用' });
      return true;
    }
    const body = JSON.stringify(config, null, 2);
    applySecurityHeaders(res);
    applyNoStore(res);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="ai-group-chat-config.json"',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  }

  return false;
}

// ---------------- 页面 / 静态文件路由 ----------------

function servePage(res, filename) {
  sendFile(res, path.join(PUBLIC_DIR, filename));
}

function resolvePublicFile(urlPathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch (_err) {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const relative = decoded.slice(1).replace(/\\/g, '/');
  const filePath = path.resolve(PUBLIC_DIR, relative);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return null; // 防止目录穿越
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch (_err) {
    sendText(res, 400, 'Bad Request');
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    if (!handleApi(req, res, url)) {
      sendJson(res, 404, { ok: false, message: '接口不存在' });
    }
    return;
  }

  const user = getSessionUser(req);

  // 首页：已登录进聊天室，未登录跳登录页
  if (url.pathname === '/') {
    if (user) {
      servePage(res, 'chat.html');
    } else {
      redirect(res, '/login.html');
    }
    return;
  }

  // 登录页：已登录则直接进聊天室
  if (url.pathname === '/login.html') {
    if (user) {
      redirect(res, '/');
    } else {
      servePage(res, 'login.html');
    }
    return;
  }

  // 聊天页：需要登录
  if (url.pathname === '/chat.html') {
    if (!user) {
      redirect(res, '/login.html');
      return;
    }
    servePage(res, 'chat.html');
    return;
  }

  // 设置页：需要登录且必须是 admin
  if (url.pathname === '/settings' || url.pathname === '/settings.html') {
    if (!user) {
      redirect(res, '/login.html');
      return;
    }
    if (!isAdminUser(user)) {
      redirect(res, '/');
      return;
    }
    servePage(res, 'settings.html');
    return;
  }

  const filePath = resolvePublicFile(url.pathname);
  if (filePath) {
    sendFile(res, filePath);
    return;
  }

  sendText(res, 404, '404 Not Found');
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('[请求处理出错]', err);
    if (!res.headersSent) sendText(res, 500, '服务器内部错误');
    res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`启动失败：端口 ${config.port} 已被占用，请修改 config.js 中的 port，或先关闭占用端口的程序。`);
    process.exit(1);
  }
  console.error('服务器错误：', err);
  process.exit(1);
});

// SSE 心跳：每 25 秒给所有在线连接写一个注释行
setInterval(() => {
  for (const client of sseClients) {
    enqueueSSEPayload(client, ': keep-alive\n\n', { dropWhenBackpressured: true });
  }
}, HEARTBEAT_MS).unref();

// 在线状态校正：每 15 秒清理一次已断开的连接并重算人数
setInterval(syncPresenceFromClients, 15000).unref();

// 过期 session 定时清理：正常请求时已做惰性过期校验，这里兜底防止 Map 无限增长
setInterval(() => {
  const cutoff = Date.now() - sessionMaxAgeMs;
  for (const [sid, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();

// 清理过期的登录失败计数，防止 Map 无限增长
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (now - entry.windowStart >= LOGIN_WINDOW_MS) {
      loginFailures.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

// 定期裁剪热窗口，防止长运行时内存无限增长
setInterval(trimHotHistory, 10 * 60 * 1000).unref();

// 清理过期风暴与频率计数，防止 Map 无限增长
setInterval(cleanupAiStorms, 5 * 60 * 1000).unref();

async function startServer() {
  try {
    await initializeStorage();
    server.listen(config.port, config.host || '0.0.0.0', () => {
      const address = server.address();
      const host =
        typeof address === 'object' && address ? address.address : config.host || '127.0.0.1';
      console.log(`AI 群聊服务已启动：监听 ${host}:${config.port}`);
      console.log(`访问地址：http://127.0.0.1:${config.port}`);
      console.log(`当前登录账号：${(config.users || []).map((u) => u.username).join('、')}`);
      console.log(`历史消息目录 ${STORAGE_DIR}，内存热窗口 ${history.length} 条`);
      const replyMode = getReplyMode();
      if (replyMode === 'off') {
        console.log('AI 回复模式：off（不自动回复）');
      } else if (replyMode === 'self') {
        const self = getSelfDecisionSettings(null);
        console.log(
          `AI 回复模式：self（每个 AI 先判断再回复；AI 互触发最多 ${self.maxHops} 层，` +
            `单次风暴最多 ${self.maxRepliesPerStorm} 条 AI 回复，判断上下文 ${self.judgeHistoryCount} 条）`
        );
      } else {
        console.log('AI 回复模式：hybrid（普通消息随机一位 AI 回复）');
      }
      if (config.chat && config.chat.router) {
        console.warn('[配置] chat.router 已废弃并被忽略，请改用 chat.selfDecision');
      }
      if (String((config.chat && config.chat.aiReplyMode) || '') === 'router') {
        console.warn('[配置] aiReplyMode="router" 已废弃，已按 "self" 处理');
      }
      if (aiAgents.length === 0) {
        console.log('提示：未启用任何 AI 成员，当前为纯用户群聊');
      } else if (aiAgents.some((a) => !aiIsConfigured(a))) {
        const missing = aiAgents.filter((a) => !aiIsConfigured(a)).map((a) => a.name).join('、');
        console.log(`警告：AI 成员（${missing}）apiBaseUrl / apiKey 未配置完整`);
      } else {
        const info = aiAgents.map((a) => `${a.name}(${a.model})`).join('、');
        console.log(`AI 成员已启用：${info}`);
      }
    });
    // 记忆追平放到后台执行，避免压缩失败/超时阻塞服务启动；
    // 之后每天 Asia/Shanghai 00:00 自动再追平一次。
    enqueueMemoryCatchUp();
    scheduleDailyMemoryCatchUp();
  } catch (err) {
    console.error('[启动失败] 存储初始化失败：', err && err.message ? err.message : err);
    process.exit(1);
  }
}

startServer();
