/**
 * 转写结果后处理。
 *
 * whisper 在中文模式下有几个顽固问题，靠 prompt/hotwords 修不好
 * （提示词会在长音频的静音段被「续写」进正文），所以在拿到结果后统一修正：
 *
 * 1. 英文缩写被逐字拆开：`A I` -> `AI`，`G P U` -> `GPU`，`C U D A` -> `CUDA`
 * 2. 专有名词误识别：`HPM` -> `HBM`，`海靈獅` -> `海力士`
 * 3. 繁体夹杂：整句繁转简
 * 4. 中文之间多余的标点空格
 */
import OpenCC from 'opencc-js';

type Converter = (text: string) => string;

let toSimplified: Converter | null | undefined;

function converter(): Converter | null {
  if (toSimplified !== undefined) return toSimplified;
  try {
    toSimplified = OpenCC.Converter({ from: 'tw', to: 'cn' }) as Converter;
  } catch {
    toSimplified = null;
  }
  return toSimplified;
}

/**
 * 默认术语词典：常见误识别 -> 正确写法。用户可在设置页追加。
 *
 * 这些词条来自 medium 和 large-v3 在真实中文政论/会议录音上的实际错例。
 * 两个模型各有各的错法，所以词库比换模型更可靠。
 */
export const DEFAULT_TERMS: Record<string, string> = {
  // --- 半导体 / 硬件 ---
  HPM: 'HBM',
  HPF: 'HBM',
  '海靈獅': '海力士',
  '海灵狮': '海力士',
  '掏地率': 'CUDA',
  '掏地绿': 'CUDA',
  Cuda: 'CUDA',
  '代空': '代工',
  '带空': '代工',
  '代工人力': '代工能力',
  '伺服器': '服务器',
  // --- 人名 / 机构 ---
  '英偉達': '英伟达',
  '英伟塔': '英伟达',
  '台積電': '台积电',
  '黃仁勳': '黄仁勋',
  '华人君': '华盛顿',
  // 台湾青鸟行动：模型会听成「青江」「金鸟」
  '青江': '青鸟',
  '金鸟': '青鸟',
  // 日本首相高市早苗
  '高市长': '高市',
  // 美军舰名
  '罗斯国号': '罗斯福号',
  // 「代工现在也没有技能值」实际说的是「没有竞争者」
  '技能值': '竞争者',
  // 口语误识别
  '缩夺乌龟': '缩头乌龟',
  '缩头乌龟嘛': '缩头乌龟嘛',
  // --- 数字 / 计量 ---
  '兩個不勝': '两个百分点',
  '两个不胜': '两个百分点',
  '两个不剩': '两个百分点',
  '兩趴': '两个百分点',
  '四个不剩': '四个百分点',
  '四个不胜': '四个百分点',
  // --- 常见工具名 ---
  'GPD的': 'GPT的',
  'G P D': 'GPT',
};

export interface NormalizeOptions {
  /** 关闭后原样返回 */
  enabled: boolean;
  /** 繁体转简体 */
  toSimplified: boolean;
  /** 术语替换（会与 DEFAULT_TERMS 合并，用户项优先） */
  terms: Record<string, string>;
}

/**
 * 合并被空格拆开的英文。
 *
 * 规则分两种，避免误伤正常英文：
 * - 全大写、2 个以上单字母：`A I` -> `AI`，`G P U` -> `GPU`，`C U D A` -> `CUDA`
 * - 大小写混排、3 个以上单字母：`S y s t e m` -> `System`（2 个的不动，容易误判）
 */
export function mergeSplitAcronyms(text: string): string {
  return text
    // 全大写连续单字母
    .replace(/(?<![A-Za-z])(?:[A-Z](?:[ \u00A0]+[A-Z]){1,5})(?![A-Za-z])/g, (m) =>
      m.replace(/[ \u00A0]+/g, ''),
    )
    // 大小写混排连续单字母（3 段以上）
    .replace(
      /(?<![A-Za-z])(?:[A-Za-z](?:[ \u00A0]+[A-Za-z]){2,20})(?![A-Za-z])/g,
      (m) => m.replace(/[ \u00A0]+/g, ''),
    );
}

/**
 * 合并被空格拆开的数字，并贴紧百分号。
 * whisper 会把 `25%` 切成 `2 5 %`，把 `东风61` 切成 `东风6 1`。
 */
export function mergeSplitDigits(text: string): string {
  return text
    .replace(/(?<![0-9])((?:[0-9](?:[ \u00A0]+[0-9]){1,8}))(?![0-9])/g, (m) =>
      m.replace(/[ \u00A0]+/g, ''),
    )
    .replace(/([0-9])[ \u00A0]+%/g, '$1%');
}

/** 应用术语替换（长的先替换，避免短词吃掉长词的一部分）。 */
export function applyTerms(text: string, terms: Record<string, string>): string {  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of keys) {
    if (!key) continue;
    if (out.includes(key)) out = out.split(key).join(terms[key]);
  }
  return out;
}

/** 收拾标点周围的空白：中文标点两侧不留空格。 */
export function tidyPunctuation(text: string): string {
  return text
    .replace(/\s*([，。！？；：、）】》」』])\s*/g, '$1')
    .replace(/\s*([（【《「『])\s*/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** 把设置里的 “错误=正确” 多行文本解析成词典。 */
export function parseTermsText(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const wrong = trimmed.slice(0, idx).trim();
    const right = trimmed.slice(idx + 1).trim();
    if (wrong && right) out[wrong] = right;
  }
  return out;
}

/** 单段文本规范化。 */
export function normalizeText(raw: string, opts: NormalizeOptions): string {
  if (!opts.enabled || !raw) return raw;
  let out = raw;

  const simp = converter();
  if (opts.toSimplified && simp) out = simp(out);

  out = mergeSplitAcronyms(out);
  out = mergeSplitDigits(out);
  out = applyTerms(out, { ...DEFAULT_TERMS, ...opts.terms });
  out = tidyPunctuation(out);
  return out;
}

/** 去掉标点和空白，用于重复检测的比较。 */
function compact(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—\-]/g, '');
}

const PUNCT_RE = /[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]《》<>—\-]/;

/**
 * 把 compact 文本里的字符下标，映射回原始文本的下标。
 * （compact 去掉了标点，直接用比例换算会偏，这里逐字对应。）
 */
function compactIndexToOriginal(text: string, compactIdx: number): number {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (PUNCT_RE.test(text[i])) continue;
    if (count === compactIdx) return i;
    count += 1;
  }
  return text.length;
}

/**
 * 截掉模型在长音频末尾产生的「重复幻觉」。
 *
/**
 * 压缩段内同一个短语的循环重复。
 *
 * whisper 在背景噪音、笑声、听众起哄处会陷入循环，吐出几十遍同一个词：
 *   「没有没有没有没有没有没有没有没有…」（实测连续 40 秒）
 *
 * `truncateRepetition` 处理的是「复述前文」，管不了这种段内循环，
 * 所以单独做一次压缩：同一个短语连续出现 >= minRepeat 次就只留一次。
 * 两个字的「没有没有」这种正常口语（2 次）不会被误伤。
 */
export function collapseRepeats(text: string, minRepeat = 4): string {
  if (!text) return text;
  let out = '';
  let i = 0;

  while (i < text.length) {
    let matched = false;
    // 从长到短找重复单元，优先匹配长短语（「真的没有」「不好意思」）
    for (let len = Math.min(8, text.length - i); len >= 2; len -= 1) {
      const unit = text.slice(i, i + len);
      if (/^[，。！？；、\s]+$/.test(unit)) continue;
      let count = 1;
      let j = i + len;
      while (text.slice(j, j + len) === unit) {
        count += 1;
        j += len;
      }
      if (count >= minRepeat) {
        out += unit;
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += text[i];
      i += 1;
    }
  }

  return out;
}

/**
 * 判断一段是不是「纯幻觉」。
 *
 * 压缩重复后如果几乎没剩下实质内容（例如整段只有「没有」），
 * 说明这是噪音引起的循环输出，不是真人在说话，应该整段丢掉。
 */
export function isHallucination(text: string): boolean {
  const body = text.replace(/[，。！？；、\s]/g, '');
  if (!body) return true;
  const collapsed = collapseRepeats(text).replace(/[，。！？；、\s]/g, '');
  // 压缩后只剩零星重复残留就整段丢掉。正常短句（「对，自发的很」）
  // 压缩前后长度几乎不变，不会被误伤。
  return collapsed.length <= body.length * 0.3 && collapsed.length < 18;
}

/**
 * 截掉录音末尾的重复段落。
 * 做法：把当前段和之前所有段比较，若出现足够长的同文片段，就从那里截断。
 *
 * @param minMatch 触发截断的最短重复长度（去标点后），默认 10 字
 */
export function truncateRepetition<T extends { text: string }>(segments: T[], minMatch = 10): T[] {
  const seen: string[] = [];
  return segments.map((seg) => {
    const body = compact(seg.text);
    let cut = -1;

    if (body.length > minMatch) {
      outer: for (const prev of seen) {
        // 整段就是前文的复述
        if (body.length >= minMatch && prev.includes(body.slice(0, minMatch))) {
          cut = 0;
          break;
        }
        // 正常开头 + 后面接了一段复述：从重复位置截断
        for (let start = minMatch; start + minMatch <= body.length; start += 1) {
          if (prev.includes(body.slice(start, start + minMatch))) {
            cut = start;
            break outer;
          }
        }
      }
    }

    if (cut > 0) {
      const at = compactIndexToOriginal(seg.text, cut);
      const cleaned = trimToSentence(seg.text.slice(0, at).trim());
      if (cleaned.length >= 4) {
        seen.push(body);
        return { ...seg, text: cleaned };
      }
    }
    seen.push(body);
    return seg;
  });
}

/** 截断到最后一个完整句子，避免留下半截话。 */
function trimToSentence(text: string): string {
  const idx = Math.max(
    text.lastIndexOf('。'),
    text.lastIndexOf('！'),
    text.lastIndexOf('？'),
    text.lastIndexOf('，'),
    text.lastIndexOf(','),
  );
  return idx > 0 ? text.slice(0, idx + 1) : text;
}

/** 对分段数组做规范化，返回新数组。 */
export function normalizeSegments<T extends { text: string }>(segments: T[], opts: NormalizeOptions): T[] {
  if (!opts.enabled) return segments;

  // 1. 先用**原始文本**判断是不是纯幻觉段（必须在压缩之前判断，
  //    压缩后重复比例就没了，isHallucination 会永远返回 false）
  const real = segments.filter((s) => !isHallucination(s.text));

  // 2. 压掉段内循环重复（「没有没有没有…」连续 40 秒那种）
  const deduped = real.map((seg) => ({
    ...seg,
    text: collapseRepeats(normalizeText(seg.text, opts)),
  }));

  // 3. 再处理跨段复述
  return truncateRepetition(deduped).filter((s) => s.text.trim().length > 0);
}
