/** 极简工具函数：DOM 构建、格式化、提示。 */

import type { TaskStatus } from './types';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = String(value);
      else if (key === 'text') el.textContent = String(value);
      else if (key === 'html') el.innerHTML = String(value);
      else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else if (key === 'value' && el instanceof HTMLInputElement) el.value = String(value);
      else if (key === 'checked' && el instanceof HTMLInputElement) el.checked = Boolean(value);
      else if (key === 'disabled') el.toggleAttribute('disabled', Boolean(value));
      else if (key === 'selected' && el instanceof HTMLOptionElement) el.selected = Boolean(value);
      else el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const total = Math.round(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0
    ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${mm}:${String(ss).padStart(2, '0')}`;
}

export function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return hh > 0
    ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return '—';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} 天前`;
  return fmtDate(iso);
}

export function fmtElapsed(ms: number | null | undefined): string {
  if (!ms || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s % 60)} 秒`;
}

export const STATUS_TEXT: Record<TaskStatus, string> = {
  queued: '排队中',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
};

export const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: 'info',
  processing: 'brand',
  completed: 'ok',
  failed: 'err',
  canceled: '',
};

export function statusBadge(status: TaskStatus): HTMLElement {
  return h('span', { class: `badge-pill ${STATUS_CLASS[status] ?? ''}` }, STATUS_TEXT[status] ?? status);
}

export function speakerClass(speaker: string | null | undefined): string {
  const m = /(\d+)$/.exec(String(speaker ?? ''));
  const idx = m ? Number(m[1]) % 8 : 0;
  return `spk-${idx}`;
}

export function toast(message: string, kind: 'ok' | 'err' | '' = ''): void {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h('div', { class: `toast ${kind}` }, message);
  root.appendChild(el);
  window.setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    window.setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 5200 : 3000);
}

export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 300): T {
  let timer = 0;
  return ((...args: never[]) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  }) as T;
}

export function download(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
