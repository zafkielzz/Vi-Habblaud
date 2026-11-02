// Level, XP, and achievements of an Antigravity worker, computed solely from "end" lines in agy-ask.log.jsonl
// (nothing stored separately: booting re-reads the log to arrive at the same state). Pure and deterministic.
//
// XP per job: success = 10 + 1 per 5k tokens (at most +40); failure (timeout, killed) = 2.
// Level n starts at 25·n·(n−1) XP (0, 50, 150, 300, 500...): early levels climb quickly, then progression slows.
import type { WorkerBadge, WorkerProgress } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import type { AgyAskLine } from './source';

/** XP at the start of level `n` (n >= 1). */
export function levelStart(n: number): number {
  return 25 * n * (n - 1);
}

export function levelOf(xp: number): number {
  let n = 1;
  while (levelStart(n + 1) <= xp) n++;
  return n;
}

/** Title by level (just for fun). */
export function rankOf(level: number): string {
  if (level <= 2) return tr('Intern');
  if (level <= 4) return tr('Junior');
  if (level <= 7) return tr('Mid-level');
  if (level <= 11) return tr('Senior');
  return tr('Legend');
}

interface BadgeDef {
  icon: string;
  name: () => string;
  desc: () => string;
}

/** Achievements, in the order they appear in the drawer. */
export const BADGES: Readonly<Record<string, BadgeDef>> = {
  first: { icon: '🐣', name: () => tr('First job'), desc: () => tr('Finished the first job.') },
  flash: { icon: '⚡', name: () => tr('Lightning'), desc: () => tr('Finished a job in 10 s or less.') },
  owl: { icon: '🦉', name: () => tr('Night owl'), desc: () => tr('Worked between midnight and 5 am.') },
  marathon: { icon: '🏃', name: () => tr('Marathon'), desc: () => tr('Finished a job of 10 min or more.') },
  survivor: { icon: '👻', name: () => tr('Survivor'), desc: () => tr('Finished a job again after a timeout.') },
  streak: { icon: '🔥', name: () => tr('Unbeatable'), desc: () => tr('25 jobs in a row without failing.') },
  hundred: { icon: '💯', name: () => tr('Centurion'), desc: () => tr('100 jobs done.') },
  million: { icon: '💰', name: () => tr('Token millionaire'), desc: () => tr('Went past 1 million tokens.') },
};

/** What changed with a line: leveled up and/or unlocked achievements. */
export interface ProgressEvent {
  levelUp?: number;
  badges: string[];
}

export class WorkerTracker {
  private xp = 0;
  private done = 0;
  private tokens = 0;
  private streak = 0;
  private timedOut = false;
  private readonly badges = new Map<string, number>();

  /** Applies an "end" line (other lines are ignored). */
  feed(line: AgyAskLine): ProgressEvent {
    const ev: ProgressEvent = { badges: [] };
    if (line.event !== 'end') return ev;
    const at = (line.ts ?? 0) * 1000;
    const before = levelOf(this.xp);
    const earn = (id: string) => {
      if (this.badges.has(id)) return;
      this.badges.set(id, at);
      ev.badges.push(id);
    };
    const ok = line.status === 'SUCCESS';
    const used = line.usage?.total_tokens ?? 0;
    this.tokens += used;
    if (ok) {
      this.done++;
      this.streak++;
      this.xp += 10 + Math.min(40, Math.floor(used / 5_000));
      earn('first');
      if (line.sec !== undefined && line.sec <= 10) earn('flash');
      if (line.sec !== undefined && line.sec >= 600) earn('marathon');
      if (this.timedOut) earn('survivor');
      if (this.streak >= 25) earn('streak');
      if (this.done >= 100) earn('hundred');
    } else {
      this.streak = 0;
      this.xp += 2;
      if (line.status === 'TIMEOUT') this.timedOut = true;
    }
    const started = new Date(at - (line.sec ?? 0) * 1000).getHours();
    if (started < 5) earn('owl');
    if (this.tokens >= 1_000_000) earn('million');
    const after = levelOf(this.xp);
    if (after > before) ev.levelUp = after;
    return ev;
  }

  view(): WorkerProgress {
    const level = levelOf(this.xp);
    const badges: WorkerBadge[] = Object.entries(BADGES)
      .filter(([id]) => this.badges.has(id))
      .map(([id, b]) => ({ id, icon: b.icon, name: b.name(), desc: b.desc(), at: this.badges.get(id)! }));
    return { level, rank: rankOf(level), xp: this.xp, levelXp: levelStart(level), nextXp: levelStart(level + 1), jobs: this.done, badges };
  }
}
