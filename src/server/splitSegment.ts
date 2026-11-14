/**
 * 段落内拆分。
 *
 * 为什么需要：一段里常常混着两个人的话。比如
 *   「选在这棵树吗？这棵嘛我也不打清楚」
 * 前半是提问、后半是回答，但整段只能标一个说话人。
 *
 * 有了词级时间戳就能精确切：按字符位置切开，再用落在每段里的词算时间范围，
 * 不像按字符比例估算那样会漂。
 */
import type { AsrSegment, AsrWord } from './asrClient';

export interface SplitPiece {
  start: number;
  end: number;
  text: string;
}

/**
 * 把一段按字符位置切成多段。
 *
 * @param segment 原段落
 * @param text    当前文本（可能被前置处理改过，以它为准切）
 * @param cuts    切分点（字符偏移，升序，不含 0 和末尾）
 * @param words   词级时间戳，用来给每段算时间；没有就按字符比例估算
 */
export function splitSegment(
  segment: AsrSegment,
  text: string,
  cuts: number[],
  words?: AsrWord[],
): SplitPiece[] | null {
  const valid = [...new Set(cuts)]
    .filter((c) => Number.isInteger(c) && c > 0 && c < text.length)
    .sort((a, b) => a - b);
  if (!valid.length) return null;

  const bounds = [0, ...valid, text.length];
  const pieces: SplitPiece[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const body = text.slice(bounds[i], bounds[i + 1]).trim();
    if (body) pieces.push({ start: 0, end: 0, text: body });
  }
  if (pieces.length < 2) return null;

  // 优先用词级时间戳：找出落在原段范围内的词，按字符累计分配
  //
  // 两个坑：
  // 1. 标点得并回前一个词。whisperx 会给标点单独一个 token，还把真实停顿
  //    算进它的时长（实测一个「,」占 3.37 秒），不合并按字符映射会错位。
  // 2. 光按时间过滤不够。段落被拆过之后文本变短了，但时间窗口仍会捞到
  //    后面段落的词（实测 16 字的段取到 30 个词），字符映射整体偏移。
  //    所以按字符数截断，只取覆盖本段文本的那几个词。
  const PUNCT_ONLY = /^[，。？！；、,.;?!：:…—]+$/;
  const rawInside = (words ?? []).filter(
    (w) => w.start >= segment.start - 0.3 && w.end <= segment.end + 0.3,
  );
  const inside: AsrWord[] = [];
  let covered = 0;
  for (const w of rawInside) {
    if (covered >= segment.text.length) break;
    const last = inside[inside.length - 1];
    if (last && PUNCT_ONLY.test(w.word)) {
      last.word += w.word;
      last.end = Math.max(last.end, w.end);
    } else {
      inside.push({ ...w });
      covered += w.word.length;
    }
  }

  if (inside.length >= pieces.length) {
    // 用词把「字符位置」映射到「时间」：逐词累加字符数
    let charPos = 0;
    const marks: { pos: number; t: number }[] = [];
    for (const w of inside) {
      marks.push({ pos: charPos, t: w.start });
      charPos += w.word.length;
      marks.push({ pos: charPos, t: w.end });
    }
    const timeAt = (pos: number): number => {
      if (!marks.length) return segment.start;
      if (pos <= 0) return marks[0].t;
      for (let i = 1; i < marks.length; i += 1) {
        if (marks[i].pos >= pos) {
          const a = marks[i - 1];
          const b = marks[i];
          if (b.pos === a.pos) return b.t;
          const ratio = (pos - a.pos) / (b.pos - a.pos);
          return a.t + (b.t - a.t) * ratio;
        }
      }
      return marks[marks.length - 1].t;
    };

    // 词覆盖的字符数和文本长度可能对不上（标点、空白），按比例缩放
    const scaled = (pos: number): number => {
      const totalWords = charPos || 1;
      return Math.round((pos / text.length) * totalWords);
    };

    for (let i = 0; i < pieces.length; i += 1) {
      pieces[i].start = i === 0 ? segment.start : timeAt(scaled(bounds[i]));
      pieces[i].end = i === pieces.length - 1 ? segment.end : timeAt(scaled(bounds[i + 1]));
    }
  } else {
    // 没有词级数据：按字符数比例估算
    const total = text.length || 1;
    const dur = segment.end - segment.start;
    for (let i = 0; i < pieces.length; i += 1) {
      pieces[i].start = segment.start + (dur * bounds[i]) / total;
      pieces[i].end = segment.start + (dur * bounds[i + 1]) / total;
    }
  }

  // 兜底：时间必须单调且不小于原段起点
  for (let i = 0; i < pieces.length; i += 1) {
    if (!Number.isFinite(pieces[i].start)) pieces[i].start = segment.start;
    if (!Number.isFinite(pieces[i].end)) pieces[i].end = segment.end;
    if (pieces[i].end <= pieces[i].start) pieces[i].end = pieces[i].start + 0.1;
    if (i > 0 && pieces[i].start < pieces[i - 1].end) {
      pieces[i].start = pieces[i - 1].end;
    }
  }

  return pieces;
}
