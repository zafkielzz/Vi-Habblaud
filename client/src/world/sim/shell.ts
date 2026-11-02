// "Waiting for shell to finish" — PURE rules (testable without DOM) for the office gag.
//
// Comedic escalation based on the age of the oldest shell the agent is waiting for:
// - 0–3 min   ('popcorn'):  leaning back with popcorn bucket, watching the terminal like a movie;
// - 3–10 min  ('restless'): popcorn ran out; crossed arms and, once in a while, a chair spin;
// - 10–25 min ('cobweb'):   spiderweb in the corner (grows to 2x after 20 min) and yawns;
// - > 25 min  ('nap'):      napping at desk, covered in cobwebs.
// Always: hourglass flipping above head, monitor in 'progress', and bubble "⏳ <label> · <time>".
import type { Activity, AgentStatus, ShellJob } from '../../../../shared/types';
import type { Dir, IconName } from '../../art/api';
import { tr } from '../../../../shared/i18n';

export type ShellStage = 'popcorn' | 'restless' | 'cobweb' | 'nap';

/** Tool name for the Activity recorded by the server when a shell finishes (agreed contract). */
export const SHELL_DONE_TOOL = 'ShellDone';

/** Thresholds (waiting ms) for escalation. */
export const SHELL_RESTLESS_MS = 3 * 60_000;
export const SHELL_COBWEB_MS = 10 * 60_000;
export const SHELL_COBWEB_BIG_MS = 20 * 60_000;
export const SHELL_NAP_MS = 25 * 60_000;

/**
 * FOREGROUND command: only turns into "waiting" after this. Fast commands (ls, git status...)
 * do not take the character away from typing.
 */
export const FOREGROUND_WAIT_MS = 10_000;

/** Full chair spin: duration and interval between spins ('restless' stage). */
export const SPIN_MS = 800;
export const SPIN_GAP_MIN_MS = 15_000;
export const SPIN_GAP_MAX_MS = 25_000;
/** First spin right after popcorn runs out (does not wait for a full interval). */
const SPIN_FIRST_MS = 2_500;

/** Yawn ('cobweb' stage): duration and interval. */
export const YAWN_MS = 1_300;
export const YAWN_GAP_MIN_MS = 18_000;
export const YAWN_GAP_MAX_MS = 32_000;
const YAWN_FIRST_MS = 4_000;

/** Storm cloud ('storm') is slightly higher than other icons: raindrops fall down to the head. */
export const STORM_LIFT = 3;

/** Hourglass flips every this duration (alternates 'hourglass' / 'hourglass_flip'). */
export const HOURGLASS_FLIP_MS = 1_200;

/** Speech bubble in 'important' mode: upon entering state, then for 4 s every ~30 s. */
export const SHELL_BUBBLE_ENTER_MS = 6_000;
export const SHELL_BUBBLE_EVERY_MS = 30_000;
export const SHELL_BUBBLE_SHOW_MS = 4_000;
const BUBBLE_FADE_IN_MS = 150;
const BUBBLE_FADE_OUT_MS = 400;

/** Gag stage by wait duration (ms). */
export function shellStage(ageMs: number): ShellStage {
  if (ageMs >= SHELL_NAP_MS) return 'nap';
  if (ageMs >= SHELL_COBWEB_MS) return 'cobweb';
  if (ageMs >= SHELL_RESTLESS_MS) return 'restless';
  return 'popcorn';
}

/** Integer scale of cobweb: 0 = no cobweb, 1x after 10 min, 2x after 20 min. */
export function cobwebScale(ageMs: number): 0 | 1 | 2 {
  if (ageMs < SHELL_COBWEB_MS) return 0;
  return ageMs >= SHELL_COBWEB_BIG_MS ? 2 : 1;
}

/** Frame of animated hourglass. */
export function hourglassIcon(now: number): IconName {
  return Math.floor(now / HOURGLASS_FLIP_MS) % 2 ? 'hourglass_flip' : 'hourglass';
}

// ------------------------------------------------------------------ agent shells

/** Counts toward total? In foreground, only commands without a result (background === false). */
function counts(j: ShellJob, foregroundOnly: boolean): boolean {
  return !foregroundOnly || j.background === false;
}

/** Oldest shell considered (allocation-free). `foregroundOnly`: foreground only. */
export function oldestShell(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): ShellJob | null {
  if (!shells) return null;
  let best: ShellJob | null = null;
  for (const j of shells) {
    if (!counts(j, foregroundOnly) || !Number.isFinite(j.startedAt)) continue;
    if (!best || j.startedAt < best.startedAt) best = j;
  }
  return best;
}

/** Number of shells the agent is waiting for (same criteria as `oldestShell`). */
export function countShells(shells: readonly ShellJob[] | undefined, foregroundOnly: boolean): number {
  if (!shells) return 0;
  let n = 0;
  for (const j of shells) if (counts(j, foregroundOnly)) n++;
  return n;
}

/**
 * Waiting for a foreground command for more than FOREGROUND_WAIT_MS? (status 'working' with a
 * long Bash command still without a result: agent is idling watching command run.)
 */
export function foregroundWaiting(shells: readonly ShellJob[] | undefined, now: number): boolean {
  const j = oldestShell(shells, true);
  return !!j && now - j.startedAt > FOREGROUND_WAIT_MS;
}

/**
 * Start (epoch ms) of an agent's wait in 'shell' mode: oldest shell (foreground,
 * when status is 'working'); if none listed, the moment status changed.
 */
export function shellWaitSince(a: { status: AgentStatus; shells?: ShellJob[]; statusSince: number }): number {
  const j = oldestShell(a.shells, a.status !== 'shell');
  return j ? j.startedAt : a.statusSince;
}

/** Bubble label: that of the oldest shell or a generic text. */
export function shellLabel(a: { status: AgentStatus; shells?: ShellJob[] }): string {
  const fg = a.status !== 'shell';
  const j = oldestShell(a.shells, fg);
  const label = j?.label?.trim();
  if (label) return label;
  if (j?.kind === 'monitor') return tr('Monitoring a process');
  return fg ? tr('Terminal command') : tr('Background command');
}

/**
 * Most recent 'ShellDone' Activity of the agent (current or in recent — another activity may have
 * arrived in the same snapshot), or null. Allocation-free.
 */
export function latestShellDone(a: { activity?: Activity; recent?: readonly Activity[] }): Activity | null {
  let best: Activity | null = a.activity?.tool === SHELL_DONE_TOOL ? a.activity : null;
  const recent = a.recent;
  if (recent) {
    for (let i = recent.length - 1; i >= 0; i--) {
      const r = recent[i];
      if (r.tool === SHELL_DONE_TOOL && (!best || r.at > best.at)) best = r;
    }
  }
  return best;
}

// ------------------------------------------------------------------ time and bubble

/** Wait duration: "45 s", "3 min", "1 h 05". */
export function formatShellAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} h ${mm < 10 ? '0' : ''}${mm}`;
}

/**
 * Key that changes exactly when `formatShellAge` text changes (bubble only rebuilds string
 * when needed — seconds in first minute, then minutes).
 */
export function shellAgeKey(ms: number): number {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? s : 60 + Math.floor(s / 60);
}

/** Bubble text (⏳ is the bubble icon). */
export function shellBubbleText(label: string, ageMs: number): string {
  return `${label} · ${formatShellAge(ageMs)}`;
}

/**
 * Opacity (0..1) of waiting bubble in 'important' mode, `ms` after entering state:
 * visible during first SHELL_BUBBLE_ENTER_MS; then for SHELL_BUBBLE_SHOW_MS every
 * SHELL_BUBBLE_EVERY_MS (shifted by `offsetMs`, so bubbles from multiple characters do not flash together).
 */
export function shellBubbleAlpha(ms: number, offsetMs = 0): number {
  if (ms < 0) return 0;
  if (ms < SHELL_BUBBLE_ENTER_MS) return windowAlpha(ms, SHELL_BUBBLE_ENTER_MS);
  const off = ((offsetMs % SHELL_BUBBLE_EVERY_MS) + SHELL_BUBBLE_EVERY_MS) % SHELL_BUBBLE_EVERY_MS;
  // first repetition ~30 s after entering
  const t = ms - SHELL_BUBBLE_EVERY_MS - off;
  if (t < 0) return 0;
  const inCycle = t % SHELL_BUBBLE_EVERY_MS;
  return inCycle < SHELL_BUBBLE_SHOW_MS ? windowAlpha(inCycle, SHELL_BUBBLE_SHOW_MS) : 0;
}

function windowAlpha(t: number, len: number): number {
  return Math.max(0, Math.min(1, t / BUBBLE_FADE_IN_MS, (len - t) / BUBBLE_FADE_OUT_MS));
}

// ------------------------------------------------------------------ spins and yawns

/** Pseudorandom number in [0, 1) deterministic by (seed, index, salt). */
export function unitHash(seed: number, k: number, salt: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca77)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Phase (0..1) of a periodic event at `ageMs`, or -1 when outside. Events of `durMs` start at
 * `fromMs + firstMs` and repeat with intervals picked (by seed) in [gapMin, gapMax],
 * only while `ageMs < toMs`. Allocation-free (short loop: dozens of iterations in worst case).
 */
export function periodicPhase(ageMs: number, fromMs: number, toMs: number, firstMs: number, gapMin: number, gapMax: number, durMs: number, seed: number, salt: number): number {
  if (ageMs < fromMs || ageMs >= toMs) return -1;
  let t = fromMs + firstMs;
  for (let k = 0; t <= ageMs && k < 10_000; k++) {
    if (ageMs < t + durMs) return (ageMs - t) / durMs;
    t += gapMin + unitHash(seed, k, salt) * (gapMax - gapMin);
  }
  return -1;
}

/** Chair spin phase (0..1), or -1. Spins every 15–25 s in 'restless' stage. */
export function spinPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_RESTLESS_MS, SHELL_COBWEB_MS, SPIN_FIRST_MS, SPIN_GAP_MIN_MS, SPIN_GAP_MAX_MS, SPIN_MS, seed, 1);
}

/** Yawn phase (0..1), or -1. Occasional in 'cobweb' stage. */
export function yawnPhase(ageMs: number, seed: number): number {
  return periodicPhase(ageMs, SHELL_COBWEB_MS, SHELL_NAP_MS, YAWN_FIRST_MS, YAWN_GAP_MIN_MS, YAWN_GAP_MAX_MS, YAWN_MS, seed, 2);
}

/** Clockwise direction viewed from above: north -> east -> south -> west. */
const CLOCKWISE: readonly Dir[] = ['up', 'right', 'down', 'left'];

/**
 * Direction during spin (phase 0..1): one full turn clockwise, one quarter at a time,
 * ending back at `base`.
 */
export function spinDir(phase: number, base: Dir): Dir {
  if (phase < 0) return base;
  const i = CLOCKWISE.indexOf(base);
  const q = Math.min(3, Math.floor(phase * 4));
  return CLOCKWISE[(i + q + 1) % 4];
}
