/** 任务列表页。 */

import { api } from '../api';
import {
  debounce,
  fmtBytes,
  fmtDate,
  fmtDuration,
  h,
  statusBadge,
  STATUS_TEXT,
  toast,
} from '../dom';
import { confirmDialog } from '../ui';
import { isAdmin, navigate, state } from '../store';
import type { Task, TaskListResponse, TaskStatus } from '../types';

const PAGE_SIZE = 20;

const filters: { status: string; search: string; scope: string; page: number } = {
  status: '',
  search: '',
  scope: 'all',
  page: 1,
};

export async function renderTasks(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  const container = h('div');
  root.appendChild(container);

  const reload = async (): Promise<void> => {
    let data: TaskListResponse;
    try {
      data = await api.listTasks({
        page: filters.page,
        pageSize: PAGE_SIZE,
        status: filters.status,
        search: filters.search,
        scope: filters.scope,
      });
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
      return;
    }
    draw(container, data, reload);
  };

  await reload();
}

function draw(root: HTMLElement, data: TaskListResponse, reload: () => Promise<void>): void {
  root.innerHTML = '';

  const statusOptions: { value: string; label: string }[] = [
    { value: '', label: `全部 (${data.total})` },
    ...(['queued', 'processing', 'completed', 'failed', 'canceled'] as TaskStatus[]).map((s) => ({
      value: s,
      label: `${STATUS_TEXT[s]} (${data.byStatus[s] ?? 0})`,
    })),
  ];

  const statusSelect = h(
    'select',
    {
      onchange: (ev: Event) => {
        filters.status = (ev.target as HTMLSelectElement).value;
        filters.page = 1;
        void reload();
      },
    },
    ...statusOptions.map((o) => h('option', { value: o.value, selected: o.value === filters.status }, o.label)),
  ) as HTMLSelectElement;

  const searchInput = h('input', {
    type: 'search',
    placeholder: '搜索标题、文件名或转写内容…',
    value: filters.search,
  }) as HTMLInputElement;
  searchInput.addEventListener(
    'input',
    debounce(() => {
      filters.search = searchInput.value.trim();
      filters.page = 1;
      void reload();
    }, 350),
  );

  const head = h(
    'div',
    { class: 'card-head' },
    h('h2', null, '任务列表'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn primary', onclick: () => navigate('/new') }, '＋ 新建任务'),
  );

  const filterBar = h(
    'div',
    { class: 'filters' },
    statusSelect,
    isAdmin()
      ? h(
          'select',
          {
            onchange: (ev: Event) => {
              filters.scope = (ev.target as HTMLSelectElement).value;
              filters.page = 1;
              void reload();
            },
          },
          h('option', { value: 'all', selected: filters.scope === 'all' }, '全部用户的任务'),
          h('option', { value: 'mine', selected: filters.scope === 'mine' }, '只看我的'),
        )
      : null,
    searchInput,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm ghost', onclick: () => void reload() }, '刷新'),
  );

  const body = data.tasks.length
    ? h(
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
              h('th', null, '任务'),
              h('th', null, '状态'),
              isAdmin() ? h('th', null, '所有者') : null,
              h('th', null, '说话人'),
              h('th', { class: 'num' }, '大小'),
              h('th', null, '时长'),
              h('th', null, '创建时间'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...data.tasks.map((t) => taskRow(t, reload)),
          ),
        ),
      )
    : h(
        'div',
        { class: 'empty' },
        h('div', { class: 'big' }, '📭'),
        h('div', null, filters.search || filters.status ? '没有符合条件的任务' : '还没有任务'),
        h(
          'div',
          { style: 'margin-top:12px' },
          h('button', { class: 'btn primary', onclick: () => navigate('/new') }, '＋ 新建任务'),
        ),
      );

  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const pager = h(
    'div',
    { class: 'pager' },
    h('span', { class: 'tiny muted' }, `共 ${data.total} 个任务，第 ${data.page} / ${totalPages} 页`),
    h('div', { class: 'spacer' }),
    h(
      'button',
      {
        class: 'btn sm',
        disabled: data.page <= 1,
        onclick: () => {
          filters.page = Math.max(1, data.page - 1);
          void reload();
        },
      },
      '上一页',
    ),
    h(
      'button',
      {
        class: 'btn sm',
        disabled: data.page >= totalPages,
        onclick: () => {
          filters.page = Math.min(totalPages, data.page + 1);
          void reload();
        },
      },
      '下一页',
    ),
  );

  root.appendChild(
    h(
      'div',
      { class: 'card' },
      head,
      filterBar,
      body,
      data.tasks.length ? pager : null,
    ),
  );

  // Live refresh while anything is still running.
  if ((data.byStatus.queued ?? 0) + (data.byStatus.processing ?? 0) > 0) {
    window.setTimeout(() => {
      if (document.body.contains(root)) void reload();
    }, 4000);
  }
}

function taskRow(t: Task, reload: () => Promise<void>): HTMLElement {
  const running = t.status === 'queued' || t.status === 'processing';
  return h(
    'tr',
    null,
    h(
      'td',
      { style: 'cursor:pointer', onclick: () => navigate(`/tasks/${t.id}`) },
      h('div', { class: 'ellipsis', style: 'max-width:340px;font-weight:600' }, t.title),
      h(
        'div',
        { class: 'tiny muted ellipsis', style: 'max-width:340px' },
        `${t.originalName} · #${t.id}${t.diarize ? ' · 说话人分离' : ''}`,
      ),
      running
        ? h(
            'div',
            { style: 'margin-top:6px;max-width:220px' },
            h('div', { class: 'tiny muted' }, `${t.stage} · ${t.progress}%`),
            h('div', { class: 'progress' }, h('span', { style: `width:${t.progress}%` })),
          )
        : t.status === 'failed'
          ? h('div', { class: 'tiny', style: 'color:var(--err);max-width:340px' }, t.errorMessage || '转写失败')
          : null,
    ),
    h('td', { 'data-label': '状态' }, statusBadge(t.status)),
    isAdmin() ? h('td', { class: 'tiny muted nowrap', 'data-label': '所有者' }, t.ownerName || '—') : null,
    h('td', { class: 'nowrap', 'data-label': '说话人' }, t.diarize ? `${t.speakerCount || '—'} 人` : h('span', { class: 'muted' }, '未分离')),
    h('td', { class: 'num nowrap', 'data-label': '大小' }, fmtBytes(t.fileSize)),
    h('td', { class: 'nowrap', 'data-label': '时长' }, fmtDuration(t.duration)),
    h('td', { class: 'nowrap tiny muted', 'data-label': '创建时间' }, fmtDate(t.createdAt)),
    h(
      'td',
      { class: 'nowrap' },
      h(
        'div',
        { class: 'row', style: 'gap:4px;justify-content:flex-end' },
        running
          ? h(
              'button',
              {
                class: 'btn sm ghost',
                onclick: async (ev: Event) => {
                  ev.stopPropagation();
                  try {
                    await api.cancelTask(t.id);
                    toast('已取消', 'ok');
                    void reload();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'err');
                  }
                },
              },
              '取消',
            )
          : h(
              'button',
              {
                class: 'btn sm ghost',
                onclick: (ev: Event) => {
                  ev.stopPropagation();
                  navigate(`/tasks/${t.id}`);
                },
              },
              '查看',
            ),
        h(
          'button',
          {
            class: 'btn sm ghost',
            title: '删除任务',
            onclick: async (ev: Event) => {
              ev.stopPropagation();
              const ok = await confirmDialog('删除任务', `确定删除「${t.title}」？录音文件和转写结果都会被删除。`, '删除', true);
              if (!ok) return;
              try {
                await api.deleteTask(t.id);
                toast('任务已删除', 'ok');
                void reload();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'err');
              }
            },
          },
          '🗑',
        ),
      ),
    ),
  );
}
