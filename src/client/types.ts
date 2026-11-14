/** 与后端共享的视图类型（浏览器端使用）。 */

export type Role = 'superadmin' | 'admin' | 'user';
export type TaskStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'canceled';

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  taskCount?: number;
  storageBytes?: number;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
  /** 用户手动指定过归属（不参与自动重新分析） */
  manual?: boolean;
}

export interface SpeakerLine {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Task {
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

export interface TaskDetail extends Task {
  segments: Segment[];
  speakerLines: SpeakerLine[];
}

export interface Settings {
  asrBaseUrl: string;
  asrTimeoutSec: number;
  defaultModel: string;
  defaultDiarize: boolean;
  defaultMinSpeakers: string;
  defaultMaxSpeakers: string;
  storageRetainDays: number;
  storageQuotaMb: number;
  allowRegistration: boolean;
  puncServiceUrl: string;
  puncEnabled: boolean;
  splitEnabled: boolean;
  splitPauseSec: number;
  normalizeEnabled: boolean;
  normalizeToSimplified: boolean;
  normalizeTerms: string;
  canManageUsers: boolean;
  canManageSettings: boolean;
  isSuperadmin: boolean;
  role: Role;
}

export interface StorageItem {
  id: string;
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
  taskCount: number;
  orphanBytes: number;
  orphanCount: number;
  diskFreeBytes: number;
  diskTotalBytes: number;
  quotaMb: number;
  uploadDir: string;
  databasePath: string;
}

export interface Dashboard {
  stats: Record<TaskStatus, number>;
  total: number;
  totalBytes: number;
  totalSeconds: number;
  userCount: number;
  recent: Task[];
}

export interface TaskListResponse {
  tasks: Task[];
  total: number;
  page: number;
  pageSize: number;
  byStatus: Record<string, number>;
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
