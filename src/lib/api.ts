// Scene storage. The server is the source of truth (so desktop and iPad see
// the same scenes); localStorage holds a draft copy so an unreachable server
// never loses work.

import type { SceneDocument } from '../core/types';

export interface SceneSummary {
  id: string;
  name: string;
  updatedAt: number;
}

const DRAFT_PREFIX = 'plinth:draft:';
const LAST_SCENE_KEY = 'plinth:lastScene';

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${response.status}`);
  return (await response.json()) as T;
}

export const sceneApi = {
  list: () => request<SceneSummary[]>('/api/scenes'),
  get: (id: string) => request<{ id: string; document: SceneDocument }>(`/api/scenes/${encodeURIComponent(id)}`),
  create: (document: SceneDocument) =>
    request<{ id: string }>('/api/scenes', { method: 'POST', body: JSON.stringify({ document }) }),
  save: (id: string, document: SceneDocument) =>
    request<{ id: string; updatedAt: number }>(`/api/scenes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ document }),
    }),
  remove: (id: string) => request<{ ok: true }>(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export function saveDraft(id: string, document: SceneDocument): void {
  try {
    safeStorage()?.setItem(DRAFT_PREFIX + id, JSON.stringify({ savedAt: Date.now(), document }));
  } catch {
    /* quota or private mode — the server copy is still the primary */
  }
}

export function loadDraft(id: string): { savedAt: number; document: SceneDocument } | null {
  try {
    const raw = safeStorage()?.getItem(DRAFT_PREFIX + id);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearDraft(id: string): void {
  try { safeStorage()?.removeItem(DRAFT_PREFIX + id); } catch { /* ignore */ }
}

export function rememberLastScene(id: string): void {
  try { safeStorage()?.setItem(LAST_SCENE_KEY, id); } catch { /* ignore */ }
}

export function lastSceneId(): string | null {
  try { return safeStorage()?.getItem(LAST_SCENE_KEY) ?? null; } catch { return null; }
}
