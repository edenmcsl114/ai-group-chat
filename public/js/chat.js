'use strict';

const state = {
  me: null,
  room: null,
  messages: [],
  seenIds: new Set(),
  online: 0,
  offline: false,
  presenceUsers: [], // 当前在线的人类用户
  mentionIndex: 0,
};

const messagesEl = document.getElementById('messages');
const roomTitleEl = document.getElementById('roomTitle');
const roomAvatarEl = document.getElementById('roomAvatar');
const roomMetaEl = document.getElementById('roomMeta');
const roomMetaTextEl = document.getElementById('roomMetaText');
const sendForm = document.getElementById('sendForm');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const sendErrorEl = document.getElementById('sendError');
const scrollDownBtn = document.getElementById('scrollDownBtn');
const historyBtn = document.getElementById('historyBtn');
const settingsBtn = document.getElementById('settingsBtn');
const historyPanel = document.getElementById('historyPanel');
const historyTitle = document.getElementById('historyTitle');
const historyBackBtn = document.getElementById('historyBackBtn');
const historyCloseBtn = document.getElementById('historyCloseBtn');
const historyDaysEl = document.getElementById('historyDays');
const historyDayViewEl = document.getElementById('historyDayView');
const mentionBox = document.getElementById('mentionBox');

let eventSource = null;
let authProbeTimer = null;
let authRedirecting = false;

// ---------------- 历史消息 ----------------

function showHistoryEmpty(parent, text) {
  parent.textContent = '';
  parent.appendChild(el('p', 'history-tip', text));
}

async function loadHistoryDays() {
  historyDaysEl.hidden = false;
  historyDayViewEl.hidden = true;
  historyBackBtn.hidden = true;
  historyTitle.textContent = '历史消息';
  showHistoryEmpty(historyDaysEl, '加载中…');

  try {
    const res = await fetch('/api/history/days', { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/login.html';
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      showHistoryEmpty(historyDaysEl, data.message || '加载失败');
      return;
    }
    const days = data.days || [];
    if (days.length === 0) {
      showHistoryEmpty(historyDaysEl, '还没有历史消息');
      return;
    }
    historyDaysEl.textContent = '';
    for (const day of days) {
      const item = el('button', 'history-day-item');
      item.type = 'button';
      const main = el('div', 'history-day-main');
      main.appendChild(el('span', 'history-day-label', day.label));
      main.appendChild(el('span', 'history-day-date', day.date));
      item.appendChild(main);
      item.appendChild(el('span', 'history-day-count', `${day.count} 条`));
      item.addEventListener('click', () => openHistoryDate(day));
      historyDaysEl.appendChild(item);
    }
  } catch (_err) {
    showHistoryEmpty(historyDaysEl, '网络错误，请重试');
  }
}

async function openHistoryDate(day) {
  historyDaysEl.hidden = true;
  historyDayViewEl.hidden = false;
  historyBackBtn.hidden = false;
  historyTitle.textContent = day.label;
  historyDayViewEl.textContent = '';
  historyDayViewEl.appendChild(el('p', 'history-tip', '加载中…'));

  try {
    const res = await fetch(`/api/history?date=${encodeURIComponent(day.date)}`, {
      credentials: 'same-origin',
    });
    if (res.status === 401) {
      location.href = '/login.html';
      return;
    }
    const data = await res.json();
    if (!res.ok || !data.ok) {
      historyDayViewEl.textContent = '';
      historyDayViewEl.appendChild(el('p', 'history-tip', data.message || '加载失败'));
      return;
    }
    historyDayViewEl.textContent = '';
    historyDayViewEl.appendChild(
      el('p', 'history-readonly-note', `${day.date} · 共 ${data.count} 条（只读历史）`)
    );
    if (data.messages.length === 0) {
      historyDayViewEl.appendChild(el('p', 'history-tip', '这一天没有消息'));
      return;
    }
    historyDayViewEl.appendChild(el('div', 'date-divider', day.label));
    for (const msg of data.messages) {
      if (msg.role === 'system') continue;
      historyDayViewEl.appendChild(renderMessageNode(msg));
    }
  } catch (_err) {
    historyDayViewEl.textContent = '';
    historyDayViewEl.appendChild(el('p', 'history-tip', '网络错误，请重试'));
  }
}

function openHistoryPanel() {
  historyPanel.hidden = false;
  loadHistoryDays();
}

function backToDayList() {
  historyDaysEl.hidden = false;
  historyDayViewEl.hidden = true;
  historyBackBtn.hidden = true;
  historyTitle.textContent = '历史消息';
}

function closeHistoryPanel() {
  historyPanel.hidden = true;
  historyDayViewEl.textContent = '';
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000; // 群聊统一时区 Asia/Shanghai（UTC+8，无夏令时）

function todayStartMs() {
  const d = new Date(Date.now() + SHANGHAI_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - SHANGHAI_OFFSET_MS;
}

function shanghaiParts(ts) {
  const d = new Date(ts + SHANGHAI_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

function formatTime(ts) {
  const p = shanghaiParts(ts);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function isSameDay(a, b) {
  const da = shanghaiParts(a);
  const db = shanghaiParts(b);
  return (
    da.year === db.year &&
    da.month === db.month &&
    da.day === db.day
  );
}

function formatDateDivider(ts) {
  const p = shanghaiParts(ts);
  const now = Date.now();
  const today = isSameDay(ts, now);
  if (today) return '今天';
  if (isSameDay(ts, now - 24 * 60 * 60 * 1000)) return '昨天';
  const nowParts = shanghaiParts(now);
  const year = p.year === nowParts.year ? '' : `${p.year}年`;
  return `${year}${p.month}月${p.day}日`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isAvatarImage(avatar) {
  return Boolean(
    avatar &&
      (/^https?:\/\//i.test(avatar) ||
        /^data:image\//i.test(avatar) ||
        /\.(png|jpe?g|gif|webp|svg)(\?|#|$)/i.test(avatar))
  );
}

// AI 回复按 [日期][时间][AI名]{正文} 存储，界面上只展示 { } 里的正文
function bubbleText(msg) {
  if (!msg || msg.role !== 'ai') return msg ? msg.text : '';
  let text = String(msg.text || '');
  // 连续剥离嵌套/残缺的 [日期][时间][名字]{ 前缀，避免 } 缺失时把前缀露出来
  for (let i = 0; i < 3; i++) {
    const matched = text.match(
      /^\[\d{4}\/\d{2}\/\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[^\]]*\]\{/
    );
    if (!matched) break;
    text = text.slice(matched[0].length).trimStart();
    if (text.endsWith('}')) text = text.slice(0, -1).trimEnd();
  }
  return text;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function knownMentionNames() {
  const names = new Set();
  for (const opt of everyoneMentionOptions()) names.add(opt.name); // @所有人 / @all 高亮
  const ais = (state.room && state.room.ais) || [];
  for (const a of ais) names.add(a.name);
  for (const u of state.presenceUsers) names.add(u.username);
  if (state.me && state.me.username) names.add(state.me.username);
  return Array.from(names).sort((a, b) => b.length - a.length);
}

// 把 @名字 在气泡里高亮显示（AI/在线人类）
function fillBubble(bubble, text) {
  bubble.textContent = '';
  const raw = String(text || '');
  const names = knownMentionNames();
  if (names.length === 0 || !raw.includes('@')) {
    bubble.textContent = raw;
    return;
  }
  const re = new RegExp(
    `@(${names.map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
    'gu'
  );
  let lastIndex = 0;
  let match;
  while ((match = re.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      bubble.appendChild(document.createTextNode(raw.slice(lastIndex, match.index)));
    }
    const mention = document.createElement('span');
    mention.className = 'mention';
    mention.textContent = match[0];
    bubble.appendChild(mention);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < raw.length) {
    bubble.appendChild(document.createTextNode(raw.slice(lastIndex)));
  }
}

function avatarSrc(avatar) {
  if (!avatar) return '';
  if (/^(https?:|data:)/i.test(avatar) || avatar.startsWith('/')) return avatar;
  return `/avatars/${avatar}`;
}

function setAvatar(container, avatar) {
  container.textContent = '';
  container.classList.remove('img');
  if (isAvatarImage(avatar)) {
    const img = document.createElement('img');
    img.src = avatarSrc(avatar);
    img.alt = '';
    img.onerror = () => {
      img.remove();
      container.classList.remove('img');
      container.textContent = '🙂';
    };
    container.appendChild(img);
    container.classList.add('img');
  } else {
    container.textContent = avatar || '🙂';
  }
}

function nameColorClass(name) {
  const palette = ['name-c0', 'name-c1', 'name-c2', 'name-c3', 'name-c4', 'name-c5'];
  let hash = 0;
  for (const ch of String(name || '')) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return palette[hash % palette.length];
}

// ---------------- 页面头部 ----------------

function updateRoomMeta() {
  if (state.offline) {
    roomMetaEl.classList.add('offline');
    roomMetaTextEl.textContent = '连接断开，正在重连…';
    return;
  }
  roomMetaEl.classList.remove('offline');
  let text;
  if (state.online > 1) text = `${state.online} 人在线`;
  else if (state.online === 1) text = '只有你在线';
  else text = '连接中…';
  const ais = (state.room && state.room.ais) || [];
  if (ais.length > 0) {
    text = `${ais.length} 个 AI · ${text}`;
  }
  roomMetaTextEl.textContent = text;
}

async function loadMe() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) {
      location.href = '/login.html';
      return null;
    }
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch (_err) {
    return null;
  }
}

function applyRoom(room) {
  state.room = room || null;
  if (!state.room) return;
  roomTitleEl.textContent = state.room.title || 'AI 群聊';
  document.title = state.room.title || 'AI 群聊';
  const firstAI = (state.room.ais && state.room.ais[0]) || state.room.ai;
  if (firstAI && firstAI.enabled !== false) setAvatar(roomAvatarEl, firstAI.avatar);
}

// 只有 admin 账号显示设置入口
function applyRoleUi(user) {
  if (!settingsBtn) return;
  const isAdmin = !!user && String(user.role || '').toLowerCase() === 'admin';
  settingsBtn.hidden = !isAdmin;
}

async function loadRoom() {
  try {
    const res = await fetch('/api/room', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    applyRoom(data.room || null);
  } catch (_err) {
    /* 群信息拿不到不影响聊天 */
  }
  updateRoomMeta();
}

// 管理员改动配置后，重新拉一次自己的身份，保证设置入口的显示与角色同步
async function refreshMe() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    if (!res.ok) return;
    const data = await res.json();
    if (data.user) {
      state.me = data.user;
      applyRoleUi(data.user);
    }
  } catch (_err) {
    /* 网络异常时保持现状 */
  }
}

// ---------------- 消息渲染 ----------------

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
}

function scrollToBottom(smooth = false) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function refreshScrollBtn() {
  scrollDownBtn.hidden = isNearBottom();
}

// 同一个人 3 分钟内连续发言合并为一组：后面的气泡不再重复头像与昵称
const GROUP_WINDOW_MS = 3 * 60 * 1000;

function isGroupedMessage(msg, prev) {
  if (!msg || !prev) return false;
  if (msg.streaming || prev.streaming) return false;
  if (msg.role !== prev.role || msg.name !== prev.name) return false;
  if (!isSameDay(msg.time, prev.time)) return false;
  return msg.time - prev.time < GROUP_WINDOW_MS;
}

function renderMessageNode(msg, prev) {
  const mine = state.me && msg.name === state.me.username;
  const grouped = isGroupedMessage(msg, prev);
  const article = el('article', 'message');
  article.dataset.id = String(msg.id);
  if (msg.role === 'ai') article.classList.add('ai');
  else if (mine) article.classList.add('mine');
  else article.classList.add('other');
  if (msg.streaming) article.classList.add('streaming');
  if (grouped) article.classList.add('grouped');

  // 合并显示时保留占位，保证气泡左右对齐不跳动
  const avatarBox = el('div', grouped ? 'msg-avatar ghost' : 'msg-avatar');
  setAvatar(avatarBox, msg.avatar);
  article.appendChild(avatarBox);

  const body = el('div', 'msg-body');
  if (!grouped) {
    const meta = el('div', 'msg-meta');
    const name = el('span', `msg-name ${nameColorClass(msg.name)}`, msg.name);
    meta.appendChild(name);
    if (msg.role === 'ai') meta.appendChild(el('span', 'ai-badge', 'AI'));
    meta.appendChild(el('span', 'msg-time', formatTime(msg.time)));
    body.appendChild(meta);
  }
  const bubble = el('div', 'bubble');
  fillBubble(bubble, bubbleText(msg));
  body.appendChild(bubble);

  article.appendChild(body);
  return article;
}

// 消息被移除（例如 AI 流式回复失败）后，紧随其后的那条可能不该再合并显示
function reflowGrouping() {
  for (let i = 0; i < state.messages.length; i += 1) {
    const prev = i > 0 ? state.messages[i - 1] : null;
    const msg = state.messages[i];
    const node = findMessageNode(msg.id);
    if (!node) continue;
    if (node.classList.contains('grouped') === isGroupedMessage(msg, prev)) continue;
    node.replaceWith(renderMessageNode(msg, prev));
  }
}

function findMessageNode(id) {
  return messagesEl.querySelector(`.message[data-id="${id}"]`);
}

// AI 流式回复失败时按 id 移除服务端标记为失败的占位/半成品气泡
function removeMessageById(msgId) {
  const idx = state.messages.findIndex((m) => m.id === msgId);
  if (idx !== -1) state.messages.splice(idx, 1);
  state.seenIds.delete(msgId);
  const node = findMessageNode(msgId);
  if (node) node.remove();
  reflowGrouping();
  if (state.messages.length === 0) renderEmptyHint();
  refreshScrollBtn();
}

function appendMessageNode(msg, prev) {
  const last =
    prev === undefined ? state.messages[state.messages.length - 1] || null : prev;
  if (!last || !isSameDay(last.time, msg.time)) {
    messagesEl.appendChild(el('div', 'date-divider', formatDateDivider(msg.time)));
  }
  messagesEl.appendChild(renderMessageNode(msg, last));
}

function pushMessageToDOM(msg) {
  const prev = state.messages[state.messages.length - 1] || null;
  state.messages.push(msg);
  appendMessageNode(msg, prev);
}

function showSystemLine(text) {
  const stickBottom = isNearBottom();
  const emptyHint = messagesEl.querySelector('.empty-hint, .empty-state');
  if (emptyHint) emptyHint.remove();
  messagesEl.appendChild(el('div', 'system-line', text));
  if (stickBottom) scrollToBottom();
  refreshScrollBtn();
}

function renderEmptyHint() {
  if (state.messages.length === 0) {
    const wrap = el('div', 'empty-state');
    wrap.appendChild(el('div', 'empty-icon', '💬'));
    wrap.appendChild(el('p', 'empty-title', '还没有消息'));
    wrap.appendChild(el('p', 'empty-sub', '发第一句话，开始群聊吧'));
    messagesEl.appendChild(wrap);
  }
}

// 不是今天的消息从实时聊天区移除（服务端快照已过滤，这里是长时间不刷新时的兜底）
function pruneOldMessages() {
  const cutoff = todayStartMs();
  const remaining = state.messages.filter((m) => m.time >= cutoff);
  if (remaining.length === state.messages.length) return;

  const stickBottom = isNearBottom();
  state.messages = remaining;
  messagesEl.textContent = '';
  for (let i = 0; i < state.messages.length; i += 1) {
    appendMessageNode(state.messages[i], i > 0 ? state.messages[i - 1] : null);
  }
  renderEmptyHint();
  if (stickBottom) scrollToBottom();
  refreshScrollBtn();
}

function renderHistory(list) {
  messagesEl.textContent = '';
  state.messages = [];
  state.seenIds = new Set();
  for (const msg of Array.isArray(list) ? list : []) {
    if (state.seenIds.has(msg.id)) continue;
    state.seenIds.add(msg.id);
    pushMessageToDOM(msg);
  }
  renderEmptyHint();
  scrollToBottom();
  refreshScrollBtn();
}

function handleIncoming(msg) {
  if (!msg) return;

  // AI 流式回复会多次推送同一个 id，原地更新气泡而不是重复插入
  const idx = state.messages.findIndex((m) => m.id === msg.id);
  if (idx !== -1) {
    // streaming 必须显式覆盖：流式结束后服务端不再下发该字段，
    // 沿用气泡里的旧值会让「正在输入」状态永远留着。
    state.messages[idx] = Object.assign({}, state.messages[idx], msg, {
      streaming: Boolean(msg.streaming),
    });
    const node = findMessageNode(msg.id);
    if (node) {
      const bubble = node.querySelector('.bubble');
      if (bubble) fillBubble(bubble, bubbleText(msg));
      node.classList.toggle('streaming', Boolean(msg.streaming));
    }
    if (isNearBottom()) scrollToBottom();
    return;
  }

  if (state.seenIds.has(msg.id)) return;
  state.seenIds.add(msg.id);

  if (msg.role === 'system') {
    showSystemLine(msg.text);
    return;
  }

  const nearBottom = isNearBottom();
  const mine = state.me && msg.name === state.me.username;
  const emptyHint = messagesEl.querySelector('.empty-hint, .empty-state');
  if (emptyHint) emptyHint.remove();
  pushMessageToDOM(msg);
  if (nearBottom || mine) scrollToBottom(true);
  refreshScrollBtn();
}

// ---------------- 发送 ----------------

function autoResizeTextarea() {
  msgInput.style.height = 'auto';
  msgInput.style.height = `${Math.min(msgInput.scrollHeight, 110)}px`;
}

function showSendError(message) {
  sendErrorEl.textContent = message;
  sendErrorEl.hidden = false;
  clearTimeout(showSendError._timer);
  showSendError._timer = setTimeout(() => {
    sendErrorEl.hidden = true;
  }, 3500);
}

// ---------------- @ 自动补全 ----------------

// @所有人 候选：优先读服务器下发的 chat.everyoneKeywords（config.js 是唯一配置源），
// 旧服务端没有该字段时回退到默认的 @所有人 / @all。
function everyoneMentionOptions() {
  const configured =
    state.room && Array.isArray(state.room.everyoneKeywords)
      ? state.room.everyoneKeywords
      : [];
  const keywords =
    configured.length > 0
      ? configured
      : ['@所有人', '@all'];
  const options = [];
  const seen = new Set();
  for (const raw of keywords) {
    const keyword = String(raw || '').trim();
    if (!keyword) continue;
    const label = keyword.startsWith('@') ? keyword : `@${keyword}`;
    const name = keyword.startsWith('@') ? keyword.slice(1).trim() : keyword;
    if (!name) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ name, label, avatar: '🗣️', tag: '全部 AI' });
  }
  return options;
}

function mentionCandidates(query) {
  const lower = String(query || '').toLowerCase();
  const results = [];
  const seen = new Set();
  for (const opt of everyoneMentionOptions()) {
    const matches =
      !query ||
      opt.label.toLowerCase().startsWith(`@${lower}`) ||
      opt.name.toLowerCase().includes(lower);
    if (matches && !seen.has(opt.name)) {
      seen.add(opt.name);
      results.push(opt);
    }
  }
  const ais = (state.room && state.room.ais) || [];
  for (const a of ais) {
    if (!seen.has(a.name) && a.name.toLowerCase().includes(lower)) {
      seen.add(a.name);
      results.push({ name: a.name, avatar: a.avatar, tag: 'AI' });
    }
  }
  for (const u of state.presenceUsers) {
    if (state.me && u.username === state.me.username) continue;
    if (!seen.has(u.username) && u.username.toLowerCase().includes(lower)) {
      seen.add(u.username);
      results.push({ name: u.username, avatar: u.avatar, tag: '在线' });
    }
  }
  return results;
}

function currentMentionPosition() {
  const value = msgInput.value;
  const caret = msgInput.selectionStart == null ? value.length : msgInput.selectionStart;
  const before = value.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  const typed = before.slice(at + 1);
  if (typed.length > 30 || /[\s@，。！？,.]/.test(typed)) return null;
  return { at, query: typed };
}

function hideMentionBox() {
  mentionBox.hidden = true;
  mentionBox.textContent = '';
  state.mentionIndex = 0;
}

function renderMentionBox() {
  const pos = currentMentionPosition();
  if (!pos) {
    hideMentionBox();
    return;
  }
  const items = mentionCandidates(pos.query);
  if (items.length === 0) {
    hideMentionBox();
    return;
  }
  mentionBox.textContent = '';
  if (state.mentionIndex >= items.length) state.mentionIndex = 0;
  items.forEach((cand, index) => {
    const item = el('button', 'mention-item');
    item.type = 'button';
    if (index === state.mentionIndex) item.classList.add('selected');
    const avatarBox = el('span', 'mention-avatar');
    setAvatar(avatarBox, cand.avatar);
    item.appendChild(avatarBox);
    item.appendChild(el('span', 'mention-name', cand.label || `@${cand.name}`));
    item.appendChild(el('span', 'mention-tag', cand.tag));
    item.addEventListener('mousedown', (event) => event.preventDefault());
    item.addEventListener('click', () => chooseMention(cand.name));
    mentionBox.appendChild(item);
  });
  mentionBox.hidden = false;
}

function chooseMention(name) {
  const pos = currentMentionPosition();
  if (!pos) return;
  const value = msgInput.value;
  const replacement = `@${name} `;
  msgInput.value = value.slice(0, pos.at) + replacement + value.slice(pos.at + pos.query.length + 1);
  const nextCaret = pos.at + replacement.length;
  msgInput.setSelectionRange(nextCaret, nextCaret);
  hideMentionBox();
  autoResizeTextarea();
  msgInput.focus();
}

async function sendMessage() {
  const text = msgInput.value.trim();
  if (!text || sendBtn.disabled) return;
  sendBtn.disabled = true;
  try {
    const res = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      showSendError(data.message || '发送失败，请重试');
      return;
    }
    msgInput.value = '';
    autoResizeTextarea();
    msgInput.focus();
  } catch (_err) {
    showSendError('网络错误，请稍后重试');
  } finally {
    sendBtn.disabled = false;
  }
}

// ---------------- SSE ----------------

function clearAuthProbe() {
  if (authProbeTimer) {
    clearTimeout(authProbeTimer);
    authProbeTimer = null;
  }
}

function redirectToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  clearAuthProbe();
  if (eventSource) {
    try {
      eventSource.close();
    } catch (_err) {
      /* ignore */
    }
    eventSource = null;
  }
  location.href = '/login.html';
}

// EventSource 拿不到 HTTP 状态码，收到 401 后只会无限重连。
// 离线/报错时定时探测 /api/me，发现会话失效就跳转登录页。
function scheduleAuthProbe(delayMs = 5000) {
  if (authProbeTimer || authRedirecting) return;
  authProbeTimer = setTimeout(async () => {
    authProbeTimer = null;
    try {
      const res = await fetch('/api/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok && state.offline) {
        scheduleAuthProbe();
      }
    } catch (_err) {
      if (state.offline) scheduleAuthProbe();
    }
  }, delayMs);
}

function connectEvents() {
  const es = new EventSource('/api/events');

  es.onopen = () => {
    clearAuthProbe();
    state.offline = false;
    updateRoomMeta();
  };

  es.onerror = () => {
    state.offline = true;
    updateRoomMeta();
    scheduleAuthProbe();
  };

  es.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    state.me = data.me || state.me;
    applyRoleUi(state.me);
    if (data.presence) {
      state.presenceUsers = data.presence;
      state.online = data.presence.length;
    }
    updateRoomMeta();
    renderHistory(data.history);

    document.getElementById('meName').textContent = state.me.username;
    setAvatar(document.getElementById('meAvatar'), state.me.avatar);
    sendBtn.disabled = false;
  });

  es.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    handleIncoming(data.message);
  });

  es.addEventListener('ai_chunk', (event) => {
    const data = JSON.parse(event.data);
    handleIncoming(data.message);
  });

  es.addEventListener('ai_error', (event) => {
    const data = JSON.parse(event.data);
    if (data.msgId != null) removeMessageById(Number(data.msgId));
    showSystemLine(data.text || 'AI 回复失败');
  });

  es.addEventListener('presence', (event) => {
    const data = JSON.parse(event.data);
    state.presenceUsers = Array.isArray(data.list) ? data.list : [];
    state.online = state.presenceUsers.length;
    updateRoomMeta();
  });

  // 管理员保存设置后，服务端会推送新的房间信息（AI 列表、@所有人 关键词等）
  es.addEventListener('room', (event) => {
    const data = JSON.parse(event.data);
    if (data && data.room) {
      applyRoom(data.room);
      updateRoomMeta();
    }
    refreshMe();
  });

  return es;
}

// ---------------- 初始化 ----------------

document.addEventListener('DOMContentLoaded', async () => {
  const user = await loadMe();
  if (!user) return;
  state.me = user;
  applyRoleUi(user);

  document.getElementById('meName').textContent = user.username;
  setAvatar(document.getElementById('meAvatar'), user.avatar);
  await loadRoom();
  eventSource = connectEvents();

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    sendMessage();
  });

  msgInput.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return; // 中文输入法选词中不发送
    const mentionOpen = !mentionBox.hidden;
    if (mentionOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const pos = currentMentionPosition();
        if (!pos) {
          hideMentionBox();
          return;
        }
        const count = mentionCandidates(pos.query).length;
        if (count === 0) return;
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.mentionIndex = (state.mentionIndex + delta + count) % count;
        renderMentionBox();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const pos = currentMentionPosition();
        const candidates = pos ? mentionCandidates(pos.query) : [];
        const selected = candidates[state.mentionIndex];
        if (selected) chooseMention(selected.name);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        hideMentionBox();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendForm.requestSubmit();
    }
    if (!sendErrorEl.hidden) sendErrorEl.hidden = true;
  });

  msgInput.addEventListener('input', () => {
    autoResizeTextarea();
    renderMentionBox();
  });
  msgInput.addEventListener('blur', () => setTimeout(hideMentionBox, 150));
  messagesEl.addEventListener('scroll', refreshScrollBtn);
  scrollDownBtn.addEventListener('click', () => scrollToBottom(true));
  setInterval(pruneOldMessages, 60 * 1000);

  // 窄屏输入框放不下整句提示，换成短文案，避免占位文字被裁成两行
  if (window.matchMedia && window.matchMedia('(max-width: 520px)').matches) {
    msgInput.placeholder = '发消息…';
  }

  historyBtn.addEventListener('click', openHistoryPanel);
  historyBackBtn.addEventListener('click', backToDayList);
  historyCloseBtn.addEventListener('click', closeHistoryPanel);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (eventSource) eventSource.close();
    try {
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      location.href = '/login.html';
    }
  });
});
