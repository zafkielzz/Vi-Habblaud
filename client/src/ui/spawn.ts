// Recent project folders for "＋ Boss" (ui/team-dialogs.ts): the computer's recent projects (GET /api/spawn/folders:
// session history + rooms), falling back to the office's room folders. (The old "New agent" button is gone: ＋ Boss in
// the sidebar opens sessions now.)
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';

export interface FolderOption {
  path: string;
  name: string;
  lastAt: number;
  sessions?: number;
}

/** Room folders, newest to oldest (fallback when server does not provide list). */
export function spawnFolders(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): string[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  const paths = [...snap.rooms]
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0))
    .map((r) => r.path);
  return [...new Set(paths)];
}

/** Short path for the list: home folder becomes "~". */
export function shortPath(path: string): string {
  return path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/i, '~');
}

/** The computer's recent projects (server); empty when it does not answer. */
export async function loadFolders(): Promise<FolderOption[]> {
  try {
    const res = await fetch('/api/spawn/folders', { credentials: 'same-origin', cache: 'no-store' });
    const r = (await res.json()) as { folders?: FolderOption[] };
    return res.ok && Array.isArray(r.folders) ? r.folders : [];
  } catch {
    return [];
  }
}
