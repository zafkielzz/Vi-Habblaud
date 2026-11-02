// Suggested folders in "New agent": projects you worked on most recently, to choose with a tap instead of
// remembering the path. Sourced from session history (transcript `cwd`, across all accounts and tools) and office
// rooms. Agent worktrees (<project>/.claude/worktrees/<name>) count as the project; temporary folders
// (and Claude desktop app scratch-workspaces) are excluded. Pure Node: only combines and sorts (transcript reading
// is in sources/history.ts).

export interface SpawnFolder {
  /** Absolute path on Claude app's machine. */
  path: string;
  /** Short name (last part of the path). */
  name: string;
  /** Most recent activity (epoch ms; 0 = room only, no timestamp). */
  lastAt: number;
  /** Recent sessions in this folder. */
  sessions: number;
}

export const FOLDERS_LIMIT = 15;

const TEMP = /^(\/private)?\/(tmp|var\/folders|var\/tmp)(\/|$)/;
/** Disposable folders that Claude desktop app creates for projectless sessions. */
const SCRATCH = /\/Application Support\/Claude\/scratch-workspaces\//;
const WORKTREE = /^(.*?)\/\.(claude|codex)\/worktrees\/[^/]+(\/.*)?$/;

function absolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/** Project folder for a session path (worktree becomes project; temp or relative = undefined). */
export function projectFolder(raw: string | undefined): string | undefined {
  const p = raw?.trim().replace(/[\\/]+$/, '');
  if (!p || !absolute(p) || TEMP.test(p) || SCRATCH.test(p)) return undefined;
  const wt = WORKTREE.exec(p);
  return wt ? wt[1] || undefined : p;
}

/** Combines sessions and rooms into unique folders, ordered from most recent to oldest activity. */
export function recentFolders(
  sessions: ReadonlyArray<{ project?: string; lastAt: number }>,
  rooms: ReadonlyArray<{ path?: string; lastAt?: number }>,
  limit = FOLDERS_LIMIT,
): SpawnFolder[] {
  const byPath = new Map<string, SpawnFolder>();
  const add = (raw: string | undefined, lastAt: number, session: boolean) => {
    const path = projectFolder(raw);
    if (!path) return;
    const cur = byPath.get(path);
    if (cur) {
      cur.lastAt = Math.max(cur.lastAt, lastAt);
      if (session) cur.sessions++;
    } else byPath.set(path, { path, name: path.split(/[\\/]/).pop() || path, lastAt, sessions: session ? 1 : 0 });
  };
  for (const s of sessions) add(s.project, s.lastAt, true);
  for (const r of rooms) add(r.path, r.lastAt ?? 0, false);
  return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt || a.path.localeCompare(b.path)).slice(0, limit);
}
