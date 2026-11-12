/** 仪表盘。 */

import { api } from '../api';
import { h, fmtBytes, fmtDuration, fmtRelative, statusBadge, fmtClock } from '../dom';
import { isAdmin, navigate, state } from '../store';
import type { Dashboard } from '../types';

export async function renderDashboard(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'muted' }, '加载中…'));

  let data: Dashboard;
  try {
    data = await api.dashboard();
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
    return;
  }

  root.innerHTML = '';
  const s = data.stats;
  const cards = h(
    'div',
    { class: 'grid cols-4' },
    statCard('全部任务', String(data.total), '共处理', true),
    statCard('已完成', String(s.completed ?? 0), `${fmtBytes(data.totalBytes)} 音频`),
    statCard('排队 / 处理中', String((s.queued ?? 0) + (s.processing ?? 0)), `失败 ${s.failed ?? 0} 个`),
    statCard('音频总时长', fmtDuration(data.totalSeconds), isAdmin() ? `${data.userCount} 个活跃用户` : '累计转写'),
  );

  const actions = h(
    'div',
    { class: 'row wrap', style: 'margin:18px 0 6px' },
    h('button', { class: 'btn primary', onclick: () => navigate('/new') }, '＋ 新建转写任务'),
    h('button', { class: 'btn', onclick: () => navigate('/tasks') }, '查看全部任务'),
  );

  const recentBody = data.recent.length
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
              h('th', null, '说话人'),
              h('th', null, '时长'),
              h('th', null, '创建时间'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...data.recent.map((t) =>
              h(
                'tr',
                { style: 'cursor:pointer', onclick: () => navigate(`/tasks/${t.id}`) },
                h('td', null, h('div', { class: 'ellipsis', style: 'max-width:340px;font-weight:600' }, t.title), h('div', { class: 'tiny muted' }, t.originalName)),
                h('td', null, statusBadge(t.status)),
                h('td', null, t.diarize ? `${t.speakerCount || '—'} 人` : h('span', { class: 'muted' }, '未分离')),
                h('td', { class: 'nowrap' }, fmtDuration(t.duration)),
                h('td', { class: 'nowrap muted tiny' }, fmtRelative(t.createdAt)),
                h('td', null, h('span', { class: 'tiny muted' }, `#${t.id}`)),
              ),
            ),
          ),
        ),
      )
    : h(
        'div',
        { class: 'empty' },
        h('div', { class: 'big' }, '🎧'),
        h('div', null, '还没有任务，先上传一段录音试试'),
        h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', onclick: () => navigate('/new') }, '＋ 新建任务')),
      );

  root.appendChild(
    h('div', { class: 'layout-content' }, cards, actions, h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '最近任务')), recentBody)),
  );
}

function statCard(label: string, value: string, sub = '', accent = false): HTMLElement {
  return h(
    'div',
    { class: `stat${accent ? ' accent' : ''}` },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null,
  );
}

export function fmtCountdown(seconds: number): string {
  return fmtClock(Math.max(0, seconds));
}
