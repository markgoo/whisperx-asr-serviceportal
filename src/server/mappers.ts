import type { SegmentDto, SpeakerLine, TaskDetailDto, TaskDto, TaskRow } from './types';

/** 解析用户给说话人起的名字。坏数据不会让整个任务读不出来。 */
export function safeParseSpeakerNames(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 40);
    }
    return out;
  } catch {
    return {};
  }
}

export function safeParseSegments(raw: string | null): SegmentDto[] {  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as SegmentDto[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s.text === 'string')
      .map((s) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text),
        speaker: s.speaker ? String(s.speaker) : null,
      }));
  } catch {
    return [];
  }
}

/** Merge consecutive segments of the same speaker into readable paragraphs. */
export function buildSpeakerLines(segments: SegmentDto[]): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  for (const seg of segments) {
    const speaker = seg.speaker || 'SPEAKER_?';
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker) {
      last.end = seg.end;
      last.text = `${last.text} ${seg.text}`.trim();
    } else {
      lines.push({ speaker, start: seg.start, end: seg.end, text: seg.text.trim() });
    }
  }
  return lines;
}

export function toTaskDto(row: TaskRow, ownerName?: string): TaskDto {
  return {
    id: row.id,
    ownerId: row.user_id,
    ownerName,
    title: row.title,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    errorMessage: row.error_message,
    originalName: row.original_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    duration: row.duration,
    diarize: row.diarize === 1,
    numSpeakers: row.num_speakers,
    minSpeakers: row.min_speakers,
    maxSpeakers: row.max_speakers,
    language: row.language,
    model: row.model,
    taskType: row.task_type,
    initialPrompt: row.initial_prompt,
    hotwords: row.hotwords,
    wordTimestamps: row.word_timestamps === 1,
    segmentCount: row.segment_count,
    speakerCount: row.speaker_count,
    speakerNames: safeParseSpeakerNames(row.speaker_names),
    detectedLang: row.detected_lang,
    text: row.result_text,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    elapsedMs: row.elapsed_ms,
    retryCount: row.retry_count,
    hasFile: !!row.storage_path,
    fileId: row.file_id,
  };
}

export function toTaskDetailDto(row: TaskRow, ownerName?: string): TaskDetailDto {
  const segments = safeParseSegments(row.result_json);
  return {
    ...toTaskDto(row, ownerName),
    segments,
    speakerLines: buildSpeakerLines(segments),
  };
}
