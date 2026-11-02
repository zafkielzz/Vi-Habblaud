// Dimming of what lies outside the office shown on the page (WorldApi.setOfficeFocus): a soft dark veil over the
// other rooms and faded characters, eased in and out so switching offices stays calm. With one building per office
// (focus.office) the other buildings are dimmed whole: their rooms, core areas and corridor, and their characters.
import type { WorldFocus } from '../api';

/** Seconds to fade fully in or out. */
export const DIM_FADE_S = 0.5;
/** Veil over a room outside the focus (fully dimmed): color and opacity. */
export const ROOM_VEIL_RGB = '14,18,28';
export const ROOM_VEIL_ALPHA = 0.38;
/** Opacity a character outside the focus loses (fully dimmed), also for its name and bubble. */
export const CHAR_FADE = 0.45;

/** Eased dim levels (0 = normal, 1 = fully dimmed) of rooms and characters. */
export class FocusDim {
  focus: WorldFocus | null = null;
  private readonly rooms = new Map<string, number>();
  private readonly chars = new Map<string, number>();
  private step = 1;

  /** Starts a frame (dt in seconds). */
  frame(focus: WorldFocus | null, dt: number): void {
    this.focus = focus;
    this.step = Math.min(1, Math.max(0, dt) / DIM_FADE_S);
  }

  /**
   * An area's level this frame (call once per frame per drawn area). `office` = the building it is in: with a focus
   * on an office, every area of another building is dimmed; otherwise a room outside roomIds (`room`).
   */
  room(id: string, office?: string, room = true): number {
    const f = this.focus;
    const out = !!f && (f.office !== undefined && office !== undefined ? office !== f.office : room && !f.roomIds.has(id));
    return ease(this.rooms, id, out, this.step);
  }

  /** The character's level this frame (call once per frame per drawn character); `office` = its building. */
  char(id: string, office?: string): number {
    const f = this.focus;
    const out = !!f && (f.office !== undefined && office !== undefined ? office !== f.office : !f.agentIds.has(id));
    return ease(this.chars, id, out, this.step);
  }

  /** The character's level already computed this frame (labels, bubbles). */
  charLevel(id: string): number {
    return this.chars.get(id) ?? 0;
  }
}

function ease(levels: Map<string, number>, id: string, out: boolean, step: number): number {
  const cur = levels.get(id) ?? 0;
  const next = out ? Math.min(1, cur + step) : Math.max(0, cur - step);
  if (next > 0) levels.set(id, next);
  else levels.delete(id);
  return next;
}
