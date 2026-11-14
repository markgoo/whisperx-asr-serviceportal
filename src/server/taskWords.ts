/**
 * 词级时间戳的持久化。
 *
 * 为什么要存：分段逻辑（splitByPause / smoothSpeakers / 标点）改动后，
 * 只有重新转写才能验证效果。一次 10 分钟的录音要跑 1 分钟、1 小时的录音
 * 要跑 20 分钟，调一次逻辑等一次转写，效率极低。
 *
 * 存下来之后，「重新修正」就能重跑完整的分段而不用再调 ASR。
 *
 * 体积：10 小时中文音频约 5-10 万词，JSON 约 5 MB。所以放在独立的表，
 * 不塞进 tasks——tasks 的列表查询用 SELECT *，带着它会把列表拖慢。
 */
import { getDb } from './db';
import type { AsrSegment, AsrWord } from './asrClient';
import { nowIso } from './util';

export interface StoredWords {
  /** whisper 的原始分段（重新分段要用它做兜底文本） */
  segments: AsrSegment[];
  /** 词级时间戳，含 speaker 标签 */
  words: AsrWord[];
  /** VAD 给出的静音区间；没有 VAD 时为空 */
  silence?: Array<[number, number]>;
}

interface TaskWordsRow {
  payload: string;
}

/** 保存词级数据。已存在则覆盖（重新转写时会更新）。 */
export function saveTaskWords(taskId: number, data: StoredWords): void {
  if (!data.words.length) return;
  getDb()
    .prepare(
      `INSERT INTO task_words (task_id, payload, created_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
    )
    .run(taskId, JSON.stringify(data), nowIso());
}

/** 读词级数据；老任务没存过会返回 null。 */
export function loadTaskWords(taskId: number): StoredWords | null {
  const row = getDb().prepare('SELECT payload FROM task_words WHERE task_id = ?').get(taskId) as
    | TaskWordsRow
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload) as StoredWords;
    if (!Array.isArray(parsed.words) || !parsed.words.length) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 删任务时连带删（外键 ON DELETE CASCADE 也会做，这里显式兜底）。 */
export function deleteTaskWords(taskId: number): void {
  getDb().prepare('DELETE FROM task_words WHERE task_id = ?').run(taskId);
}

/** 统计存了多少任务，用于设置页/诊断展示。 */
export function countStoredWords(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM task_words').get() as { n: number };
  return row.n;
}
