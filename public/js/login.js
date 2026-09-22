'use strict';

// 若已经登录，直接进入聊天室
async function checkAlreadyLoggedIn() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.ok) {
      location.href = '/';
    }
  } catch (_err) {
    // 网络异常时留在登录页，让用户手动操作
  }
}

function showError(message) {
  const box = document.getElementById('error');
  box.textContent = message;
  box.hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  checkAlreadyLoggedIn();

  const form = document.getElementById('loginForm');
  const button = document.getElementById('loginBtn');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    document.getElementById('error').hidden = true;

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
    if (!username || !password) {
      showError('请输入用户名和密码');
      return;
    }

    button.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        showError(data.message || '登录失败，请重试');
        return;
      }
      location.href = '/';
    } catch (_err) {
      showError('网络错误，请稍后重试');
    } finally {
      button.disabled = false;
    }
  });
});
