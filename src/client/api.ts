/** 后端 API 调用封装。所有请求都带 cookie，401 统一抛 UnauthorizedError。 */

import type {
  AsrHealth,
  Dashboard,
  PublicUser,
  Settings,
  StorageItem,
  StorageSummary,
  Task,
  TaskDetail,
  TaskListResponse,
  TaskStatus,
} from './types';

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: init.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string };
    throw new ApiError(payload.error || `请求失败 (${res.status})`, res.status, payload.code);
  }
  return data as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: PublicUser; settings: Settings }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),

  me: () => request<{ user: PublicUser; settings: Settings }>('/auth/me'),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // users
  listUsers: () => request<{ users: PublicUser[] }>('/users'),
  createUser: (payload: { username: string; displayName: string; password: string; role: string }) =>
    request<{ user: PublicUser }>('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (
    id: number,
    payload: Partial<{ displayName: string; role: string; status: string; password: string }>,
  ) => request<{ user: PublicUser }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteUser: (id: number) => request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),

  // settings
  getSettings: () => request<{ settings: Settings }>('/settings'),
  saveSettings: (payload: Partial<Settings>) =>
    request<{ settings: Settings }>('/settings', { method: 'PUT', body: JSON.stringify(payload) }),
  asrHealth: () => request<AsrHealth>('/asr/health'),
  puncHealth: () => request<{ reachable: boolean; configured: boolean; latencyMs: number | null; model?: string; device?: string; error?: string; baseUrl?: string }>('/punc/health'),

  // dashboard
  dashboard: () => request<Dashboard>('/dashboard'),

  // tasks
  listTasks: (params: {
    page?: number;
    pageSize?: number;
    status?: string;
    search?: string;
    scope?: string;
    ownerId?: number;
  }) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    }
    return request<TaskListResponse>(`/tasks?${q.toString()}`);
  },

  getTask: (id: number) => request<{ task: TaskDetail }>(`/tasks/${id}`),
  renameTask: (id: number, title: string) =>
    request<{ task: Task }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  retryTask: (id: number) => request<{ task: Task }>(`/tasks/${id}/retry`, { method: 'POST' }),
  reprocessTask: (id: number) => request<{ task: Task }>(`/tasks/${id}/reprocess`, { method: 'POST' }),

  /** 改某几段的说话人归属（人工标注，只影响这几段） */
  assignSpeakers: (id: number, updates: Array<{ index: number; speaker: string | null }>) =>
    request<{ task: TaskDetail; applied: number }>(`/tasks/${id}/speakers/assign`, {
      method: 'POST',
      body: JSON.stringify({ updates }),
    }),

  /** 把一段在指定字符位置拆成两段 */
  /** 把一段按多个切分点拆成多段 */
  splitSegment: (id: number, index: number, cuts: number[]) =>
    request<{ task: TaskDetail; pieces: number }>(`/tasks/${id}/segments/split`, {
      method: 'POST',
      body: JSON.stringify({ index, cuts }),
    }),

  /** 用人工标注的段落做种子，重新分析其他段落的说话人 */
  reanalyzeSpeakers: (id: number) =>
    request<{ task: TaskDetail; changed: number; seeds: number; elapsedMs: number }>(
      `/tasks/${id}/speakers/reanalyze`,
      { method: 'POST' },
    ),
  renameSpeakers: (id: number, names: Record<string, string>) =>
    request<{ task: TaskDetail }>(`/tasks/${id}/speakers`, {
      method: 'PATCH',
      body: JSON.stringify({ names }),
    }),
  cancelTask: (id: number) => request<{ task: Task }>(`/tasks/${id}/cancel`, { method: 'POST' }),
  deleteTask: (id: number, deleteFile = true) =>
    request<{ ok: boolean }>(`/tasks/${id}?deleteFile=${deleteFile ? '1' : '0'}`, { method: 'DELETE' }),

  createTask: (form: FormData, onProgress?: (percent: number) => void) =>
    new Promise<{ task: Task }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/tasks');
      xhr.withCredentials = true;
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && onProgress) onProgress(Math.round((ev.loaded / ev.total) * 100));
      };
      xhr.onload = () => {
        let data: unknown = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = null;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as { task: Task });
        else {
          const payload = (data ?? {}) as { error?: string; code?: string };
          reject(new ApiError(payload.error || `上传失败 (${xhr.status})`, xhr.status, payload.code));
        }
      };
      xhr.onerror = () => reject(new ApiError('网络错误，上传失败', 0, 'network'));
      xhr.ontimeout = () => reject(new ApiError('上传超时', 0, 'timeout'));
      xhr.send(form);
    }),

  // storage
  storage: () => request<{ items: StorageItem[]; summary: StorageSummary }>('/storage'),
  deleteStorageFile: (taskId: number) =>
    request<{ ok: boolean; freed: number }>(`/storage/tasks/${taskId}`, { method: 'DELETE' }),
  cleanOrphans: () =>
    request<{ removed: number; freed: number }>('/storage/orphans', { method: 'DELETE' }),
  cleanupByAge: (retainDays: number) =>
    request<{ removed: number; freed: number; retainDays: number }>('/storage/cleanup', {
      method: 'POST',
      body: JSON.stringify({ retainDays }),
    }),
};

export type { TaskStatus };
