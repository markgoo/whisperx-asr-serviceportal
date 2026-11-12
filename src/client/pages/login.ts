/** 登录页。 */

import { api, ApiError } from '../api';
import { h, toast } from '../dom';
import { setSession } from '../store';

export function renderLogin(root: HTMLElement, onSuccess: () => void): void {
  root.innerHTML = '';
  const username = h('input', { type: 'text', placeholder: '用户名', autocomplete: 'username' }) as HTMLInputElement;
  const password = h('input', {
    type: 'password',
    placeholder: '密码',
    autocomplete: 'current-password',
  }) as HTMLInputElement;
  const errorBox = h('div', { class: 'alert err', style: 'display:none' });
  const submit = h('button', { class: 'btn primary block', type: 'submit' }, '登录');

  const form = h(
    'form',
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        submit.toggleAttribute('disabled', true);
        submit.textContent = '登录中…';
        try {
          const { user, settings } = await api.login(username.value.trim(), password.value);
          setSession(user, settings);
          toast(`欢迎回来，${user.displayName || user.username}`, 'ok');
          onSuccess();
        } catch (err) {
          const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
          errorBox.textContent = msg;
          errorBox.style.display = '';
          submit.toggleAttribute('disabled', false);
          submit.textContent = '登录';
        }
      },
    },
    errorBox,
    h('div', { class: 'field' }, h('label', null, '用户名'), username),
    h('div', { class: 'field' }, h('label', null, '密码'), password),
    submit,
  );

  root.appendChild(
    h(
      'div',
      { class: 'login-wrap' },
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'login-logo' }, '🎙'),
        h('h1', null, 'WhisperX 录音转文字'),
        h('p', { class: 'sub' }, '上传录音，自动转写并区分说话人'),
        form,
        h(
          'p',
          { class: 'tiny muted', style: 'margin:16px 0 0;text-align:center' },
          '首次使用请用管理员分配的账号登录',
        ),
      ),
    ),
  );
  username.focus();
}
