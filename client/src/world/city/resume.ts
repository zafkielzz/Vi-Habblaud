// Returning to city on same page (Office → World): player returns EXACTLY where they were. World server
// stores last position per account (on `view.off` or disconnect) and sends initial `pos` matching it; scene saves,
// on hide, camera, zoom, and local character position, and on reopen decides with incoming `pos`:
//   * same place: nothing changes (neither character nor camera; previous city stays on screen until new snapshot);
//   * different place: character and camera snap directly there, without animated teleport, at same zoom;
//   * nothing saved (first time, or closed before spawning): standard spawn.

/** Where city was on hide: camera (world px), zoom, whether following character, and character position (tiles). */
export interface CityResume {
  camX: number;
  camY: number;
  zoom: number;
  following: boolean;
  me: { x: number; y: number } | null;
}

/** Threshold (tiles) for server `pos` being "same place": position is sent rounded and last step may be missing. */
export const RESUME_SAME_TILES = 0.6;

export type ResumePlacement = 'keep' | 'snap' | 'fresh';

/** What to do with initial `pos` when reopening scene (see file header). */
export function resumePlacement(resume: CityResume | null, pos: { x: number; y: number } | null): ResumePlacement {
  if (!resume?.me || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return 'fresh';
  return Math.hypot(pos.x - resume.me.x, pos.y - resume.me.y) <= RESUME_SAME_TILES ? 'keep' : 'snap';
}
