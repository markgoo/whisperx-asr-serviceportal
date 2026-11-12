/** 账号设置：修改密码、查看会话信息。 */

import { api } from '../api';
import { fmtDate, h, toast } from '../dom';
import { state } from '../store';

export function renderAccount(root: HTMLElement): void {
  root.innerHTML = '';
  const user = state.user;
  if (!user) return;

  const current = h('input', { type: 'password', autocomplete: 'current-password' }) as HTMLInputElement;
  const next = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const again = h('input', { type: 'password', autocomplete: 'new-password' }) as HTMLInputElement;
  const errorBox = h('div', { class: 'alert err', style: 'display:none' });
  const submit = h('button', { class: 'btn primary', type: 'submit' }, '修改密码');

  const form = h(
    'form',
    {
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        errorBox.style.display = 'none';
        if (next.value !== again.value) {
          errorBox.textContent = '两次输入的新密码不一致';
          errorBox.style.display = '';
          return;
        }
        submit.toggleAttribute('disabled', true);
        try {
          await api.changePassword(current.value, next.value);
          toast('密码已修改，其他设备的登录已失效', 'ok');
          current.value = next.value = again.value = '';
        } catch (err) {
          errorBox.textContent = err instanceof Error ? err.message : String(err);
          errorBox.style.display = '';
        } finally {
          submit.toggleAttribute('disabled', false);
        }
      },
    },
    errorBox,
    h('div', { class: 'field' }, h('label', null, '当前密码'), current),
    h('div', { class: 'field' }, h('label', null, '新密码'), next),
    h('div', { class: 'field' }, h('label', null, '确认新密码'), again),
    submit,
  );

  root.appendChild(
    h(
      'div',
      null,
      h(
        'div',
        { style: 'margin-bottom:16px' },
        h('h2', { style: 'margin:0;font-size:17px' }, '账号设置'),
        h('div', { class: 'tiny muted' }, '修改密码与查看账号信息'),
      ),
      h(
        'div',
        { class: 'split' },
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, '修改密码')),
          h('div', { class: 'card-body' }, form),
        ),
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, '账号信息')),
          h(
            'div',
            { class: 'card-body' },
            h(
              'div',
              { class: 'kv' },
              row('用户名', user.username),
              row('显示名称', user.displayName || '—'),
              row(
                '角色',
                user.role === 'superadmin' ? '超级管理员' : user.role === 'admin' ? '管理员' : '普通用户',
              ),
              row('状态', user.status === 'active' ? '正常' : '已禁用'),
              row('创建时间', fmtDate(user.createdAt)),
              row('最近登录', user.lastLoginAt ? fmtDate(user.lastLoginAt) : '—'),
            ),
          ),
        ),
      ),
    ),
  );
}

function row(label: string, value: string): HTMLElement {
  return h(
    'div',
    { style: 'display:contents' },
    h('dt', null, label),
    h('dd', null, value),
  );
}
