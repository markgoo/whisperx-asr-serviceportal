/** 全局状态与简单路由（基于 hash，无需框架）。 */

import type { PublicUser, Settings } from './types';
import { api, ApiError } from './api';

export interface State {
  user: PublicUser | null;
  settings: Settings | null;
}

export const state: State = { user: null, settings: null };

export type RouteName = 'dashboard' | 'tasks' | 'task' | 'new' | 'storage' | 'users' | 'settings' | 'account';

export interface Route {
  name: RouteName;
  param?: string;
}

export function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [head, rest] = raw.split('/');
  switch (head) {
    case '':
    case 'dashboard':
      return { name: 'dashboard' };
    case 'tasks':
      return rest ? { name: 'task', param: rest } : { name: 'tasks' };
    case 'new':
      return { name: 'new' };
    case 'storage':
      return { name: 'storage' };
    case 'users':
      return { name: 'users' };
    case 'settings':
      return { name: 'settings' };
    case 'account':
      return { name: 'account' };
    default:
      return { name: 'dashboard' };
  }
}

export function navigate(path: string): void {
  if (location.hash === `#${path}`) return;
  location.hash = path;
}

export function isAdmin(): boolean {
  return state.user?.role === 'admin' || state.user?.role === 'superadmin';
}

export function isSuperadmin(): boolean {
  return state.user?.role === 'superadmin';
}

/** Loads the session; returns null when the visitor is not signed in. */
export async function bootstrap(): Promise<PublicUser | null> {
  try {
    const { user, settings } = await api.me();
    state.user = user;
    state.settings = settings;
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.user = null;
      state.settings = null;
      return null;
    }
    throw err;
  }
}

export function setSession(user: PublicUser, settings: Settings): void {
  state.user = user;
  state.settings = settings;
}

export function clearSession(): void {
  state.user = null;
  state.settings = null;
}
