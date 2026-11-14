/**
 * 字符级时间映射。
 *
 * 用途：让播放进度条和转写文本联动 —— 播到哪个字，文字上就标到哪个字。
 *
 * 为什么不按字数平均分：实测同一段里前半可能慢、后半可能快
 * （「每年都有的菩」5.6 秒 6 个字，「萨生日都会来搞活」0.16 秒 8 个字），
 * 平均分会让高亮跑到声音前面去。所以用词级时间戳。
 *
 * 词级时间戳的两个坑（和 splitSegment 里一样）：
 *   1. 标点要并回前一个词，否则它吞掉的停顿会把映射顶偏
 *   2. 段落被拆过之后文本变短，±0.3 秒的时间窗口会捞到后面段落的词，
 *      要按字符数截断
 */
import type { AsrSegment, AsrWord } from './asrClient';

export interface CharTiming {
  /** 这个字在段落文本里的起始偏移 */
  index: number;
  start: number;
  end: number;
}

const PUNCT_ONLY = /^[，。？！；、,.;?!：:…—]+$/;

/** 取出覆盖本段文本的词（合并标点 + 按字符数截断）。 */
export function wordsForSegment(segment: AsrSegment, words: AsrWord[] | undefined): AsrWord[] {
  if (!words || !words.length) return [];
  const raw = words.filter(
    (w) => w.start >= segment.start - 0.3 && w.end <= segment.end + 0.3,
  );
  const inside: AsrWord[] = [];
  let covered = 0;
  for (const w of raw) {
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
  return inside;
}

/**
 * 生成每个字符的时间区间。
 *
 * 没有词级数据时退回按字符数平均分（会偏，但至少有进度）。
 */
export function charTimings(segment: AsrSegment, words: AsrWord[] | undefined): CharTiming[] {
  const text = segment.text;
  const out: CharTiming[] = [];
  if (!text.length) return out;

  const inside = wordsForSegment(segment, words);

  if (!inside.length) {
    // 没有词级数据：按字符数平均分
    const span = Math.max(0.001, segment.end - segment.start);
    const per = span / text.length;
    for (let i = 0; i < text.length; i += 1) {
      out.push({
        index: i,
        start: segment.start + per * i,
        end: segment.start + per * (i + 1),
      });
    }
    return out;
  }

  // 有词级数据：逐词铺开，词内字符再均分
  let charPos = 0;
  for (const w of inside) {
    if (charPos >= text.length) break;
    const len = Math.min(w.word.length, text.length - charPos);
    const per = (w.end - w.start) / Math.max(1, w.word.length);
    for (let i = 0; i < len; i += 1) {
      out.push({
        index: charPos + i,
        start: w.start + per * i,
        end: w.start + per * (i + 1),
      });
    }
    charPos += len;
  }

  // 词覆盖不到文本尾部（标点等）时，用最后一个词的结束时间补齐
  const lastEnd = out.length ? out[out.length - 1].end : segment.end;
  while (out.length < text.length) {
    const i = out.length;
    out.push({ index: i, start: lastEnd, end: segment.end });
  }

  return out;
}
