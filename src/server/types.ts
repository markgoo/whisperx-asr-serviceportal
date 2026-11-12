/** Shared types between the portal server and its browser client. */

export type Role = 'superadmin' | 'admin' | 'user';
export type UserStatus = 'active' | 'disabled';
export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

/** User shape sent to the browser — never includes the password hash. */
export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  taskCount?: number;
  storageBytes?: number;
}

export interface TaskRow {
  id: number;
  user_id: number;
  title: string;
  status: TaskStatus;
  stage: string;
  progress: number;
  error_message: string | null;
  file_id: string | null;
  original_name: string;
  storage_path: string | null;
  file_size: number;
  mime_type: string;
  duration: number | null;
  diarize: number;
  num_speakers: number | null;
  min_speakers: number | null;
  max_speakers: number | null;
  language: string | null;
  model: string | null;
  task_type: string;
  initial_prompt: string | null;
  hotwords: string | null;
  word_timestamps: number;
  result_text: string | null;
  result_json: string | null;
  segment_count: number;
  speaker_count: number;
  /** 说话人显示名映射 JSON：{"SPEAKER_00":"张三"} */
  speaker_names: string;
  detected_lang: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  elapsed_ms: number | null;
  retry_count: number;
}

export interface SegmentDto {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

export interface SpeakerLine {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface TaskDto {
  id: number;
  ownerId: number;
  ownerName?: string;
  title: string;
  status: TaskStatus;
  stage: string;
  progress: number;
  errorMessage: string | null;
  originalName: string;
  fileSize: number;
  mimeType: string;
  duration: number | null;
  diarize: boolean;
  numSpeakers: number | null;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  language: string | null;
  model: string | null;
  taskType: string;
  initialPrompt: string | null;
  hotwords: string | null;
  wordTimestamps: boolean;
  segmentCount: number;
  speakerCount: number;
  /** 说话人原始标签 -> 用户自定义名字 */
  speakerNames: Record<string, string>;
  detectedLang: string | null;
  text: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  retryCount: number;
  hasFile: boolean;
  fileId: string | null;
}

export interface TaskDetailDto extends TaskDto {
  segments: SegmentDto[];
  speakerLines: SpeakerLine[];
}

export interface AppSettings {
  asrBaseUrl: string;
  asrTimeoutSec: number;
  defaultModel: string;
  defaultDiarize: boolean;
  defaultMinSpeakers: string;
  defaultMaxSpeakers: string;
  storageRetainDays: number;
  storageQuotaMb: number;
  allowRegistration: boolean;
  /** 转写结果后处理开关 */
  normalizeEnabled: boolean;
  /** 繁转简 */
  normalizeToSimplified: boolean;
  /** 用户自定义术语词典（每行 “错误=正确”） */
  normalizeTerms: string;
  /** 按停顿重切分段（长句不再挤成一坨） */
  splitEnabled: boolean;
  /** 判定停顿的秒数阈值 */
  splitPauseSec: number;
}

export interface StorageItem {
  id: string;
  /** 所属任务 id */
  taskId: number;
  fileName: string;
  size: number;
  uploadedAt: string;
  ownerId: number;
  ownerName: string;
  title: string;
  status: TaskStatus;
}

export interface StorageSummary {
  totalBytes: number;
  fileCount: number;
  orphanBytes: number;
  orphanCount: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  quotaMb: number;
  uploadDir: string;
}

export interface AsrHealth {
  reachable: boolean;
  baseUrl: string;
  latencyMs: number | null;
  device?: string;
  version?: string;
  serveMode?: string;
  error?: string;
}
