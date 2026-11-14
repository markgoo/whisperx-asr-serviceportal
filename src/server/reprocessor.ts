/**
 * 从词级时间戳重建分段。
 *
 * 抽出来的原因：worker（新转写）和 reprocess（重新修正）要走**完全一样**的
 * 分段逻辑，否则「重新修正」出来的结果和新转写的不一致，调试时分不清问题
 * 是逻辑本身还是路径差异。
 *
 * 不包括标点：标点要调外部服务（异步），由调用方决定要不要跑。
 */
import type { AsrSegment, AsrWord } from './asrClient';
import { DEFAULT_SPLIT, mergeShortSegments, punctuate, smoothSpeakers, splitByPause } from './segmenter';
import { normalizeSegments, type NormalizeOptions } from './normalizer';

export interface RebuildOptions {
  /** 是否按停顿重切分段 */
  splitEnabled: boolean;
  /** 强停顿阈值（秒） */
  splitPauseSec: number;
  normalize: NormalizeOptions;
}

/**
 * 从原始分段 + 词级时间戳重建。
 *
 * @param rawSegments whisper 的原始分段，用作「取词不全」时的兜底文本
 * @param words       词级时间戳（含 speaker）
 * @param silence     VAD 静音区间，没有就退回按词时长估算
 */
export function rebuildSegments(
  rawSegments: AsrSegment[],
  words: AsrWord[],
  silence: Array<[number, number]> | undefined,
  opts: RebuildOptions,
): AsrSegment[] {
  const splitOpts = { ...DEFAULT_SPLIT, pauseSec: opts.splitPauseSec };

  const split = opts.splitEnabled
    ? mergeShortSegments(splitByPause(rawSegments, words, splitOpts, silence))
    : mergeShortSegments(rawSegments.map((s) => ({ ...s, text: punctuate(s.text) })));

  // 说话人平滑：diarization 的切换点有抖动，会切出 0.1 秒的碎片和假换人
  const smoothed = smoothSpeakers(split);

  return normalizeSegments(smoothed, opts.normalize);
}
