'use strict';

const state = {
  config: null,
  meta: null,
  busy: false,
  revealSecrets: false,
};

const sectionsEl = document.getElementById('settingsSections');
const metaEl = document.getElementById('settingsMeta');
const statusEl = document.getElementById('settingsStatus');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFile = document.getElementById('importFile');
const revealSecrets = document.getElementById('revealSecrets');

// ---------------- 通用工具 ----------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function getPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cursor = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
}

let statusTimer = null;
function setStatus(text, kind = 'info', sticky = false) {
  statusEl.textContent = text || '';
  statusEl.className = `settings-status ${text ? `is-${kind}` : ''}`;
  clearTimeout(statusTimer);
  if (text && !sticky) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'settings-status';
    }, 6000);
  }
}

function setBusy(busy) {
  state.busy = busy;
  saveBtn.disabled = busy;
  resetBtn.disabled = busy;
  exportBtn.disabled = busy;
  importBtn.disabled = busy;
}

function redirectIfInvalid(res) {
  if (res.status === 401) {
    location.href = '/login.html';
    return true;
  }
  if (res.status === 403) {
    setStatus('当前账号没有管理员权限', 'error');
    setTimeout(() => {
      location.href = '/';
    }, 1200);
    return true;
  }
  return false;
}

// ---------------- 字段定义 ----------------

const THINKING_FIELDS = [
  { path: 'thinking.enabled', label: '启用思考模型', type: 'checkbox' },
  {
    path: 'thinking.effort',
    label: '思考强度',
    type: 'select',
    options: ['low', 'medium', 'high'],
  },
  { path: 'thinking.sendEffort', label: '发送 reasoning_effort', type: 'checkbox' },
];

const SELF_DECISION_FIELDS = [
  { path: 'selfDecision.enabled', label: '启用自我判断', type: 'checkbox' },
  { path: 'selfDecision.judgeHistoryCount', label: '判断上下文条数', type: 'number', min: 1 },
  { path: 'selfDecision.replyHistoryCount', label: '生成上下文条数', type: 'number', min: 1 },
  { path: 'selfDecision.maxHops', label: 'AI 互触发最大层数', type: 'number', min: 0 },
  { path: 'selfDecision.maxRepliesPerStorm', label: '单次风暴回复上限', type: 'number', min: 0 },
  { path: 'selfDecision.maxRepliesPerAIPerStorm', label: '单 AI 单次风暴上限', type: 'number', min: 0 },
  { path: 'selfDecision.cooldownMs', label: '自主回复冷却（毫秒）', type: 'number', min: 0 },
  {
    path: 'selfDecision.globalConcurrency',
    label: '接口并发上限（全局）',
    type: 'number',
    min: 1,
  },
  { path: 'selfDecision.forceReplyOnMention', label: '被 @ 时直接回复', type: 'checkbox' },
  { path: 'selfDecision.othersJudgeOnMention', label: '被 @ 时其他 AI 仍判断', type: 'checkbox' },
  { path: 'selfDecision.rateLimit.perAiPerMinute', label: '单 AI 每分钟回复上限', type: 'number', min: 0 },
  { path: 'selfDecision.rateLimit.totalPerMinute', label: '全局每分钟回复上限', type: 'number', min: 0 },
  { path: 'selfDecision.model', label: '判断模型（留空用该 AI 的模型）', type: 'text', wide: true },
  { path: 'selfDecision.apiBaseUrl', label: '判断接口地址（留空继承）', type: 'text', wide: true },
  { path: 'selfDecision.apiKey', label: '判断接口密钥（留空继承）', type: 'password', wide: true },
  { path: 'selfDecision.temperature', label: '判断温度', type: 'number', step: '0.1', min: 0, max: 2 },
  { path: 'selfDecision.maxTokens', label: '判断输出上限', type: 'number', min: 1 },
  { path: 'selfDecision.timeoutMs', label: '判断超时（毫秒）', type: 'number', min: 1000 },
  { path: 'selfDecision.debug', label: '打印判断日志', type: 'checkbox' },
];

// chat 下的全局自我判断字段：服务端只读 chat.selfDecision.*，
// 所以这里统一补上 chat. 前缀。单个 AI 成员的覆盖项挂在成员对象上，不需要前缀。
const CHAT_SELF_DECISION_FIELDS = SELF_DECISION_FIELDS.map((field) =>
  Object.assign({}, field, { path: `chat.${field.path}` })
);

const AI_FIELDS = [
  { path: 'enabled', label: '启用该 AI', type: 'checkbox' },
  { path: 'name', label: '名字', type: 'text' },
  { path: 'id', label: '唯一标识', type: 'text', hint: '留空自动生成；同名会冲突' },
  { path: 'avatar', label: '头像', type: 'text', hint: 'emoji 或 public/avatars 下的文件名' },
  { path: 'persona', label: '人设（系统提示词）', type: 'textarea', wide: true },
  { path: 'historyCount', label: '今日上下文条数上限', type: 'number', min: 1 },
  { path: 'contextHours', label: '历史窗口（已弃用）', type: 'number', hint: '仅保留兼容，当前忽略' },
  { path: 'prefixAiReplies', label: 'AI 历史带时间前缀', type: 'checkbox' },
  { path: 'streamReply', label: '流式回复', type: 'checkbox' },
  { path: 'apiBaseUrl', label: '接口地址', type: 'text', wide: true },
  { path: 'apiKey', label: '接口密钥', type: 'password', wide: true },
  { path: 'model', label: '模型', type: 'text' },
  { path: 'temperature', label: '温度', type: 'number', step: '0.1', min: 0, max: 2 },
  { path: 'maxTokens', label: '最大输出', type: 'number', min: 1 },
  { path: 'timeoutMs', label: '超时（毫秒）', type: 'number', min: 1000 },
];

const USER_FIELDS = [
  { path: 'username', label: '用户名', type: 'text' },
  { path: 'password', label: '密码', type: 'password' },
  { path: 'avatar', label: '头像', type: 'text' },
  {
    path: 'role',
    label: '角色',
    type: 'select',
    options: ['user', 'admin'],
    hint: 'admin 才能进入设置界面',
  },
];

const CHAT_FIELDS = [
  {
    path: 'chat.aiReplyMode',
    label: 'AI 回复模式',
    type: 'select',
    options: ['self', 'hybrid', 'off'],
    hint: 'self = 每个 AI 先判断再回复；hybrid = 随机一位；off = 不自动回复',
  },
  { path: 'chat.silentOnHumanOnlyMention', label: '只 @ 人类时保持沉默', type: 'checkbox' },
  { path: 'chat.aiReplyOnAIMention', label: 'AI @ AI 时触发对方', type: 'checkbox' },
  { path: 'chat.aiMentionMaxHops', label: 'AI 互 @ 最大轮数（hybrid）', type: 'number', min: 0 },
  { path: 'chat.everyoneMaxHops', label: '@所有人 额外触发轮数', type: 'number', min: 0 },
  {
    path: 'chat.everyoneKeywords',
    label: '@所有人 关键词',
    type: 'stringList',
    wide: true,
    hint: '每行一个，例如 @所有人',
  },
  { path: 'chat.displayHours', label: '显示窗口（已弃用）', type: 'number', hint: '仅保留兼容，当前忽略' },
  { path: 'chat.storageDir', label: '消息存储目录', type: 'text', hint: '修改后需要重启服务' },
  {
    path: 'chat.storageFile',
    label: '旧版单文件路径',
    type: 'text',
    hint: '仅用于首次迁移，修改后需要重启服务',
  },
];

const MEMORY_FIELDS = [
  { path: 'memory.enabled', label: '启用长期记忆', type: 'checkbox' },
  { path: 'memory.debug', label: '打印压缩日志', type: 'checkbox' },
  { path: 'memory.backfillOnStartup', label: '启动时补齐历史记忆', type: 'checkbox' },
  { path: 'memory.apiBaseUrl', label: '接口地址（留空继承 AI）', type: 'text', wide: true },
  { path: 'memory.apiKey', label: '接口密钥（留空继承 AI）', type: 'password', wide: true },
  { path: 'memory.model', label: '模型', type: 'text' },
  { path: 'memory.temperature', label: '温度', type: 'number', step: '0.1', min: 0, max: 2 },
  { path: 'memory.maxTokens', label: '最大输出', type: 'number', min: 1 },
  { path: 'memory.timeoutMs', label: '超时（毫秒）', type: 'number', min: 1000 },
  { path: 'memory.maxInputChars', label: '单次输入字符上限', type: 'number', min: 1000 },
  { path: 'memory.storageDir', label: '记忆目录', type: 'text', hint: '修改后需要重启服务' },
];

const MEMORY_BUDGET_FIELDS = [
  { path: 'memory.budgets.daily', label: '日记忆 tokens', type: 'number', min: 1 },
  { path: 'memory.budgets.weekly', label: '周记忆 tokens', type: 'number', min: 1 },
  { path: 'memory.budgets.monthly', label: '月记忆 tokens', type: 'number', min: 1 },
  { path: 'memory.budgets.quarter', label: '季记忆 tokens', type: 'number', min: 1 },
  { path: 'memory.budgets.year', label: '年记忆 tokens', type: 'number', min: 1 },
];

const MEMORY_THINKING_FIELDS = [
  { path: 'memory.thinking.enabled', label: '启用思考模型', type: 'checkbox' },
  {
    path: 'memory.thinking.effort',
    label: '思考强度',
    type: 'select',
    options: ['low', 'medium', 'high'],
  },
  { path: 'memory.thinking.sendEffort', label: '发送 reasoning_effort', type: 'checkbox' },
];

// ---------------- 渲染 ----------------

function renderField(target, field) {
  const wrap = el('label', `field field-${field.type || 'text'}`);
  if (field.wide) wrap.classList.add('field-wide');

  const head = el('span', 'field-label', field.label);
  wrap.appendChild(head);

  const value = getPath(target, field.path);
  let input;

  if (field.type === 'checkbox') {
    const box = el('span', 'field-check');
    input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true;
    box.appendChild(input);
    box.appendChild(el('span', 'field-check-text', value === true ? '已启用' : '已关闭'));
    input.addEventListener('change', () => {
      setPath(target, field.path, input.checked);
      box.querySelector('.field-check-text').textContent = input.checked ? '已启用' : '已关闭';
    });
    wrap.appendChild(box);
  } else if (field.type === 'select') {
    input = document.createElement('select');
    for (const option of field.options || []) {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      input.appendChild(opt);
    }
    input.value = value == null ? '' : String(value);
    input.addEventListener('change', () => setPath(target, field.path, input.value));
    wrap.appendChild(input);
  } else if (field.type === 'textarea') {
    input = document.createElement('textarea');
    input.rows = 4;
    input.value = value == null ? '' : String(value);
    input.addEventListener('input', () => setPath(target, field.path, input.value));
    wrap.appendChild(input);
  } else if (field.type === 'stringList') {
    input = document.createElement('textarea');
    input.rows = 3;
    input.value = Array.isArray(value) ? value.join('\n') : String(value || '');
    input.addEventListener('input', () => {
      const list = input.value
        .split(/[\n,，]/)
        .map((item) => item.trim())
        .filter(Boolean);
      setPath(target, field.path, list);
    });
    wrap.appendChild(input);
  } else {
    input = document.createElement('input');
    input.type = field.type === 'password' && !state.revealSecrets ? 'password' : field.type === 'number' ? 'number' : 'text';
    if (field.type === 'number') {
      if (field.step) input.step = field.step;
      if (field.min !== undefined) input.min = String(field.min);
      if (field.max !== undefined) input.max = String(field.max);
    }
    input.value = value == null ? '' : String(value);
    input.addEventListener('input', () => {
      if (field.type === 'number') {
        // 清空数字框 = 交回默认值：置为 undefined，序列化时该字段会被整个省略，
        // 服务端便会回退到 config.js / 内置默认，而不是把空串当成 0。
        setPath(target, field.path, input.value === '' ? undefined : Number(input.value));
      } else {
        setPath(target, field.path, input.value);
      }
    });
    wrap.appendChild(input);
  }

  if (field.hint) wrap.appendChild(el('span', 'field-hint', field.hint));
  return wrap;
}

function renderFields(container, target, fields) {
  const grid = el('div', 'field-grid');
  for (const field of fields) grid.appendChild(renderField(target, field));
  container.appendChild(grid);
}

function renderGroup(container, title, target, fields, open) {
  const details = document.createElement('details');
  details.className = 'field-group';
  if (open) details.open = true;
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  renderFields(details, target, fields);
  container.appendChild(details);
}

function renderSection(section) {
  const wrap = el('section', 'settings-section');
  const head = el('header', 'settings-section-head');
  head.appendChild(el('h2', null, section.title));
  if (section.desc) head.appendChild(el('p', 'settings-section-desc', section.desc));
  wrap.appendChild(head);

  const body = el('div', 'settings-section-body');
  wrap.appendChild(body);

  if (section.list) {
    renderListSection(body, section);
  } else {
    renderFields(body, state.config, section.fields);
    if (section.groups) {
      for (const group of section.groups) {
        renderGroup(body, group.title, state.config, group.fields, group.open !== false);
      }
    }
  }
  return wrap;
}

function renderListSection(container, section) {
  const list = Array.isArray(getPath(state.config, section.list)) ? getPath(state.config, section.list) : [];
  const toolbar = el('div', 'settings-list-toolbar');
  toolbar.appendChild(el('span', 'settings-list-count', `共 ${list.length} 项`));
  const addBtn = el('button', 'settings-btn small', `+ 添加${section.itemName || '一项'}`);
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    list.push(section.createItem());
    setPath(state.config, section.list, list);
    renderAll();
  });
  toolbar.appendChild(addBtn);
  container.appendChild(toolbar);

  if (list.length === 0) {
    container.appendChild(el('p', 'settings-empty', '暂无内容'));
    return;
  }

  const cards = el('div', 'settings-list');
  list.forEach((item, index) => {
    const card = el('div', 'settings-card');
    const cardHead = el('div', 'settings-card-head');
    cardHead.appendChild(el('span', 'settings-card-title', section.itemTitle(item, index)));
    const removeBtn = el('button', 'settings-btn small danger', '删除');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => {
      if (!window.confirm(`确定删除「${section.itemTitle(item, index)}」吗？`)) return;
      list.splice(index, 1);
      setPath(state.config, section.list, list);
      renderAll();
    });
    cardHead.appendChild(removeBtn);
    card.appendChild(cardHead);

    renderFields(card, item, section.fields);
    if (section.groups) {
      for (const group of section.groups) {
        renderGroup(card, group.title, item, group.fields, group.open === true);
      }
    }
    cards.appendChild(card);
  });
  container.appendChild(cards);
}

function createUser() {
  return { username: '', password: '', avatar: '🙂', role: 'user' };
}

function createAi() {
  return {
    enabled: true,
    id: '',
    name: '',
    avatar: '🤖',
    persona: '',
    historyCount: 1024,
    prefixAiReplies: true,
    streamReply: false,
    apiBaseUrl: '',
    apiKey: '',
    model: '',
    temperature: 0.8,
    maxTokens: 3000,
    timeoutMs: 60000,
    thinking: { enabled: false, effort: 'medium', sendEffort: false },
  };
}

const SCHEMA = [
  {
    id: 'basic',
    title: '基础',
    desc: '端口、监听地址与登录态有效期',
    fields: [
      { path: 'port', label: '端口', type: 'number', min: 1, max: 65535, hint: '修改后需要重启服务' },
      {
        path: 'host',
        label: '监听地址',
        type: 'text',
        hint: '127.0.0.1 仅本机；0.0.0.0 允许局域网（修改后需要重启服务）',
      },
      { path: 'sessionDays', label: '登录态有效期（天）', type: 'number', step: '0.1', min: 0.1 },
      {
        path: 'trustProxy',
        label: '信任反向代理（读取 X-Forwarded-For）',
        type: 'checkbox',
        hint: '仅在可信反代之后开启，直连公网时请关闭',
      },
    ],
  },
  {
    id: 'users',
    title: '登录账号',
    desc: '修改密码或取消 admin 会让该账号立即下线',
    list: 'users',
    itemName: '账号',
    itemTitle: (item, index) => String(item.username || `账号 ${index + 1}`),
    createItem: createUser,
    fields: USER_FIELDS,
  },
  {
    id: 'ais',
    title: 'AI 成员',
    desc: '每位成员的接口、模型、人设与自我判断覆盖项',
    list: 'ais',
    itemName: 'AI 成员',
    itemTitle: (item, index) => String(item.name || `AI 成员 ${index + 1}`),
    createItem: createAi,
    fields: AI_FIELDS,
    groups: [
      { title: '思考模型', fields: THINKING_FIELDS },
      { title: '自我判断覆盖（可选）', fields: SELF_DECISION_FIELDS },
    ],
  },
  {
    id: 'chat',
    title: '聊天与回复',
    desc: '回复模式、@ 规则与消息存储位置',
    fields: CHAT_FIELDS,
    groups: [{ title: '自我判断（self 模式）', fields: CHAT_SELF_DECISION_FIELDS, open: true }],
  },
  {
    id: 'memory',
    title: '长期记忆',
    desc: '分层压缩模型与各层 token 预算',
    fields: MEMORY_FIELDS,
    groups: [
      { title: '各层 token 预算', fields: MEMORY_BUDGET_FIELDS, open: true },
      { title: '思考模型', fields: MEMORY_THINKING_FIELDS },
    ],
  },
];

function renderAll() {
  sectionsEl.textContent = '';
  for (const section of SCHEMA) sectionsEl.appendChild(renderSection(section));
}

function renderMeta() {
  const meta = state.meta || {};
  const parts = [];
  if (meta.baseFile) parts.push(`默认配置 ${meta.baseFile}`);
  parts.push(meta.hasOverride ? `已保存到 ${meta.settingsFile}` : '当前未保存过覆盖配置');
  if (meta.adminUsers && meta.adminUsers.length) parts.push(`admin：${meta.adminUsers.join('、')}`);
  metaEl.textContent = parts.join(' · ');
}

// ---------------- 数据加载与保存 ----------------

async function loadSettings() {
  setBusy(true);
  try {
    const res = await fetch('/api/settings', { credentials: 'same-origin', cache: 'no-store' });
    if (redirectIfInvalid(res)) return;
    if (!res.ok) {
      setStatus('加载配置失败', 'error');
      return;
    }
    const data = await res.json();
    state.config = data.config || {};
    state.meta = data.meta || {};
    renderMeta();
    renderAll();
    setStatus('配置已加载', 'info');
  } catch (_err) {
    setStatus('网络错误，请稍后重试', 'error');
  } finally {
    setBusy(false);
  }
}

function afterSave(data) {
  if (data.config) state.config = data.config;
  state.meta = Object.assign({}, state.meta, { hasOverride: true });
  renderMeta();
  renderAll();
  const messages = ['已保存并立即应用'];
  if (Array.isArray(data.forcedLogout) && data.forcedLogout.length) {
    const self = (state.meta && state.meta.currentUser) || '';
    messages.push(`已强制下线：${data.forcedLogout.join('、')}`);
    if (data.forcedLogout.includes(self)) messages.push('你修改了自己的账号，需要重新登录');
  }
  if (Array.isArray(data.restartRequired) && data.restartRequired.length) {
    messages.push(`需重启生效：${data.restartRequired.join('、')}`);
  }
  setStatus(messages.join('；'), 'success', true);
}

async function saveSettings() {
  if (state.busy || !state.config) return;
  setBusy(true);
  setStatus('保存中…', 'info', true);
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ config: state.config }),
    });
    if (redirectIfInvalid(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const errors = Array.isArray(data.errors) ? data.errors : [];
      setStatus(errors.length ? `保存失败：${errors.join('；')}` : data.message || '保存失败', 'error', true);
      return;
    }
    afterSave(data);
  } catch (_err) {
    setStatus('网络错误，保存失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function resetSettings() {
  if (state.busy) return;
  if (!window.confirm('确定恢复为 config.js 的默认配置吗？当前保存的覆盖配置会被删除。')) return;
  setBusy(true);
  setStatus('恢复中…', 'info', true);
  try {
    const res = await fetch('/api/settings/reset', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (redirectIfInvalid(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      setStatus(data.message || '恢复默认失败', 'error', true);
      return;
    }
    if (data.config) state.config = data.config;
    state.meta = Object.assign({}, state.meta, { hasOverride: false });
    renderMeta();
    renderAll();
    setStatus('已恢复默认配置', 'success');
  } catch (_err) {
    setStatus('网络错误，恢复失败', 'error');
  } finally {
    setBusy(false);
  }
}

async function importSettings(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    setStatus('导入失败：不是合法的 JSON', 'error', true);
    return;
  }
  setBusy(true);
  setStatus('导入中…', 'info', true);
  try {
    const res = await fetch('/api/settings/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ config: parsed }),
    });
    if (redirectIfInvalid(res)) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const errors = Array.isArray(data.errors) ? data.errors : [];
      setStatus(errors.length ? `导入失败：${errors.join('；')}` : data.message || '导入失败', 'error', true);
      return;
    }
    afterSave(data);
  } catch (_err) {
    setStatus('网络错误，导入失败', 'error');
  } finally {
    setBusy(false);
  }
}

// ---------------- 事件绑定 ----------------

saveBtn.addEventListener('click', saveSettings);
resetBtn.addEventListener('click', resetSettings);
exportBtn.addEventListener('click', () => {
  location.href = '/api/settings/export';
});
importBtn.addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files && importFile.files[0];
  importFile.value = '';
  if (!file) return;
  const text = await file.text();
  importSettings(text);
});
revealSecrets.addEventListener('change', () => {
  state.revealSecrets = revealSecrets.checked;
  renderAll();
});

document.addEventListener('DOMContentLoaded', loadSettings);
