/**
 * Job runner: pulls queued transcription tasks off SQLite and drives the ASR
 * backend, with in-process concurrency control and cooperative cancellation.
 */
import { WORKER_CONCURRENCY } from './config';
import { getDb, getSettings } from './db';
import { transcribeAudio, AsrError, type AsrSegment } from './asrClient';
import { assertInsideUploads } from './storage';
import { normalizeSegments, normalizeText, parseTermsText, type NormalizeOptions } from './normalizer';
import path from 'node:path';
import { DATA_DIR } from './config';
import { DEFAULT_SPLIT, mergeShortSegments, punctuate, smoothSpeakers, splitByPause } from './segmenter';
import { detectSilence, punctuateTexts } from './puncClient';
import { nowIso } from './util';
import type { TaskRow } from './types';

const running = new Map<number, AbortController>();
let pumping = false;
let timer: NodeJS.Timeout | null = null;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[worker] ${msg}`);
}

/**
 * 进程重启后，数据库里可能残留 processing 状态的任务；ASR 侧也可能有卡住的
 * 请求占着 GPU 信号量。启动时先做一次清理，否则新任务会永远排在后面。
 */
function resetStaleTasks(): void {
  const stale = getDb()
    .prepare(`SELECT id, started_at FROM tasks WHERE status IN ('processing')`)
    .all() as { id: number; started_at: string | null }[];
  if (!stale.length) return;
  const now = nowIso();
  for (const row of stale) {
    getDb()
      .prepare(
        `UPDATE tasks SET status = 'failed', stage = '已中断', progress = 0,
                          error_message = ?, finished_at = ?
          WHERE id = ?`,
      )
      .run('服务重启导致任务中断，请重新转写', now, row.id);
  }
  log(`检测到 ${stale.length} 个中断任务，已标记为失败（可重新转写）`);
}

export function startWorker(): void {
  if (timer) return;
  resetStaleTasks();
  timer = setInterval(pump, 1500);
  timer.unref?.();
  setTimeout(pump, 200);
  log(`已启动，并发上限 ${WORKER_CONCURRENCY}`);
}

export function stopWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const ctrl of running.values()) ctrl.abort();
  running.clear();
}

/** Queue a task (used on create and retry) and wake the worker immediately. */
export function enqueue(): void {
  setTimeout(pump, 50).unref?.();
}

function claimNext(): TaskRow | null {
  const db = getDb();
  const claim = db.transaction((): TaskRow | null => {
    const row = db
      .prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`)
      .get() as TaskRow | undefined;
    if (!row) return null;
    db.prepare(
      `UPDATE tasks SET status = 'processing', stage = '准备中', progress = 5, started_at = ?,
                        error_message = NULL
        WHERE id = ?`,
    ).run(nowIso(), row.id);
    return { ...row, status: 'processing', stage: '准备中', progress: 5 };
  });
  return claim();
}

function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    while (running.size < WORKER_CONCURRENCY) {
      const task = claimNext();
      if (!task) break;
      void runTask(task);
    }
  } finally {
    pumping = false;
  }
}

export function cancelTask(taskId: number): boolean {
  const ctrl = running.get(taskId);
  if (ctrl) {
    ctrl.abort();
    return true;
  }
  return false;
}

export function isRunning(taskId: number): boolean {
  return running.has(taskId);
}

function update(taskId: number, patch: Record<string, unknown>): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  getDb()
    .prepare(sql)
    .run(...keys.map((k) => patch[k] ?? null), taskId);
}

async function runTask(task: TaskRow): Promise<void> {
  const settings = getSettings();
  const ctrl = new AbortController();
  running.set(task.id, ctrl);
  const startedAt = Date.now();

  try {
    if (!task.storage_path) {
      throw new AsrError('音频文件已不存在，无法转写');
    }
    const filePath = assertInsideUploads(task.storage_path);

    update(task.id, { stage: '上传至 ASR 服务', progress: 15 });

    // While waiting for the GPU, the backend is silent; nudge progress so the
    // UI does not look frozen during long queues.
    let fakeProgress = 15;
    const ticker = setInterval(() => {
      fakeProgress = Math.min(85, fakeProgress + 3);
      if (!ctrl.signal.aborted) {
        update(task.id, { stage: '正在转写（含说话人分离）', progress: fakeProgress });
      }
    }, 5000);
    ticker.unref?.();

    let result;
    // 硬超时：即使 ASR 侧卡死（模型下载、GPU 挂起），也不能让任务永久占住 worker。
    const hardTimeoutMs = Math.max(60, settings.asrTimeoutSec) * 1000 + 30_000;
    let hardTimer: NodeJS.Timeout | null = null;
    try {
      result = await Promise.race([
        transcribeAudio({
          baseUrl: settings.asrBaseUrl,
          filePath,
          fileName: task.original_name || 'audio.wav',
          timeoutSec: settings.asrTimeoutSec,
          signal: ctrl.signal,
          options: {
            task: task.task_type || 'transcribe',
            language: task.language || null,
            model: task.model || null,
            initialPrompt: task.initial_prompt || null,
            hotwords: task.hotwords || null,
            wordTimestamps: task.word_timestamps === 1,
            diarize: task.diarize === 1,
            numSpeakers: task.num_speakers,
            minSpeakers: task.min_speakers,
            maxSpeakers: task.max_speakers,
          },
        }),
        new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            ctrl.abort();
            reject(new AsrError(`转写超时（超过 ${Math.round(hardTimeoutMs / 1000)} 秒），已放弃`));
          }, hardTimeoutMs);
          hardTimer.unref?.();
        }),
      ]);
    } finally {
      clearInterval(ticker);
      if (hardTimer) clearTimeout(hardTimer);
    }

    if (ctrl.signal.aborted) throw new AsrError('任务已取消');

    const rawSegments: AsrSegment[] = result.segments;

    // 1. 按停顿重切分段：长句不再挤成一坨，同时给缺标点的句子补句读
    const splitOpts = {
      ...DEFAULT_SPLIT,
      pauseSec: settings.splitPauseSec,
    };

    // 先问 VAD 要真实静音区间。whisperx 的词时长会把「字被拖长」当成停顿，
    // 用它切分会把「这棵树」切成「这棵|树」。VAD 看音频能量，不受影响。
    // 服务不可用时退回按词时长估算。
    let silence: Array<[number, number]> | undefined;
    if (settings.puncEnabled && settings.puncServiceUrl) {
      try {
        // punc 容器只读挂载了门户的 data 卷，所以传内部路径而不是上传文件
        // punc 容器把门户的 data 卷只读挂在 /data，
        // 所以把宿主机路径换算成容器内的相对路径传过去
        const rel = path.relative(DATA_DIR, task.storage_path || '');
        const containerPath = `/data/${rel.split(path.sep).join('/')}`;
        const vad = await detectSilence(settings.puncServiceUrl, containerPath);
        // 只保留够长的静音当切分依据。短静音（0.1-0.4 秒）是说话时的自然断句，
        // 拿它们切分会把句子剁成碎片。
        const MIN_VAD_GAP = 0.5;
        silence = vad.gaps.filter(([a, b]) => b - a >= MIN_VAD_GAP);
        log(
          `任务 #${task.id} VAD: ${vad.speech.length} 个语音段、${vad.gaps.length} 个静音` +
            `（取 ${silence.length} 个 >= ${MIN_VAD_GAP}s 的作为切分点）`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`任务 #${task.id} VAD 不可用，退回按词时长估算停顿：${msg}`);
      }
    }

    const splitSegments = settings.splitEnabled
      ? mergeShortSegments(splitByPause(rawSegments, result.words, splitOpts, silence))
      : mergeShortSegments(rawSegments.map((s) => ({ ...s, text: punctuate(s.text) })));

    // 说话人平滑：diarization 的切换点有抖动，会切出 0.1 秒的碎片和
    // A→B→A 的假换人。这一步把碎片并回去，并把夹在中间的短句归给前后同一人。
    const smoothedSegments = smoothSpeakers(splitSegments);

    // 2. 后处理：合并拆开的英文/数字、修术语、繁转简、截掉尾部重复
    const normOpts: NormalizeOptions = {
      enabled: settings.normalizeEnabled,
      toSimplified: settings.normalizeToSimplified,
      terms: parseTermsText(settings.normalizeTerms),
    };
    let segments = normalizeSegments(smoothedSegments, normOpts);

    // 3. 模型标点：用 CT-Punc 重判标点，替换掉启发式的结果。
    //    服务不可用就保留启发式，绝不能让标点问题导致转写失败。
    if (settings.puncEnabled && settings.puncServiceUrl) {
      try {
        update(task.id, { stage: '整理标点', progress: 92 });
        const res = await punctuateTexts(
          settings.puncServiceUrl,
          segments.map((s) => s.text),
          // 长录音可能有上百段，给足时间但也不能无限等
          180_000,
        );
        segments = segments.map((s, i) => ({ ...s, text: res.texts[i] || s.text }));
        log(`任务 #${task.id} 标点完成（${res.elapsedMs}ms / ${segments.length} 段）`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`任务 #${task.id} 标点服务不可用，保留内置标点：${msg}`);
      }
    }

    const cleanText = settings.normalizeEnabled
      ? normalizeText(result.text, normOpts)
      : result.text;

    const speakers = new Set<string>();
    for (const s of segments) if (s.speaker) speakers.add(s.speaker);
    const duration = segments.length ? Math.max(...segments.map((s) => s.end)) : null;

    update(task.id, {
      status: 'completed',
      stage: '已完成',
      progress: 100,
      result_text: cleanText,
      result_json: JSON.stringify(segments),
      segment_count: segments.length,
      speaker_count: speakers.size,
      detected_lang: result.language || null,
      duration,
      finished_at: nowIso(),
      elapsed_ms: Date.now() - startedAt,
      error_message: null,
    });
    log(`任务 #${task.id} 完成：${segments.length} 段，${speakers.size} 位说话人`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = ctrl.signal.aborted;
    const current = getDb().prepare('SELECT status FROM tasks WHERE id = ?').get(task.id) as
      | { status: string }
      | undefined;
    // A user cancel may already have written the final state.
    if (current && current.status !== 'canceled') {
      update(task.id, {
        status: aborted ? 'canceled' : 'failed',
        stage: aborted ? '已取消' : '失败',
        error_message: aborted ? '任务已取消' : message,
        finished_at: nowIso(),
        elapsed_ms: Date.now() - startedAt,
      });
    }
    log(`任务 #${task.id} ${aborted ? '已取消' : '失败'}：${message}`);
  } finally {
    running.delete(task.id);
    setTimeout(pump, 100).unref?.();
  }
}
