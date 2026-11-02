// What the Board shows, from the snapshot (pure: tested in board-model.test.ts).
// - The boss's to-do list: the "next steps" of the HANDOFF file in the office's folder (RoomInfo.plan), else in the
//   boss's folder; without a boss (and a single office), the newest list of any room.
// - The workers' jobs of the office shown (each job carries the office that gave it).
// - Important news: failed jobs and quota hits today, and who needs you now (fixed rules, no tokens).
import type { JobBoardItem, NewsItem, OfficeInfo, OfficeSnapshot, RoomInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { jobInOffice, officeBoss, officePlan, roomTodo, teamOffices, type TodoList } from './offices';

/** Kept for callers that still name a part of the Board; the Board shows everything at once. */
export type BoardTab = 'tasks' | 'jobs' | 'news';

/** Important news shown at most. */
export const NEWS_SHOWN = 8;

type PlanSnap = Pick<OfficeSnapshot, 'agents' | 'rooms'> & Partial<Pick<OfficeSnapshot, 'team'>>;

/**
 * The to-do list of the office shown (plan undefined = no list yet): its folder's (read by the server even while
 * nobody works there); an office without a folder (or the old single team) uses its boss's folder, and with a single
 * office and no boss the newest list of any room.
 */
export function bossPlan(snap: PlanSnap | null | undefined, office?: OfficeInfo): TodoList | undefined {
  if (office && (office.folder || office.roomId)) return officePlan(snap, office);
  const boss = office ? officeBoss(snap, office) : snap?.agents.find((a) => a.boss);
  const room = boss && snap?.rooms.find((r) => r.id === boss.roomId);
  if (room) return roomTodo(room);
  if (office && teamOffices(snap?.team).length > 1) return undefined;
  const any = (snap?.rooms ?? []).filter((r) => r.plan).sort((a, b) => b.plan!.mtime - a.plan!.mtime)[0];
  return any && roomTodo(any);
}

/** The jobs of the office shown: a job from anywhere else (another session or folder, no office) is not its business. */
export function officeItems<T extends Pick<JobBoardItem, 'office'>>(items: readonly T[], office: OfficeInfo | undefined): T[] {
  return items.filter((it) => jobInOffice(it, office));
}

/** "cache: 12k read, 3k written" for a job that reports it; '' otherwise. */
export function cacheLabel(it: Pick<JobBoardItem, 'cacheRead' | 'cacheWrite'>, fmt: (n: number) => string): string {
  const parts = [it.cacheRead ? tr('{0} read', [fmt(it.cacheRead)]) : '', it.cacheWrite ? tr('{0} written', [fmt(it.cacheWrite)]) : ''].filter(Boolean);
  return parts.length ? tr('cache: {0}', [parts.join(', ')]) : '';
}

/** The first room with a job board (the Antigravity workers room). */
export function boardRoom(snap: Pick<OfficeSnapshot, 'rooms'> | null | undefined): RoomInfo | undefined {
  return snap?.rooms.find((r) => r.board);
}

/** Today's failures and quota hits, and the agents waiting for you now; newest first. */
export function importantNews(snap: Pick<OfficeSnapshot, 'agents' | 'news'> | null | undefined, now: number): Array<Pick<NewsItem, 'id' | 'at' | 'icon' | 'text'> & { detail?: string }> {
  const out: Array<Pick<NewsItem, 'id' | 'at' | 'icon' | 'text'> & { detail?: string }> = [];
  for (const n of snap?.news ?? []) {
    if (n.kind !== 'failed' && n.kind !== 'quota' && n.kind !== 'rule' && n.kind !== 'ghost') continue;
    // a refusal says what was refused (otherwise several read the same: "acc2 stopped by the rules of X"), a ghost its PID
    const text = (n.kind === 'rule' || n.kind === 'ghost') && n.detail ? `${n.text} · ${n.detail}` : n.text;
    out.push({ id: n.id, at: n.at, icon: n.icon, text, ...(n.detail ? { detail: n.detail } : {}) });
  }
  for (const a of snap?.agents ?? []) {
    if (a.status !== 'waiting') continue;
    out.push({ id: `waiting:${a.id}`, at: a.statusSince ?? now, icon: '🙋', text: `${a.name}: ${a.waitingFor ?? ''}`.replace(/: $/, ''), detail: a.waitingFor });
  }
  return out.sort((x, y) => y.at - x.at).slice(0, NEWS_SHOWN);
}

/** Whether the toolbar button shows: there is something on the Board. */
export function hasBoard(snap: OfficeSnapshot | null | undefined, office?: OfficeInfo): boolean {
  return !!boardRoom(snap) || !!bossPlan(snap, office) || (snap?.news?.length ?? 0) > 0;
}
