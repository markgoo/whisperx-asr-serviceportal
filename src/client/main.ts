/** 应用外壳：侧边栏、顶栏、路由分发。 */

import { api } from './api';
import { clear, h, toast } from './dom';
import {
  bootstrap,
  clearSession,
  isAdmin,
  navigate,
  parseHash,
  state,
  type Route,
} from './store';
import { renderLogin } from './pages/login';
import { renderDashboard } from './pages/dashboard';
import { renderTasks } from './pages/tasks';
import { renderTaskDetail } from './pages/taskDetail';
import { renderNewTask } from './pages/newTask';
import { renderStorage } from './pages/storage';
import { renderUsers } from './pages/users';
import { renderSettings } from './pages/settings';
import { renderAccount } from './pages/account';

const app = document.getElementById('app')!;

const TITLES: Record<string, string> = {
  dashboard: '概览',
  tasks: '任务列表',
  task: '任务详情',
  new: '新建任务',
  storage: '存储管理',
  users: '用户管理',
  settings: '系统设置',
  account: '账号设置',
};

function sidebar(active: Route): HTMLElement {
  const link = (hash: string, icon: string, label: string, badge?: string): HTMLElement =>
    h(
      'a',
      {
        href: `#${hash}`,
        class: active.name === hash.replace(/^\//, '') ? 'active' : '',
      },
      h('span', { class: 'ico' }, icon),
      h('span', null, label),
      badge ? h('span', { class: 'badge' }, badge) : null,
    );

  const nav = h(
    'nav',
    { class: 'nav' },
    link('/dashboard', '🏠', '概览'),
    link('/tasks', '📋', '任务'),
    link('/new', '＋', '新建任务'),
    link('/storage', '💾', '存储'),
    isAdmin() ? link('/users', '👥', '用户') : null,
    isAdmin() ? link('/settings', '⚙️', '设置') : null,
    link('/account', '👤', '账号'),
  );

  return h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'brand' },
      h('div', { class: 'logo' }, '🎙'),
      h('div', null, 'WhisperX 门户', h('small', null, '录音转文字')),
    ),
    nav,
    h(
      'div',
      { class: 'sidebar-foot' },
      h('div', { class: 'who' }, state.user?.displayName || state.user?.username || ''),
      h(
        'div',
        { class: 'role' },
        state.user?.role === 'superadmin' ? '超级管理员' : state.user?.role === 'admin' ? '管理员' : '普通用户',
      ),
      h(
        'button',
        {
          class: 'btn sm ghost',
          style: 'color:#9aa4c4;padding-left:0;margin-top:6px',
          onclick: async () => {
            try {
              await api.logout();
            } catch {
              /* ignore */
            }
            clearSession();
            location.hash = '';
            void renderApp();
          },
        },
        '退出登录',
      ),
    ),
  );
}

/** 移动端底部导航：窄屏时侧边栏隐藏，用它来切换页面。 */
function mobileNav(active: Route): HTMLElement {
  const item = (hash: string, icon: string, label: string): HTMLElement =>
    h(
      'a',
      {
        href: `#${hash}`,
        class: active.name === hash.replace(/^\//, '') ? 'active' : '',
      },
      h('span', { class: 'ico' }, icon),
      h('span', null, label),
    );
  return h(
    'nav',
    { class: 'mobile-nav' },
    item('/dashboard', '🏠', '概览'),
    item('/tasks', '📋', '任务'),
    item('/new', '＋', '新建'),
    item('/storage', '💾', '存储'),
    isAdmin() ? item('/settings', '⚙️', '设置') : item('/account', '👤', '账号'),
  );
}

function topbar(route: Route): HTMLElement {
  return h(
    'div',
    { class: 'topbar' },
    h('h1', null, TITLES[route.name] ?? ''),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm primary', onclick: () => navigate('/new') }, '＋ 新建任务'),
  );
}

async function renderApp(): Promise<void> {
  if (!state.user) {
    renderLogin(app, () => void renderApp());
    return;
  }

  const route = parseHash();
  // Guard admin-only pages for ordinary users.
  if ((route.name === 'users' || route.name === 'settings') && !isAdmin()) {
    navigate('/dashboard');
    return;
  }

  const content = h('div', { class: 'content' });
  const main = h('div', { class: 'main' }, topbar(route), content);
  clear(app);
  app.appendChild(h('div', { class: 'layout' }, sidebar(route), main));
  app.appendChild(mobileNav(route));

  try {
    switch (route.name) {
      case 'dashboard':
        await renderDashboard(content);
        break;
      case 'tasks':
        await renderTasks(content);
        break;
      case 'task':
        await renderTaskDetail(content, Number(route.param));
        break;
      case 'new':
        renderNewTask(content);
        break;
      case 'storage':
        await renderStorage(content);
        break;
      case 'users':
        await renderUsers(content);
        break;
      case 'settings':
        await renderSettings(content);
        break;
      case 'account':
        renderAccount(content);
        break;
      default:
        await renderDashboard(content);
    }
  } catch (err) {
    content.innerHTML = '';
    content.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
  }
}

let lastHash = '';

async function start(): Promise<void> {
  try {
    await bootstrap();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'err');
  }

  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    lastHash = location.hash;
    void renderApp();
  });
  lastHash = location.hash;
  await renderApp();
}

void start();
