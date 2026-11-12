/** 存储管理：占用统计、文件清单、清理。 */

import { api } from '../api';
import { fmtBytes, fmtDate, h, toast } from '../dom';
import { confirmDialog } from '../ui';
import { isAdmin } from '../store';
import type { StorageItem, StorageSummary } from '../types';

export async function renderStorage(root: HTMLElement): Promise<void> {
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'muted' }, '加载中…'));

  let items: StorageItem[];
  let summary: StorageSummary;
  try {
    const data = await api.storage();
    items = data.items;
    summary = data.summary;
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)));
    return;
  }

  const reload = (): void => {
    void renderStorage(root);
  };

  root.innerHTML = '';

  const usedPct = summary.quotaMb > 0
    ? Math.min(100, (summary.totalBytes / (summary.quotaMb * 1024 * 1024)) * 100)
    : 0;
  const diskPct = summary.diskTotalBytes > 0
    ? Math.min(100, ((summary.diskTotalBytes - summary.diskFreeBytes) / summary.diskTotalBytes) * 100)
    : 0;

  const stats = h(
    'div',
    { class: 'grid cols-4' },
    statCard('音频占用', fmtBytes(summary.totalBytes), `${summary.fileCount} 个文件`),
    statCard(
      '剩余配额',
      summary.quotaMb > 0 ? fmtBytes(summary.quotaMb * 1024 * 1024 - summary.totalBytes) : '不限',
      summary.quotaMb > 0 ? `上限 ${summary.quotaMb} MB` : '可在设置中限制',
    ),
    statCard('磁盘可用', fmtBytes(summary.diskFreeBytes), `共 ${fmtBytes(summary.diskTotalBytes)}`),
    statCard('孤立文件', fmtBytes(summary.orphanBytes), `${summary.orphanCount} 个未关联文件`),
  );

  const usageCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', null, '存储使用情况')),
    h(
      'div',
      { class: 'card-body' },
      usageRow('音频配额', summary.quotaMb > 0 ? `${fmtBytes(summary.totalBytes)} / ${summary.quotaMb} MB` : `${fmtBytes(summary.totalBytes)} / 不限制`, usedPct),
      usageRow('服务器磁盘', `${fmtBytes(summary.diskTotalBytes - summary.diskFreeBytes)} / ${fmtBytes(summary.diskTotalBytes)}`, diskPct),
      h(
        'div',
        { class: 'tiny muted', style: 'margin-top:16px;line-height:1.9' },
        h('div', null, '上传目录：', h('span', { class: 'mono' }, summary.uploadDir)),
        h('div', null, '数据库：', h('span', { class: 'mono' }, summary.databasePath)),
      ),
      h(
        'div',
        { class: 'row wrap', style: 'margin-top:16px;gap:8px' },
        summary.orphanCount > 0
          ? h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  const ok = await confirmDialog(
                    '清理孤立文件',
                    `发现 ${summary.orphanCount} 个没有被任何任务引用的文件（共 ${fmtBytes(summary.orphanBytes)}），通常是上传中断留下的。确定删除？`,
                    '删除',
                    true,
                  );
                  if (!ok) return;
                  try {
                    const res = await api.cleanOrphans();
                    toast(`已清理 ${res.removed} 个文件，释放 ${fmtBytes(res.freed)}`, 'ok');
                    reload();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'err');
                  }
                },
              },
              `清理孤立文件 (${summary.orphanCount})`,
            )
          : null,
        isAdmin()
          ? h(
              'button',
              {
                class: 'btn',
                onclick: async () => {
                  const days = window.prompt('删除多少天之前的录音文件？（保留转写文字，填 0 取消）', '30');
                  if (days === null) return;
                  const n = Number(days);
                  if (!Number.isFinite(n) || n <= 0) {
                    if (n === 0) return;
                    toast('请输入大于 0 的天数', 'err');
                    return;
                  }
                  const ok = await confirmDialog(
                    '按时间清理',
                    `将删除 ${n} 天前的所有原始录音文件（转写文字会保留）。此操作不可恢复，确定继续？`,
                    '开始清理',
                    true,
                  );
                  if (!ok) return;
                  try {
                    const res = await api.cleanupByAge(n);
                    toast(`已删除 ${res.removed} 个录音，释放 ${fmtBytes(res.freed)}`, 'ok');
                    reload();
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'err');
                  }
                },
              },
              '按时间清理',
            )
          : null,
      ),
    ),
  );

  const rows = items.length
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
              h('th', null, '文件'),
              h('th', null, '所属任务'),
              isAdmin() ? h('th', null, '上传者') : null,
              h('th', { class: 'num' }, '大小'),
              h('th', null, '上传时间'),
              h('th', null, ''),
            ),
          ),
          h(
            'tbody',
            null,
            ...items.map((item) =>
              h(
                'tr',
                null,
                h(
                  'td',
                  null,
                  h('div', { class: 'ellipsis', style: 'max-width:320px;font-weight:600' }, item.fileName),
                  h('div', { class: 'tiny muted mono' }, item.id.slice(0, 8)),
                ),
                h('td', null, h('a', { href: `#/tasks/${taskIdOf(item)}` }, item.title)),
                isAdmin() ? h('td', { class: 'tiny muted' }, item.ownerName) : null,
                h('td', { class: 'num nowrap' }, fmtBytes(item.size)),
                h('td', { class: 'tiny muted nowrap' }, fmtDate(item.uploadedAt)),
                h(
                  'td',
                  { class: 'nowrap' },
                  h(
                    'div',
                    { class: 'row', style: 'justify-content:flex-end;gap:4px' },
                    h('a', { class: 'btn sm ghost', href: `#/tasks/${taskIdOf(item)}` }, '查看'),
                    h(
                      'button',
                      {
                        class: 'btn sm danger',
                        onclick: async () => {
                          const ok = await confirmDialog(
                            '删除录音文件',
                            `确定删除「${item.fileName}」？转写文字会保留，但录音将无法回放。`,
                            '删除',
                            true,
                          );
                          if (!ok) return;
                          try {
                            await api.deleteStorageFile(taskIdOf(item));
                            toast('已删除', 'ok');
                            reload();
                          } catch (err) {
                            toast(err instanceof Error ? err.message : String(err), 'err');
                          }
                        },
                      },
                      '删除',
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      )
    : h('div', { class: 'empty' }, h('div', { class: 'big' }, '📦'), h('div', null, '还没有保存任何录音文件'));

  root.appendChild(
    h(
      'div',
      null,
      stats,
      h('div', { style: 'height:16px' }),
      usageCard,
      h('div', { style: 'height:16px' }),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', null, '已保存的录音文件')), rows),
    ),
  );
}

function taskIdOf(item: StorageItem): number {
  return item.taskId;
}

function statCard(label: string, value: string, sub = ''): HTMLElement {
  return h(
    'div',
    { class: 'stat' },
    h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value),
    sub ? h('div', { class: 'sub' }, sub) : null,
  );
}

function usageRow(label: string, text: string, pct: number): HTMLElement {
  return h(
    'div',
    { style: 'margin-bottom:14px' },
    h('div', { class: 'row tiny', style: 'margin-bottom:6px' }, h('span', { style: 'font-weight:600' }, label), h('div', { class: 'spacer' }), h('span', { class: 'muted' }, text)),
    h('div', { class: 'progress', style: 'height:8px' }, h('span', { style: `width:${pct}%` })),
  );
}
