/**
 * 按停顿重切分段，并给缺标点的句子补句读。
 *
 * whisper 对连续的长段落常常一个标点都不给，29 秒挤成一坨，读起来很累。
 * 词级时间戳里每个词都有 start/end，词与词之间的间隔就代表停顿；
 * 在停顿处切开，可读性立刻不同。
 */
import type { AsrSegment, AsrWord } from './asrClient';

export interface SplitOptions {
  /** 词间停顿超过这个秒数就切一段 */
  pauseSec: number;
  /** 段内停顿超过这个秒数就插入逗号（比 pauseSec 小，让短停顿也看得见） */
  commaPauseSec: number;
  /** 单段最长时长，超过就强制切（找不到停顿时兜底） */
  maxSegmentSec: number;
  /** 单段最长字数，超过就切（中文一行太长很难读） */
  maxSegmentChars: number;
  /** 单段最短时长，太碎的小段并到前一段 */
  minSegmentSec: number;
  /** 是否为缺标点的句子补标点 */
  addPunctuation: boolean;
}

export const DEFAULT_SPLIT: SplitOptions = {
  pauseSec: 0.85,
  commaPauseSec: 0.45,
  maxSegmentSec: 22,
  maxSegmentChars: 60,
  minSegmentSec: 0.8,
  addPunctuation: true,
};

const SENTENCE_END = /[。！？!?；;…]$/;
const CJK = /[\u4e00-\u9fff]/;

/** 一句话的收尾标志：语气助词、句末的「了/的/是」。 */
const SOFT_END = /[嘛呢吧啊呀哈哦喔欸么]$|[了的]$/;

/**
 * 给没有标点的句子补句读。
 *
 * 只做「加法」，不按长度强行断句 —— 按字数切会把句子切在词中间，
 * 比不加标点更糟。真正的分段交给 splitByPause（按停顿切）。
 *
 * 结尾标点按语义选：说完了用「。」，话没说完用「，」，
 * 这样多段拼起来读仍然是连贯的。
 */
export function punctuate(text: string, forceEnd = false): string {
  if (!text) return text;

  let out = text;

  // 1. 英文逗号/分号统一成中文
  out = out.replace(/\s*,\s*/g, '，').replace(/\s*;\s*/g, '；');

  // 2. 转折/因果连词后补逗号（中文口语在这些位置几乎一定停顿）
  const commaAfter = [
    '所以', '但是', '可是', '然后', '因为', '如果', '其实', '而且',
    '不过', '另外', '因此', '换句话说',
  ];
  for (const word of commaAfter) {
    out = out.replace(new RegExp(`(${word})(?=[^，。！？；、])`, 'g'), '$1，');
  }

  // 3. 语气助词处收一句（嘛/呢/吧 通常是一句话的尾巴）
  out = out.replace(/([嘛呢吧啊呀哈哦喔欸])(?=[^，。！？；、])/g, '$1，');

  // 4. 整理连续标点与句末逗号
  out = out.replace(/，{2,}/g, '，').replace(/，(?=[。！？])/g, '');
  out = out.replace(/[，、]+$/, '');

  if (SENTENCE_END.test(out)) return out;

  // 5. 结尾标点：说完了用句号，半截话用逗号（最后一段强制句号）
  if (!CJK.test(out)) return out;
  const complete = forceEnd || SOFT_END.test(out);
  return `${out}${complete ? '。' : '，'}`;
}

/**
 * 合并过短的碎片段。
 *
 * VAD 有时会切出 0.1 秒的单字段（「切割」这种），单独成行很碍眼。
 * 只和**同一说话人**的相邻段合并，避免把不同人说的话搅在一起。
 */
export function mergeShortSegments(segments: AsrSegment[], minSec = 0.6): AsrSegment[] {
  if (segments.length <= 1) return segments;
  const out: AsrSegment[] = [];

  for (const seg of segments) {
    const last = out[out.length - 1];
    const dur = seg.end - seg.start;
    if (last && dur < minSec && last.speaker === seg.speaker) {
      // 并入上一段，保留较早的开始时间
      last.end = Math.max(last.end, seg.end);
      last.text = `${last.text}${seg.text}`;
      continue;
    }
    out.push({ ...seg });
  }

  // 首段太短且与后一段同人时，往后并
  if (out.length > 1) {
    const first = out[0];
    if (first.end - first.start < minSec && first.speaker === out[1].speaker) {
      out[1] = { ...out[1], start: first.start, text: `${first.text}${out[1].text}` };
      out.shift();
    }
  }

  return out;
}

/**
 * 计算某个词之后的停顿长度。
 *
 * WhisperX 的词级对齐有个特点：遇到停顿时，它往往不是留出空档，而是把
 * 停顿算进**前一个字的时长**（「年」能持续 1.88 秒）。所以只看词间 gap
 * 会漏掉大部分停顿，还要看「这个词是不是长得离谱」。
 */
export function pauseAfter(prev: AsrWord, next: AsrWord | null): number {
  const gap = next ? Math.max(0, next.start - prev.end) : 0;
  const dur = prev.end - prev.start;
  // 正常语速下每个字符约 0.25 秒，明显超出部分就是停顿
  const expected = Math.min(1.2, Math.max(0.15, prev.word.length * 0.28));
  const excess = Math.max(0, dur - expected);
  return Math.max(gap, excess);
}

/**
 * 这些字在中文里不能起一个新词，断在它们前面肯定是错的。
 * 中文分词器本身也会把「竞争者」切成「竞争 | 者」，所以光靠词边界不够。
 *
 * 注意只收「不能起句」的字。像「就/也/但/而」这些能起新分句的不能收，
 * 否则「没有替代品，就跟台积电…」这种正确断句会被吃掉。
 */
const CLING_START = new Set(
  [...'者性化们的了着过地得吗呢吧啊呀嘛哦欸在'],
);

/** 判断在 pos 处断句是否会切在黏着字前面。 */
function clingsForward(text: string, pos: number): boolean {
  const next = text[pos];
  return !!next && CLING_START.has(next);
}
function wordBoundaries(text: string): Set<number> {
  const set = new Set<number>([0, text.length]);
  try {
    const seg = new Intl.Segmenter('zh', { granularity: 'word' });
    for (const part of seg.segment(text)) set.add(part.index);
  } catch {
    // 环境不支持分词时放开限制，退化成纯停顿插逗号
    for (let i = 0; i <= text.length; i += 1) set.add(i);
  }
  return set;
}

/**
 * 用词拼接文本，并在词间停顿处插入逗号。
 *
 * 两个要点：
 * 1. 停顿可能被算进前一个字的时长，所以用 pauseAfter 而不是只看 gap
 * 2. 逗号要落在**词边界**上。对齐误差常把停顿算进词中间的字
 *    （例如「替代品」的「代」），直接插会切成「替代，品」。
 *    这里把逗号吸附到最近的词边界，必要时往后挪几个字。
 */
export function joinWordsWithPauses(words: AsrWord[], commaSec: number): string {
  let text = '';
  const candidates: number[] = [];
  for (let i = 0; i < words.length; i += 1) {
    if (i > 0) {
      const pause = pauseAfter(words[i - 1], words[i]);
      if (pause >= commaSec) candidates.push(text.length);
    }
    text += words[i].word;
  }
  if (!candidates.length) return text;

  const bounds = wordBoundaries(text);
  const boundsArr = [...bounds].sort((a, b) => a - b);

  /** 找离 pos 最近的词边界，最多容忍 4 个字。 */
  const snap = (pos: number): number | null => {
    if (bounds.has(pos)) return pos;
    let best: number | null = null;
    let bestDist = 5;
    for (const b of boundsArr) {
      const d = Math.abs(b - pos);
      if (d < bestDist) {
        best = b;
        bestDist = d;
      }
    }
    return best;
  };

  const chosen = new Set<number>();
  for (const c of candidates) {
    const at = snap(c);
    if (at !== null && at > 0 && at < text.length) chosen.add(at);
  }
  if (!chosen.size) return text;

  const sorted = [...chosen].sort((a, b) => a - b);
  let out = '';
  let prev = 0;
  for (const at of sorted) {
    out += `${text.slice(prev, at)}，`;
    prev = at;
  }
  out += text.slice(prev);
  return out.replace(/，{2,}/g, '，');
}

/** 合并后的处理块：同一说话人的一段连续发言。 */
interface Block {
  start: number;
  end: number;
  speaker: string | null;
  /** 各原始 whisper 段落的文本，用于覆盖率校验 */
  texts: string[];
  /** 本块包含的词（按顺序拼接各段落分配到的词） */
  words: AsrWord[];
}

/**
 * 把词按顺序分配到各个原始段落上。
 *
 * whisper 的 segment 时间范围和词时间并不严格对齐，用时间过滤会重复或漏词。
 * 这里用游标按「词开始时间 < 段落结束时间」依次分配，保证每个词只归属一段。
 */
function assignWordsToSegments(segments: AsrSegment[], words: AsrWord[]): AsrWord[][] {
  const result: AsrWord[][] = [];
  let cursor = 0;
  for (const seg of segments) {
    const start = cursor;
    while (cursor < words.length && words[cursor].start < seg.end + 0.1) {
      cursor += 1;
    }
    result.push(words.slice(start, cursor));
  }
  // 剩余的词（若有）挂到最后一段，避免丢词
  if (cursor < words.length && result.length) {
    result[result.length - 1].push(...words.slice(cursor));
  }
  return result;
}

/**
 * 把相邻的、同一说话人的段落合并成块。
 *
 * whisper 的 VAD 边界可能落在词中间（「什么」被切成「有什」+「么」），
 * 单独处理每个段落就会把这个断裂保留下来。合并后整块重切才能修掉。
 */
function mergeAdjacent(
  segments: AsrSegment[],
  segWords: AsrWord[][],
  maxGapSec = 2,
): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const last = blocks[blocks.length - 1];
    if (last && last.speaker === (s.speaker || null) && s.start - last.end <= maxGapSec) {
      last.end = Math.max(last.end, s.end);
      last.texts.push(s.text);
      last.words.push(...segWords[i]);
    } else {
      blocks.push({
        start: s.start,
        end: s.end,
        speaker: s.speaker || null,
        texts: [s.text],
        words: [...segWords[i]],
      });
    }
  }
  return blocks;
}

/**
 * 用词级时间戳重排段落。
 *
 * 流程：
 * 1. 相邻同说话人段落先合并成块 —— 消除 whisper 边界落在词中间的问题
 * 2. 块内用**词**重建文本（不再用 whisper 的 segment.text，避免拼出断词）
 * 3. 检测词间停顿，短停顿插逗号、长停顿切段
 * 4. 所有切点吸附到中文词边界
 *
 * 找不到词或词覆盖率过低时退化成只补标点，不会丢内容。
 */
export function splitByPause(
  segments: AsrSegment[],
  words: AsrWord[],
  opts: SplitOptions = DEFAULT_SPLIT,
): AsrSegment[] {
  const withPunct = (text: string, forceEnd = false): string =>
    opts.addPunctuation ? punctuate(text, forceEnd) : text;

  if (!words.length || !segments.length) {
    return segments.map((s, i) => ({
      ...s,
      text: withPunct(s.text, i === segments.length - 1),
    }));
  }

  const segWords = assignWordsToSegments(segments, words);
  const blocks = mergeAdjacent(segments, segWords);
  const out: AsrSegment[] = [];

  for (let bi = 0; bi < blocks.length; bi += 1) {
    const block = blocks[bi];
    const isLastBlock = bi === blocks.length - 1;

    const inside = block.words;
    const fallbackText = block.texts.join('');

    if (inside.length < 2) {
      out.push({ start: block.start, end: block.end, speaker: block.speaker, text: withPunct(fallbackText, isLastBlock) });
      continue;
    }

    // 用词重建文本，同时记录每个词边界处的停顿
    let text = '';
    const pauses: { pos: number; dur: number }[] = [];
    for (let i = 0; i < inside.length; i += 1) {
      if (i > 0) pauses.push({ pos: text.length, dur: pauseAfter(inside[i - 1], inside[i]) });
      text += inside[i].word;
    }

    // 词覆盖率太低（词没取全 / 词和文本对不上）就退回原文本，避免丢字
    const covered = inside.reduce((a, w) => a + w.word.length, 0);
    const baseLen = fallbackText.replace(/[，。！？；、\s]/g, '').length;
    if (baseLen > 0 && covered / baseLen < 0.55) {
      out.push({ start: block.start, end: block.end, speaker: block.speaker, text: withPunct(fallbackText, isLastBlock) });
      continue;
    }

    // 停顿位置吸附到中文词边界
    const boundSet = wordBoundaries(text);
    const boundsArr = [...boundSet].sort((a, b) => a - b);
    const snap = (pos: number): number | null => {
      if (boundSet.has(pos)) return pos;
      let best: number | null = null;
      let bestDist = 5;
      for (const b of boundsArr) {
        const d = Math.abs(b - pos);
        if (d < bestDist) {
          best = b;
          bestDist = d;
        }
      }
      return best;
    };

    const marks: number[] = [];
    for (const p of pauses) {
      if (p.dur < opts.commaPauseSec) continue;
      const at = snap(p.pos);
      if (at === null || at <= 0 || at >= text.length) continue;
      // 别切在黏着字前面（「竞争/者」「用它的/GPU」这类）
      if (clingsForward(text, at)) continue;
      marks.push(at);
    }

    // 逗号数量上限：大约每 14 个字一个。
    // 词级对齐有噪声，不加限制会冒出「牺牲了几，十万人」这种错逗号；
    // 这里只保留停顿最长的几个。
    const maxCommas = Math.max(1, Math.floor(text.length / 14));
    const ranked = [...new Set(marks)]
      .map((pos) => ({
        pos,
        dur: pauses.reduce((best, p) => (snap(p.pos) === pos ? Math.max(best, p.dur) : best), 0),
      }))
      .sort((a, b) => b.dur - a.dur)
      .slice(0, maxCommas)
      .sort((a, b) => a.pos - b.pos);
    const uniqueMarks = ranked.map((x) => x.pos);

    const duration = block.end - block.start;
    const durationCuts = Math.max(0, Math.ceil(duration / opts.maxSegmentSec) - 1);
    const charCuts = Math.max(0, Math.ceil(text.length / opts.maxSegmentChars) - 1);
    const wantCuts = Math.max(durationCuts, charCuts);

    let cuts: number[] = [];
    if (wantCuts > 0 && uniqueMarks.length) {
      // 切点选停顿最长的几处；弱停顿留在段内当逗号
      cuts = uniqueMarks
        .map((pos) => ({
          pos,
          dur: pauses.reduce((b, p) => (snap(p.pos) === pos ? Math.max(b, p.dur) : b), 0),
        }))
        .sort((a, b) => b.dur - a.dur)
        .slice(0, wantCuts)
        .map((x) => x.pos)
        .sort((a, b) => a - b);
    }

    // 按切点切片，切点同时也是逗号位置
    const ranges: [number, number][] = [];
    let cursor = 0;
    for (const c of cuts) {
      if (c > cursor) {
        ranges.push([cursor, c]);
        cursor = c;
      }
    }
    ranges.push([cursor, text.length]);

    const timeAt = (pos: number): number => {
      let acc = 0;
      for (const w of inside) {
        const wEnd = acc + w.word.length;
        if (pos >= acc && pos <= wEnd) return pos === wEnd ? w.end : w.start;
        acc = wEnd;
      }
      return inside[inside.length - 1].end;
    };

    for (let ri = 0; ri < ranges.length; ri += 1) {
      const [a, b] = ranges[ri];
      let body = '';
      let prev = a;
      for (const m of uniqueMarks) {
        if (m <= a || m >= b) continue;
        body += `${text.slice(prev, m)}，`;
        prev = m;
      }
      body += text.slice(prev, b);
      body = body.replace(/^[，、]+/, '').replace(/，{2,}/g, '，');
      if (!body.trim()) continue;
      out.push({
        start: timeAt(a),
        end: timeAt(b),
        speaker: block.speaker,
        text: withPunct(body, isLastBlock && ri === ranges.length - 1),
      });
    }
  }

  return out;
}
