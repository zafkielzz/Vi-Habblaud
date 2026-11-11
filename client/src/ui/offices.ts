// Offices, from the snapshot (pure: tested in offices.test.ts). An office is one team in ONE project folder: its boss,
// its workers (shared between offices), its to-do list (the HANDOFF file of its folder) and its jobs. The page shows one
// office at a time (the office tabs above the top bar, ui/office-tabs.ts): the sidebar, the Board and the quota
// follow it, and the pixel office dims what is not part of it (ctx.officeFocus(), client/src/world/*).
import type { AgentInfo, HandoffPlan, JobBoardItem, OfficeInfo, OfficeSnapshot, RoomInfo, TeamInfo, WorkerId } from '../../../shared/types';
import { sessionAgentIn } from './workers-api';
import { FOLDER_CLASH, folderRelation, isDiskRoot, trimFolder } from '../../../shared/folders';

/** The office shown, remembered in this browser. */
export const OFFICE_KEY = 'habblaud.office';

/** What ctx.officeFocus() returns: the rooms and characters of the selected office (the rest is dimmed). */
export interface OfficeFocus {
  roomIds: ReadonlySet<string>;
  agentIds: ReadonlySet<string>;
  /** The office shown: the world dims every other building whole (roomIds/agentIds are then only a fallback). */
  office?: string;
}

type TeamPart = Pick<TeamInfo, 'offices' | 'workers' | 'bossAccount' | 'bossKind' | 'pendingBoss' | 'waitingBoss'>;

/**
 * Every office, in creation order. A server from before offices sends the old single team: it becomes one office
 * (id "main", no folder), like the server's own conversion of a v2 team file.
 */
export function teamOffices(team: TeamPart | undefined): OfficeInfo[] {
  if (!team) return [];
  if (team.offices) return team.offices;
  return [
    {
      id: 'main',
      name: 'Office',
      folder: '',
      workers: team.workers,
      ...(team.bossAccount ? { bossAccount: team.bossAccount } : {}),
      ...(team.bossKind ? { bossKind: team.bossKind } : {}),
      ...(team.pendingBoss ? { pendingBoss: team.pendingBoss } : {}),
      ...(team.waitingBoss ? { waitingBoss: team.waitingBoss } : {}),
    },
  ];
}

/** The office with this id, else the first one (a deleted or unknown id falls back). */
export function pickOffice(offices: readonly OfficeInfo[], id: string | null | undefined): OfficeInfo | undefined {
  return offices.find((o) => o.id === id) ?? offices[0];
}

/** The room of the office's folder: the server's roomId, else a room with that path. */
export function officeRoom(snap: Pick<OfficeSnapshot, 'rooms'> | null | undefined, office: OfficeInfo | undefined): RoomInfo | undefined {
  if (!office || !snap) return undefined;
  return (office.roomId ? snap.rooms.find((r) => r.id === office.roomId) : undefined) ?? (office.folder ? snap.rooms.find((r) => r.path === office.folder) : undefined);
}

/**
 * The office's boss character: its bossAgentId, else the one opened from it ("＋ Boss", not crowned yet). With a
 * single office (or an older server) any crowned agent is its boss.
 */
export function officeBoss(snap: Pick<OfficeSnapshot, 'agents' | 'team'> | null | undefined, office: OfficeInfo | undefined): AgentInfo | undefined {
  if (!snap || !office) return undefined;
  const id = office.bossAgentId ?? office.pendingBoss;
  const byId = id ? snap.agents.find((a) => a.id === id) : undefined;
  if (byId) return byId;
  return teamOffices(snap.team).length <= 1 ? snap.agents.find((a) => a.boss) : undefined;
}

/**
 * Characters of the office's workers: their terminal sessions (the character in that office, one per office), else
 * the Antigravity character "agy:accN".
 */
export function workerAgentIds(team: Pick<TeamInfo, 'sessions'> | undefined, workers: readonly WorkerId[], office?: string): Set<string> {
  const ids = new Set<string>();
  for (const w of workers) {
    const s = team?.sessions?.find((x) => x.worker === w);
    ids.add(s ? sessionAgentIn(s, office) : `agy:${w}`);
  }
  return ids;
}

/** The office whose building holds this room (absent = the first office's). */
export function roomOfficeId(room: Pick<RoomInfo, 'office'>, offices: readonly OfficeInfo[]): string | undefined {
  return room.office ?? offices[0]?.id;
}

/**
 * The office whose building draws this character: its own `office`, else its main agent's (a subagent), else the
 * first office's.
 */
export function agentOfficeId(snap: Pick<OfficeSnapshot, 'agents'> | null | undefined, a: Pick<AgentInfo, 'office' | 'parentId'>, offices: readonly OfficeInfo[]): string | undefined {
  const parent = !a.office && a.parentId ? snap?.agents.find((p) => p.id === a.parentId) : undefined;
  return a.office ?? parent?.office ?? offices[0]?.id;
}

/** The office (id) whose building holds the selected character or room; undefined = unknown or a single office. */
export function officeOfSelection(snap: Pick<OfficeSnapshot, 'agents' | 'rooms' | 'team'> | null | undefined, sel: { type: 'agent' | 'room'; id: string } | null): string | undefined {
  const offices = teamOffices(snap?.team);
  if (!snap || !sel || offices.length <= 1) return undefined;
  if (sel.type === 'agent') {
    const a = snap.agents.find((x) => x.id === sel.id);
    return a ? agentOfficeId(snap, a, offices) : undefined;
  }
  const r = snap.rooms.find((x) => x.id === sel.id);
  return r ? roomOfficeId(r, offices) : undefined;
}

/** The office (id) a character belongs to as boss, or undefined. */
export function bossOfficeOf(snap: Pick<OfficeSnapshot, 'agents' | 'team'> | null | undefined, agentId: string): OfficeInfo | undefined {
  return teamOffices(snap?.team).find((o) => officeBoss(snap, o)?.id === agentId);
}

/**
 * Rooms and characters of the office's building, for the dimming of the pixel office; null = nothing to dim (one
 * office or none). Each office is a building of its own: rooms by `room.office`, characters by `agent.office`
 * (absent = the first office's building).
 */
export function officeFocus(snap: Pick<OfficeSnapshot, 'agents' | 'rooms' | 'team'> | null | undefined, office: OfficeInfo | undefined): OfficeFocus | null {
  const offices = teamOffices(snap?.team);
  if (!snap || !office || offices.length <= 1) return null;
  const roomIds = new Set(snap.rooms.filter((r) => roomOfficeId(r, offices) === office.id).map((r) => r.id));
  const agentIds = new Set(snap.agents.filter((a) => agentOfficeId(snap, a, offices) === office.id).map((a) => a.id));
  return { roomIds, agentIds, office: office.id };
}

/** Same rooms and characters (the world redraws only when the focus really changed). */
export function sameFocus(a: OfficeFocus | null, b: OfficeFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.office !== b.office || a.roomIds.size !== b.roomIds.size || a.agentIds.size !== b.agentIds.size) return false;
  for (const id of a.roomIds) if (!b.roomIds.has(id)) return false;
  for (const id of a.agentIds) if (!b.agentIds.has(id)) return false;
  return true;
}

/** A job given by this office. A job without one (a script, another session) belongs to no office. */
export function jobInOffice(item: Pick<JobBoardItem, 'office'>, office: OfficeInfo | undefined): boolean {
  return !office || item.office === office.id;
}

/** A to-do list: the HANDOFF file of a room, or of an office's folder while nobody works there (plan undefined = none yet). */
export interface TodoList {
  /** The room's name, else the folder's. */
  name: string;
  /** What POST /api/board/todo edits. */
  target: { room: string } | { office: string };
  plan?: HandoffPlan;
}

export function roomTodo(room: RoomInfo): TodoList {
  return { name: room.name, target: { room: room.id }, ...(room.plan ? { plan: room.plan } : {}) };
}

/** The office's to-do list: its folder's room, else its folder read by the server (OfficeInfo.plan). */
export function officePlan(snap: Pick<OfficeSnapshot, 'rooms'> | null | undefined, office: OfficeInfo | undefined): TodoList | undefined {
  const room = officeRoom(snap, office);
  if (room) return roomTodo(room);
  if (!office?.folder) return undefined;
  return { name: office.folder.split(/[\\/]/).filter(Boolean).pop() || office.folder, target: { office: office.id }, ...(office.plan ? { plan: office.plan } : {}) };
}

/**
 * The office a job from the page goes to: the selected one when the worker belongs to it, else none (the server
 * picks the first office that has the worker).
 */
export function officeForWorker(office: OfficeInfo | undefined, worker: WorkerId): string | undefined {
  return office && office.workers.includes(worker) ? office.id : undefined;
}

/** Other offices this worker also works for (names). */
export function otherOfficesOf(offices: readonly OfficeInfo[], worker: WorkerId, except: string | undefined): string[] {
  return offices.filter((o) => o.id !== except && o.workers.includes(worker)).map((o) => o.name);
}

/** The office whose boss is this Antigravity account (an agy account is boss of one office only, and then no worker). */
export function agyBossOffice(offices: readonly OfficeInfo[], account: string): OfficeInfo | undefined {
  return offices.find((o) => o.bossKind === 'agy' && o.bossAccount === account);
}

/**
 * Why a folder cannot be an office's: '' when it can (absolute, not the whole disk, not another office's folder:
 * nested folders are fine); 'used:<office>'. Symlinks are only resolved by the server, which
 * then answers with its own reason.
 */
export function folderProblem(offices: readonly OfficeInfo[], folder: string, except?: string): string {
  const f = normFolder(folder);
  if (!f) return 'empty';
  if (!f.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(f)) return 'relative';
  if (isDiskRoot(f)) return 'root';
  for (const o of offices) {
    if (o.id === except || !o.folder) continue;
    const rel = folderRelation(f, o.folder);
    if (FOLDER_CLASH.has(rel)) return `used:${o.name}`;
  }
  return '';
}

/** Another office with this one's very folder: a team file from before the rule. Nested folders are fine. */
export function folderOverlap(offices: readonly OfficeInfo[], office: OfficeInfo): OfficeInfo | undefined {
  if (!office.folder) return undefined;
  return offices.find((o) => o.id !== office.id && o.folder && FOLDER_CLASH.has(folderRelation(office.folder, o.folder)));
}

/** "/a/b/" -> "/a/b" (but "/" stays). */
export function normFolder(folder: string): string {
  return trimFolder(folder);
}
