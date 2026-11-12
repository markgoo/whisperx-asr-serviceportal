/** 任务详情：播放器与转写文本联动、按说话人筛选、导出。 */

import { api } from '../api';
import {
  fmtBytes,
  fmtClock,
  fmtDate,
  fmtDuration,
  fmtElapsed,
  fmtRelative,
  h,
  speakerClass,
  statusBadge,
  toast,
} from '../dom';
import { promptDialog, showModal } from '../ui';
import { navigate } from '../store';
import type { Segment, TaskDetail } from '../types';

let pollTimer = 0;

function kv(label: string, value: string | HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'kv-row' },
    h('span', { class: 'kv-label' }, label),
    h('span', { class: 'kv-value' }, value),
  );
}

/** 说话人颜色盘，和 CSS 里的 --spk-N 对应。 */
const SPEAKER_COLORS = [
  '#4f46e5', '#0891b2', '#b45309', '#be185d',
  '#15803d', '#7c3aed', '#0f766e', '#a16207',
];

export async function renderTaskDetail(root: HTMLElement, id: number): Promise<void> {
  window.clearTimeout(pollTimer);
  root.innerHTML = '';
  root.appendChild(h('div', { class: 'muted' }, '加载中…'));

  let task: TaskDetail;
  try {
    task = (await api.getTask(id)).task;
  } catch (err) {
    root.innerHTML = '';
    root.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h('div', { class: 'alert err' }, err instanceof Error ? err.message : String(err)),
          h('button', { class: 'btn', onclick: () => navigate('/tasks') }, '返回任务列表'),
        ),
      ),
    );
    return;
  }

  root.innerHTML = '';
  const running = task.status === 'queued' || task.status === 'processing';

  // ---- header ------------------------------------------------------------
  root.appendChild(
    h(
      'div',
      { class: 'row wrap', style: 'margin-bottom:16px;align-items:flex-start;gap:12px' },
      h(
        'div',
        { style: 'min-width:0;flex:1' },
        h('div', { class: 'row', style: 'gap:10px' }, h('h2', { style: 'margin:0;font-size:19px' }, task.title), statusBadge(task.status)),
        h(
          'div',
          { class: 'tiny muted', style: 'margin-top:4px' },
          `${task.originalName} · 任务 #${task.id} · ${fmtDate(task.createdAt)}`,
        ),
      ),
      h(
        'div',
        { class: 'row', style: 'gap:8px;flex-wrap:wrap' },
        h('button', { class: 'btn sm', onclick: () => navigate('/tasks') }, '← 返回'),
        h(
          'button',
          {
            class: 'btn sm',
            onclick: async () => {
              const title = await promptDialog('重命名任务', '任务名称', task.title);
              if (!title) return;
              try {
                await api.renameTask(task.id, title);
                toast('已保存', 'ok');
                void renderTaskDetail(root, task.id);
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'err');
              }
            },
          },
          '重命名',
        ),
        h(
          'button',
          {
            class: 'btn sm',
            title: '用当前设置里的术语词典重新整理已有文字，不会重新转写',
            onclick: async () => {
              try {
                await api.reprocessTask(task.id);
                toast('已重新应用修正', 'ok');
                void renderTaskDetail(root, task.id);
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'err');
              }
            },
          },
          '重新修正',
        ),
        running
          ? h(
              'button',
              {
                class: 'btn sm danger',
                onclick: async () => {
                  try {
                    await api.cancelTask(task.id);
                    toast('已取消', 'ok');
                    void renderTaskDetail(root, task.id);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'err');
                  }
                },
              },
              '取消任务',
            )
          : h(
              'button',
              {
                class: 'btn sm',
                onclick: async () => {
                  try {
                    await api.retryTask(task.id);
                    toast('已重新排队', 'ok');
                    void renderTaskDetail(root, task.id);
                  } catch (err) {
                    toast(err instanceof Error ? err.message : String(err), 'err');
                  }
                },
              },
              '重新转写',
            ),
      ),
    ),
  );

  // ---- running -----------------------------------------------------------
  if (running) {
    root.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h(
            'div',
            { class: 'row' },
            h('span', { style: 'font-size:22px' }, '⏳'),
            h(
              'div',
              null,
              h('div', { style: 'font-weight:600' }, task.status === 'queued' ? '排队中，等待 GPU 空闲' : '正在转写中'),
              h('div', { class: 'tiny muted' }, '处理时间取决于录音长度、模型大小和队列情况，可以先去忙别的'),
            ),
          ),
          h(
            'div',
            { style: 'margin-top:14px' },
            h('div', { class: 'progress', style: 'height:8px' }, h('span', { style: `width:${Math.max(4, task.progress)}%` })),
            h('div', { class: 'tiny muted', style: 'margin-top:8px' }, `${task.stage} · ${task.progress}%`),
          ),
          h('div', { class: 'tiny muted', style: 'margin-top:16px' }, task.diarize ? '本次已启用说话人分离' : '本次未启用说话人分离'),
        ),
      ),
    );
    pollTimer = window.setTimeout(() => {
      if (document.body.contains(root)) void renderTaskDetail(root, id);
    }, 2500);
    return;
  }

  // ---- failed ------------------------------------------------------------
  if (task.status === 'failed') {
    root.appendChild(
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-body' },
          h('div', { class: 'alert err' }, task.errorMessage || '转写失败，原因未知'),
          h(
            'div',
            { class: 'tiny muted' },
            '常见原因：ASR 服务未启动或地址不对、说话人分离模型未授权（HF_TOKEN 缺失）、音频过大导致显存不足。修复后点「重新转写」即可。',
          ),
        ),
      ),
    );
    return;
  }

  // ---- completed ---------------------------------------------------------
  renderResult(root, task);
}

function renderResult(root: HTMLElement, task: TaskDetail): void {
  // 说话人编号 -> 显示名（优先用用户起的名字）+ 颜色
  const speakerOrder: string[] = [];
  for (const seg of task.segments) {
    if (seg.speaker && !speakerOrder.includes(seg.speaker)) speakerOrder.push(seg.speaker);
  }
  const customNames: Record<string, string> = { ...(task.speakerNames || {}) };
  const speakerName = new Map<string, string>();
  const speakerColor = new Map<string, string>();
  speakerOrder.forEach((spk, i) => {
    speakerName.set(spk, customNames[spk] || `说话人 ${i + 1}`);
    speakerColor.set(spk, SPEAKER_COLORS[i % SPEAKER_COLORS.length]);
  });
  const labelOf = (spk: string | null | undefined): string =>
    (spk && speakerName.get(spk)) || spk || '未知';
  const colorOf = (spk: string | null | undefined): string =>
    (spk && speakerColor.get(spk)) || '#6b7280';

  /**
   * 只改某一个说话人的名字。
   * 传入原始标签，保存时以「当前已有的名字」为基础改动这一条，不会影响别人。
   */
  const openRenameOne = (spk: string): void => {
    const input = h('input', {
      type: 'text',
      value: customNames[spk] || '',
      placeholder: labelOf(spk),
      maxlength: '40',
    }) as HTMLInputElement;

    showModal({
      title: `修改「${labelOf(spk)}」的名字`,
      body: h(
        'div',
        null,
        h(
          'div',
          { class: 'row', style: 'gap:8px;margin-bottom:12px' },
          h('span', { class: 'chip-dot', style: `background:${colorOf(spk)}` }),
          h('span', { class: 'tiny muted' }, `原标签 ${spk}`),
        ),
        h('div', { class: 'field', style: 'margin-bottom:0' }, h('label', null, '显示为'), input),
        h(
          'div',
          { class: 'hint', style: 'margin-top:8px' },
          '这个名字会用在对话视图、筛选标签、发言统计和导出的 SRT/TXT 里。留空恢复默认。',
        ),
      ),
      confirmText: '保存',
      onConfirm: async () => {
        const next: Record<string, string> = { ...customNames };
        const value = input.value.trim();
        if (value) next[spk] = value;
        else delete next[spk];
        try {
          await api.renameSpeakers(task.id, next);
          toast('已保存', 'ok');
          void renderTaskDetail(root, task.id);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err), 'err');
        }
      },
    });
    setTimeout(() => input.focus(), 30);
  };

  // ---- 播放器 ------------------------------------------------------------
  const hasAudio = task.hasFile;
  const audio = h('audio', {
    preload: 'metadata',
    src: `/api/tasks/${task.id}/audio`,
  }) as HTMLAudioElement;
  audio.style.display = 'none';

  const followToggle = h('input', { type: 'checkbox', checked: true }) as HTMLInputElement;

  // 自定义播放器：顶部大号显示「当前在说什么」，下面是可拖动的进度条
  const curTimeEl = h('div', { class: 'player-time-cur' }, '00:00');
  const totalTimeEl = h('div', { class: 'player-time-total' }, fmtClock(task.duration || 0));
  const curSpeakerEl = h('div', { class: 'player-speaker' }, '—');
  const curTextEl = h('div', { class: 'player-text' }, hasAudio ? '点上方任意一句，从那里开始播放' : '录音文件已被清理，无法回放');
  const barFill = h('span', { style: 'width:0%' });
  const bar = h('div', { class: 'player-bar' }, barFill);
  const playBtn = h('button', { class: 'player-play', type: 'button', title: '播放/暂停' }, '▶');

  const seekTo = (ratio: number): void => {
    if (!hasAudio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, audio.duration * ratio));
    syncPlayer();
  };

  bar.addEventListener('click', (ev: MouseEvent) => {
    const rect = bar.getBoundingClientRect();
    seekTo((ev.clientX - rect.left) / rect.width);
  });

  playBtn.addEventListener('click', () => {
    if (!hasAudio) return;
    if (audio.paused) void audio.play().catch(() => undefined);
    else audio.pause();
  });

  const skipBtn = (delta: number, label: string): HTMLElement =>
    h(
      'button',
      {
        class: 'player-skip',
        type: 'button',
        title: label,
        onclick: () => {
          if (!hasAudio) return;
          audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
          syncPlayer();
        },
      },
      label,
    );

  // ---- 说话人统计 --------------------------------------------------------
  interface Stat { speaker: string; seconds: number; chars: number; turns: number }
  const stats = new Map<string, Stat>();
  for (const seg of task.segments) {
    const spk = seg.speaker || '未知';
    const cur = stats.get(spk) || { speaker: spk, seconds: 0, chars: 0, turns: 0 };
    cur.seconds += Math.max(0, seg.end - seg.start);
    cur.chars += seg.text.length;
    cur.turns += 1;
    stats.set(spk, cur);
  }
  const statList = [...stats.values()].sort((a, b) => b.seconds - a.seconds);
  const totalSeconds = statList.reduce((a, s) => a + s.seconds, 0) || 1;

  // ---- 顶部播放条 --------------------------------------------------------
  const playerCard = h(
    'div',
    { class: 'card player-top' },
    h(
      'div',
      { class: 'player-top-row' },
      // 控制
      h(
        'div',
        { class: 'player-ctl' },
        h(
          'button',
          {
            class: 'player-play',
            type: 'button',
            title: '播放 / 暂停',
            onclick: () => {
              if (!hasAudio) return;
              if (audio.paused) void audio.play().catch(() => undefined);
              else audio.pause();
            },
          },
          '▶',
        ),
        h(
          'div',
          { class: 'player-skips' },
          skipBtn(-10, '« 10s'),
          skipBtn(10, '10s »'),
        ),
      ),
      // 时间 + 进度
      h(
        'div',
        { class: 'player-track' },
        h(
          'div',
          { class: 'player-times' },
          curTimeEl,
          h('span', { class: 'player-sep' }, '/'),
          totalTimeEl,
          h('div', { class: 'spacer' }),
          h(
            'label',
            { class: 'player-follow', title: '播放时自动滚动到当前句' },
            followToggle,
            '跟随播放',
          ),
        ),
        bar,
      ),
      // 当前句
      h(
        'div',
        { class: 'player-nowline' },
        curSpeakerEl,
        curTextEl,
      ),
    ),
  );

  // ---- 筛选状态 ----------------------------------------------------------
  const hidden = new Set<string>(); // 被隐藏的说话人
  let onlySpeaker: string | null = null; // 只看某人

  const listHost = h('div', { class: 'transcript transcript-tall' });
  const filterHost = h('div', { class: 'chip-row', style: 'padding:12px 18px;border-bottom:1px solid var(--border)' });

  // 行元素索引，供播放联动使用
  let lineEls: HTMLElement[] = [];
  let activeIdx = -1;

  const visibleSegments = (): Segment[] =>
    task.segments.filter((seg) => {
      const spk = seg.speaker || '未知';
      if (onlySpeaker) return spk === onlySpeaker;
      return !hidden.has(spk);
    });

  function jumpTo(seconds: number): void {
    if (!hasAudio) return;
    audio.currentTime = Math.max(0, seconds - 0.15);
    void audio.play().catch(() => undefined);
  }

  function highlight(idx: number, autoScroll: boolean): void {
    if (idx === activeIdx) return;
    if (activeIdx >= 0 && lineEls[activeIdx]) lineEls[activeIdx].classList.remove('tline-active');
    activeIdx = idx;
    const el = lineEls[idx];
    if (!el) return;
    el.classList.add('tline-active');
    if (autoScroll && followToggle.checked) {
      const host = listHost;
      const top = el.offsetTop - host.offsetTop;
      const target = top - host.clientHeight / 2 + el.clientHeight / 2;
      host.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }

  function renderList(): void {
    const segs = visibleSegments();
    listHost.innerHTML = '';
    lineEls = [];
    activeIdx = -1;

    if (!segs.length) {
      listHost.appendChild(h('div', { class: 'empty' }, '当前筛选下没有内容'));
      return;
    }

    segs.forEach((seg, i) => {
      const spk = seg.speaker || null;
      const row = h(
        'div',
        {
          class: 'tline tline-click',
          onclick: () => jumpTo(seg.start),
          title: '点击从这一段开始播放',
        },
        h('div', { class: 'ts' }, fmtClock(seg.start)),
        spk
          ? h(
              'div',
              {
                class: 'tspk tspk-edit',
                style: `color:${colorOf(spk)};min-width:56px`,
                title: `点击修改「${labelOf(spk)}」的名字`,
                onclick: (ev: Event) => {
                  // 别触发整行的跳转播放
                  ev.stopPropagation();
                  openRenameOne(spk);
                },
              },
              labelOf(spk),
            )
          : null,
        h('div', { class: 'ttx' }, seg.text),
      );
      lineEls.push(row);
      listHost.appendChild(row);
    });
  }

  function renderFilters(): void {
    filterHost.innerHTML = '';
    if (!task.diarize || speakerOrder.length === 0) {
      filterHost.appendChild(h('span', { class: 'tiny muted' }, '本次未启用说话人分离'));
      return;
    }
    filterHost.appendChild(h('span', { class: 'tiny muted', style: 'margin-right:4px' }, '筛选：'));

    const allChip = h(
      'button',
      {
        class: `chip${onlySpeaker === null && hidden.size === 0 ? ' chip-active' : ''}`,
        onclick: () => {
          onlySpeaker = null;
          hidden.clear();
          renderFilters();
          renderList();
        },
      },
      '全部',
    );
    filterHost.appendChild(allChip);

    speakerOrder.forEach((spk) => {
      const st = stats.get(spk);
      const isOnly = onlySpeaker === spk;
      const isHidden = hidden.has(spk);

      // 整个标签是一个整体：主体点击筛选，右侧图标点击改名/隐藏
      const chip = h(
        'div',
        {
          class: `chip${isOnly ? ' chip-active' : ''}${isHidden ? ' chip-off' : ''}`,
          style: `border-color:${colorOf(spk)}`,
          title: onlySpeaker === spk ? '取消只看此人' : '只看此人的发言',
          onclick: () => {
            if (onlySpeaker === spk) {
              onlySpeaker = null;
            } else {
              onlySpeaker = spk;
              hidden.delete(spk);
            }
            renderFilters();
            renderList();
          },
        },
        h('span', { class: 'chip-dot', style: `background:${colorOf(spk)}` }),
        h('span', { class: 'chip-name' }, labelOf(spk)),
        st ? h('span', { class: 'chip-sub' }, `${fmtDuration(st.seconds)} · ${st.chars}字`) : null,
        // 改名
        h(
          'span',
          {
            class: 'chip-act',
            title: '修改这个名字',
            onclick: (ev: Event) => {
              ev.stopPropagation();
              openRenameOne(spk);
            },
          },
          '✎',
        ),
        // 隐藏 / 恢复
        h(
          'span',
          {
            class: 'chip-act',
            title: isHidden ? '恢复显示' : '隐藏此人',
            onclick: (ev: Event) => {
              ev.stopPropagation();
              if (hidden.has(spk)) hidden.delete(spk);
              else {
                hidden.add(spk);
                if (onlySpeaker === spk) onlySpeaker = null;
              }
              renderFilters();
              renderList();
            },
          },
          isHidden ? '🙈' : '👁',
        ),
      );
      filterHost.appendChild(chip);
    });

  }

  // ---- 播放联动 ----------------------------------------------------------
  /** 找到当前播放位置对应的段落索引。 */
  const segmentAt = (t: number): { seg: Segment | null; idx: number } => {
    const segs = visibleSegments();
    for (let i = 0; i < segs.length; i += 1) {
      if (t >= segs[i].start && t < segs[i].end + 0.05) return { seg: segs[i], idx: i };
    }
    return { seg: null, idx: -1 };
  };

  /** 刷新播放器上显示的时间、进度、说话人和当前句。 */
  function syncPlayer(): void {
    const t = hasAudio ? audio.currentTime : 0;
    const dur = hasAudio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : task.duration || 0;
    curTimeEl.textContent = fmtClock(t);
    totalTimeEl.textContent = fmtClock(dur);
    barFill.style.width = dur > 0 ? `${Math.min(100, (t / dur) * 100)}%` : '0%';
    playBtn.textContent = hasAudio && !audio.paused ? '❚❚' : '▶';

    const { seg } = segmentAt(t);
    if (seg) {
      if (seg.speaker) {
        curSpeakerEl.textContent = labelOf(seg.speaker);
        curSpeakerEl.style.color = colorOf(seg.speaker);
      } else {
        curSpeakerEl.textContent = '';
      }
      curTextEl.textContent = seg.text;
    }
  }

  const syncHighlight = (): void => {
    syncPlayer();
    if (!hasAudio) return;
    const { idx } = segmentAt(audio.currentTime);
    if (idx >= 0) highlight(idx, true);
  };
  audio.addEventListener('timeupdate', syncHighlight);
  audio.addEventListener('seeked', syncHighlight);
  audio.addEventListener('loadedmetadata', syncPlayer);
  audio.addEventListener('play', () => {
    playBtn.textContent = '❚❚';
  });
  audio.addEventListener('pause', () => {
    playBtn.textContent = '▶';
    syncPlayer();
  });

  // ---- 导出 --------------------------------------------------------------
  const exportRow = h(
    'div',
    { class: 'row wrap', style: 'gap:6px' },
    h('span', { class: 'tiny muted' }, '导出：'),
    ...(['txt', 'srt', 'vtt', 'json'] as const).map((fmt) =>
      h('a', { class: 'btn sm', href: `/api/tasks/${task.id}/export?format=${fmt}`, download: '' }, fmt.toUpperCase()),
    ),
  );

  // ---- 右侧栏（播放器已移到页面顶部）-------------------------------------
  const sidePanel = h(
    'div',
    { class: 'detail-side' },
    audio,
    statList.length > 1
      ? h(
          'div',
          { class: 'card' },
          h('div', { class: 'card-head' }, h('h2', null, '说话人发言占比')),
          h(
            'div',
            { class: 'card-body' },
            h(
              'div',
              { class: 'speaker-bar', style: 'height:10px;margin-bottom:14px' },
              ...statList.map((s) =>
                h('span', {
                  style: `width:${(s.seconds / totalSeconds) * 100}%;background:${colorOf(s.speaker)}`,
                  title: `${labelOf(s.speaker)} ${fmtDuration(s.seconds)}`,
                }),
              ),
            ),
            ...statList.map((s) =>
              h(
                'div',
                { class: 'spk-stat' },
                h('span', { class: 'chip-dot', style: `background:${colorOf(s.speaker)}` }),
                h('span', { style: 'flex:1;font-weight:600;color:' + colorOf(s.speaker) }, labelOf(s.speaker)),
                h('span', { class: 'tiny muted nowrap' }, `${fmtDuration(s.seconds)} · ${s.chars} 字 · ${s.turns} 段`),
              ),
            ),
          ),
        )
      : null,
    h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, '信息')),
      h(
        'div',
        { class: 'card-body' },
        h(
          'div',
          { class: 'kv' },
          kv('状态', statusBadge(task.status)),
          kv('录音时长', fmtDuration(task.duration)),
          kv('文件大小', fmtBytes(task.fileSize)),
          kv('识别语言', task.detectedLang || task.language || '自动检测'),
          kv('说话人', task.diarize ? `${task.speakerCount || 0} 人` : '未启用分离'),
          kv('片段数', String(task.segmentCount)),
          kv('模型', task.model || '服务器默认'),
          kv('转写耗时', fmtElapsed(task.elapsedMs)),
          kv('完成于', task.finishedAt ? fmtRelative(task.finishedAt) : '—'),
        ),
      ),
    ),
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, exportRow)),
  );

  // ---- 组装 --------------------------------------------------------------
  const tabs = h('div', { class: 'tabs' });
  const bodyHost = h('div', null);
  let mode: 'timeline' | 'text' = 'timeline';

  function renderBody(): void {
    tabs.innerHTML = '';
    for (const [key, label] of [['timeline', '时间轴'], ['text', '纯文本']] as const) {
      tabs.appendChild(
        h(
          'button',
          {
            class: mode === key ? 'active' : '',
            onclick: () => {
              mode = key;
              renderBody();
            },
          },
          label,
        ),
      );
    }
    bodyHost.innerHTML = '';
    if (mode === 'timeline') {
      bodyHost.appendChild(filterHost);
      bodyHost.appendChild(listHost);
      renderFilters();
      renderList();
      // 列表重建后按当前播放位置重新高亮
      activeIdx = -1;
      syncHighlight();
    } else {
      const text = task.text || task.segments.map((s) => s.text).join(' ');
      const box = h('textarea', { readonly: true, class: 'plain-text' }) as HTMLTextAreaElement;
      box.value = text;
      bodyHost.appendChild(
        h(
          'div',
          { class: 'card-body' },
          h(
            'div',
            { class: 'row', style: 'margin-bottom:8px' },
            h('span', { class: 'tiny muted' }, `${text.length} 字`),
            h('div', { class: 'spacer' }),
            h(
              'button',
              {
                class: 'btn sm',
                onclick: async () => {
                  try {
                    await navigator.clipboard.writeText(text);
                    toast('已复制到剪贴板', 'ok');
                  } catch {
                    toast('复制失败，请手动选择文本', 'err');
                  }
                },
              },
              '复制全文',
            ),
          ),
          box,
        ),
      );
    }
  }

  // 播放条放在页面顶部，横跨整个宽度
  root.appendChild(playerCard);
  root.appendChild(
    h(
      'div',
      { class: 'detail-layout' },
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head' },
          h('h2', null, '转写结果'),
          h('div', { class: 'spacer' }),
          h('span', { class: 'tiny muted' }, `${task.segmentCount} 段 · ${task.speakerCount || 0} 人`),
        ),
        tabs,
        bodyHost,
      ),
      sidePanel,
    ),
  );

  renderBody();
  syncPlayer();
}