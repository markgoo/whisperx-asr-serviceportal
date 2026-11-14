/**
 * 段落级说话人归属调整（人工标注）。
 *
 * 和「改名字」是两件事：
 *   - 改名字：SPEAKER_00 → "主持人"，是标签到显示名的映射，全局生效
 *   - 改归属：把**这一段**改成「另一个人说的」，只影响这一段
 *
 * 手动改过的段落会被标记 manual=true，后面可以拿它们当种子，
 * 让系统按人工标注把其他段落重新分类。
 */
import type { AsrSegment } from './asrClient';

export interface SpeakerUpdate {
  index: number;
  speaker: string | null;
}

/** 带人工标注标记的段落。 */
export interface LabeledSegment extends AsrSegment {
  /** 用户手动指定过归属 */
  manual?: boolean;
}

/**
 * 应用一批归属修改。
 *
 * @returns 更新后的段落数组；索引非法的项会被跳过
 */
export function applySpeakerUpdates(
  segments: AsrSegment[],
  updates: SpeakerUpdate[],
): { segments: LabeledSegment[]; applied: number } {
  const out: LabeledSegment[] = segments.map((s) => ({ ...s }));
  let applied = 0;

  for (const u of updates) {
    const i = u.index;
    if (!Number.isInteger(i) || i < 0 || i >= out.length) continue;
    const next = u.speaker === null || u.speaker === '' ? null : String(u.speaker).slice(0, 40);
    if (out[i].speaker === next && out[i].manual) continue;
    out[i].speaker = next;
    out[i].manual = true;
    applied += 1;
  }

  return { segments: out, applied };
}

/** 取出被人工标注过的段落，作为种子。 */
export function collectSeeds(segments: LabeledSegment[]): { start: number; end: number; speaker: string }[] {
  const seeds = [];
  for (const s of segments) {
    if (s.manual && s.speaker) {
      seeds.push({ start: s.start, end: s.end, speaker: s.speaker });
    }
  }
  return seeds;
}
