// World timelapse: during replay the simulation runs on its own clock, accelerated by a moderate
// animation factor (running 1 h of recording in 6 s would not fit into real steps), while
// snapshots arrive on the recording clock, much faster. For thresholds that compare the snapshot
// with "now" (nap after 10 min idle, shell waiting stages, long-running foreground command),
// the ages are preserved: snapshot timestamps are shifted to the world clock
// when applied (rebaseSnapshot).
import type { OfficeSnapshot } from '../../../shared/types';

/**
 * World animation factor for a playback speed: ~sqrt of speed, between 1 and 16
 * (60× -> 6, 180× -> 10, 600× -> 16). Above that, characters would just teleport.
 */
export function animScale(speed: number): number {
  if (!Number.isFinite(speed) || speed <= 0) return 0;
  return Math.min(16, Math.max(1, Math.round(Math.sqrt(speed) * 0.75)));
}

/**
 * Shifts snapshot timestamps that the world compares to "now" to the world clock:
 * `statusSince` and shell start times. Activities remain unchanged (the world only compares them with each other).
 */
export function rebaseSnapshot(snap: OfficeSnapshot, delta: number): OfficeSnapshot {
  if (!delta) return snap;
  return {
    ...snap,
    serverTime: snap.serverTime + delta,
    agents: snap.agents.map((a) => {
      const out = { ...a, statusSince: a.statusSince + delta };
      if (a.shells) out.shells = a.shells.map((j) => ({ ...j, startedAt: j.startedAt + delta }));
      return out;
    }),
  };
}
