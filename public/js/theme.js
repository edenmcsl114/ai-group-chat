/* =========================================================
   主题（浅色 / 深色 / 跟随系统）
   ---------------------------------------------------------
   在 <head> 里同步加载：先把 <html data-theme> 写好再渲染页面，
   避免出现主题闪烁（FOUC）。按钮 #themeToggle 由本文件统一接管，
   这样聊天页、设置页、登录页三处行为一致。
   ========================================================= */
(function () {
  'use strict';

  var STORAGE_KEY = 'ai-group-chat:theme';
  var MODES = ['system', 'light', 'dark'];
  var LABELS = { system: '跟随系统', light: '浅色', dark: '深色' };
  var ICONS = { system: '🌗', light: '☀️', dark: '🌙' };
  var THEME_COLORS = { light: '#eaeef7', dark: '#080b13' };

  var root = document.documentElement;
  var media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;

  function readMode() {
    try {
      var saved = window.localStorage.getItem(STORAGE_KEY);
      return MODES.indexOf(saved) !== -1 ? saved : 'system';
    } catch (_err) {
      return 'system';
    }
  }

  function saveMode(mode) {
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch (_err) {
      /* 隐私模式下写不了也不影响本次会话 */
    }
  }

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return media && media.matches ? 'dark' : 'light';
  }

  function currentMode() {
    return root.getAttribute('data-theme-mode') || readMode();
  }

  function paintButton(mode) {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      var btn = buttons[i];
      btn.textContent = ICONS[mode] || ICONS.system;
      btn.title = '主题：' + (LABELS[mode] || LABELS.system) + '（点击切换）';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('data-theme-state', mode);
    }
  }

  function apply(mode) {
    var next = MODES.indexOf(mode) !== -1 ? mode : readMode();
    var resolved = resolve(next);
    root.setAttribute('data-theme', resolved);
    root.setAttribute('data-theme-mode', next);

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[resolved] || THEME_COLORS.light);

    paintButton(next);
  }

  function cycle() {
    var mode = currentMode();
    var next = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    saveMode(next);
    apply(next);
  }

  // 首屏立即上色（此时 <body> 还没解析，脚本同步执行即可避免闪烁）
  apply(readMode());

  function bind() {
    var buttons = document.querySelectorAll('[data-theme-toggle]');
    for (var i = 0; i < buttons.length; i += 1) {
      buttons[i].addEventListener('click', cycle);
    }
    paintButton(currentMode());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }

  function onSystemChange() {
    if (currentMode() === 'system') apply('system');
  }
  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onSystemChange);
    } else if (typeof media.addListener === 'function') {
      media.addListener(onSystemChange);
    }
  }

  // 供其它脚本复用（例如以后做「跟随系统」之外的扩展）
  window.AGCTheme = {
    get mode() {
      return currentMode();
    },
    resolved: function () {
      return resolve(currentMode());
    },
    set: function (mode) {
      saveMode(mode);
      apply(mode);
    },
    cycle: cycle,
  };
})();
