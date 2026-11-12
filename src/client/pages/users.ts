/** 用户管理（管理员可见）。 */

import { api } from '../api';
import { fmtBytes, fmtDate, h, toast } from '../dom';
import { confirmDialog, showModal } from '../ui';
import { isSuperadmin, state } from '../store';
import type { PublicUser, Role } from '../types';

const ROLE_TEXT: Record<Role, string> = { superadmin: '超级管理员', admin: '管理员', user: '普通用户' };
const ROLE_CLASS: Record<Role, string> = { superadmin: 'brand', admin: 'info', user: '' };

export async function renderUsers(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'muted' }, '加载中…'));

  let users: PublicUser[];
  try {
    users = (await api.listUsers()).users;
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
    return;
  }

  const reload = (): void => void renderUsers(root);
  root.innerHTML = '';

  const rows = users.map((u) =>
    h(
      'tr',
      null,
      h(
        'td',
        null,
        h('div', { style: 'font-weight:600' }, u.displayName || u.username),
        h('div', { class: 'tiny muted mono' }, u.username),
      ),
      h('td', null, h('span', { class: `badge-pill ${ROLE_CLASS[u.role]}` }, ROLE_TEXT[u.role])),
      h('td', null, h('span', { class: `badge-pill ${u.status === 'active' ? 'ok' : 'err'}` }, u.status === 'active' ? '正常' : '已禁用')),
      h('td', { class: 'num' }, String(u.taskCount ?? 0)),
      h('td', { class: 'num nowrap' }, fmtBytes(u.storageBytes ?? 0)),
      h('td', { class: 'tiny muted nowrap' }, u.lastLoginAt ? fmtDate(u.lastLoginAt) : '从未登录'),
      h(
        'td',
        { class: 'nowrap' },
        h(
          'div',
          { class: 'row', style: 'justify-content:flex-end;gap:4px' },
          h('button', { class: 'btn sm ghost', onclick: () => openEditUser(u, reload) }, '编辑'),
          canDelete(u)
            ? h(
                'button',
                {
                  class: 'btn sm danger',
                  onclick: async () => {
                    const ok = await confirmDialog(
                      '删除用户',
                      `确定删除用户「${u.displayName || u.username}」？其名下 ${u.taskCount ?? 0} 个任务和录音文件都会被永久删除。`,
                      '删除',
                      true,
                    );
                    if (!ok) return;
                    try {
                      await api.deleteUser(u.id);
                      toast('用户已删除', 'ok');
                      reload();
                    } catch (err) {
                      toast(err instanceof Error ? err.message : String(err), 'err');
                    }
                  },
                },
                '删除',
              )
            : null,
        ),
      ),
    ),
  );

  root.appendChild(
    h(
      'div',
      null,
      h(
        'div',
        { class: 'row wrap', style: 'margin-bottom:16px' },
        h(
          'div',
          null,
          h('h2', { style: 'margin:0;font-size:17px' }, '用户管理'),
          h('div', { class: 'tiny muted' }, `共 ${users.length} 个账号，普通用户只能看到自己的任务`),
        ),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn primary', onclick: () => openCreateUser(reload) }, '＋ 新建用户'),
      ),
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'table' },
            h(
              'thead',
              null,
              h(
                'tr',
                null,
                h('th', null, '用户'),
                h('th', null, '角色'),
                h('th', null, '状态'),
                h('th', { class: 'num' }, '任务数'),
                h('th', { class: 'num' }, '占用空间'),
                h('th', null, '最近登录'),
                h('th', null, ''),
              ),
            ),
            h('tbody', null, ...rows),
          ),
        ),
      ),
    ),
  );
}

function canDelete(user: PublicUser): boolean {
  return isSuperadmin() && user.id !== state.user?.id && user.role !== 'superadmin';
}

function roleSelect(value: Role): HTMLSelectElement {
  const select = h(
    'select',
    null,
    h('option', { value: 'user', selected: value === 'user' }, '普通用户'),
    isSuperadmin() ? h('option', { value: 'admin', selected: value === 'admin' }, '管理员') : null,
    isSuperadmin() ? h('option', { value: 'superadmin', selected: value === 'superadmin' }, '超级管理员') : null,
  ) as HTMLSelectElement;
  return select;
}

function openCreateUser(onDone: () => void): void {
  const username = h('input', { type: 'text', placeholder: '登录名，3-32 位字母数字' }) as HTMLInputElement;
  const displayName = h('input', { type: 'text', placeholder: '显示名称，可留空' }) as HTMLInputElement;
  const password = h('input', { type: 'text', placeholder: '至少 6 位' }) as HTMLInputElement;
  const role = roleSelect('user');

  showModal({
    title: '新建用户',
    body: h(
      'div',
      null,
      h('div', { class: 'field' }, h('label', null, '用户名', h('span', { class: 'req' }, '*')), username),
      h('div', { class: 'field' }, h('label', null, '显示名称'), displayName),
      h('div', { class: 'field' }, h('label', null, '初始密码', h('span', { class: 'req' }, '*')), password),
      h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', null, '角色'), role),
    ),
    confirmText: '创建',
    onConfirm: async () => {
      const res = await api.createUser({
        username: username.value.trim(),
        displayName: displayName.value.trim(),
        password: password.value,
        role: role.value,
      });
      toast(`用户 ${res.user.username} 已创建`, 'ok');
      onDone();
    },
  });
}

function openEditUser(user: PublicUser, onDone: () => void): void {
  const displayName = h('input', { type: 'text', value: user.displayName }) as HTMLInputElement;
  const password = h('input', { type: 'text', placeholder: '留空表示不修改' }) as HTMLInputElement;
  const role = roleSelect(user.role);
  const status = h(
    'select',
    null,
    h('option', { value: 'active', selected: user.status === 'active' }, '正常'),
    h('option', { value: 'disabled', selected: user.status === 'disabled' }, '禁用'),
  ) as HTMLSelectElement;

  showModal({
    title: `编辑用户 · ${user.username}`,
    body: h(
      'div',
      null,
      h('div', { class: 'field' }, h('label', null, '显示名称'), displayName),
      h(
        'div',
        { class: 'grid cols-2' },
        h('div', { class: 'field' }, h('label', null, '角色'), role),
        h('div', { class: 'field' }, h('label', null, '状态'), status),
      ),
      h(
        'div',
        { class: 'field', style: 'margin-bottom:0' },
        h('label', null, '重置密码'),
        password,
        h('div', { class: 'hint' }, '修改密码后该用户的所有登录会话会失效'),
      ),
    ),
    confirmText: '保存',
    onConfirm: async () => {
      await api.updateUser(user.id, {
        displayName: displayName.value.trim(),
        role: role.value,
        status: status.value,
        ...(password.value ? { password: password.value } : {}),
      });
      toast('已保存', 'ok');
      onDone();
    },
  });
}
