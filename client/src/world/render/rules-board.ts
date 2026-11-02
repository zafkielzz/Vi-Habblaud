// The office rules poster ("📜 Nội quy") in each building's reception, painted in place of the lobby painting while
// the server sends the office's rules (OfficeInfo.rules). World px only: a parchment sheet with a title strip and one
// scribble per active rule (up to RULES_BOARD_LINES); the crisp header text comes from overlay when zoom allows.
// A new violation makes it glow red for a few seconds (`flash` 1 -> 0); with prefers-reduced-motion it does not pulse,
// a small red seal stays while `flash` > 0.
import type { BoardRect } from './job-board';

/** Scribble lines drawn at most. */
export const RULES_BOARD_LINES = 5;

/** Header strip of the poster (overlay writes on it). */
export function rulesBoardHead(r: BoardRect): BoardRect {
  return { x: r.x + 2, y: r.y + 2, w: r.w - 4, h: Math.max(4, Math.round(r.h * 0.24)) };
}

/** `flash`: 1 right after a new violation, down to 0. `still`: prefers-reduced-motion. */
export function drawRulesBoard(ctx: CanvasRenderingContext2D, r: BoardRect, rules: number, flash: number, now: number, still: boolean): void {
  // wooden rod on top, parchment sheet
  ctx.fillStyle = '#6b4a2b';
  ctx.fillRect(r.x - 1, r.y - 2, r.w + 2, 2);
  ctx.fillStyle = '#efe0b9';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  // darker edges (old paper)
  ctx.fillStyle = '#d9c391';
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
  ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  const head = rulesBoardHead(r);
  ctx.fillStyle = '#8a5a2b';
  ctx.fillRect(head.x, head.y, head.w, head.h);
  const top = head.y + head.h + 2;
  const lines = Math.min(rules, RULES_BOARD_LINES);
  const step = lines ? Math.max(2, (r.y + r.h - 3 - top) / lines) : 0;
  ctx.fillStyle = '#7a6a52';
  for (let i = 0; i < lines; i++) {
    const y = Math.round(top + i * step);
    if (y >= r.y + r.h - 2) break;
    ctx.fillRect(r.x + 3, y, 1, 1);
    ctx.fillRect(r.x + 5, y, Math.max(2, Math.round((r.w - 9) * (0.55 + ((i * 37) % 40) / 100))), 1);
  }
  if (flash <= 0) return;
  if (still) {
    // a quiet red seal in the corner
    ctx.fillStyle = '#c94040';
    ctx.fillRect(r.x + r.w - 5, r.y + r.h - 5, 3, 3);
    return;
  }
  // soft red glow that breathes and fades out
  const pulse = 0.5 + 0.5 * Math.sin(now / 260);
  ctx.save();
  ctx.globalAlpha *= Math.min(1, flash) * (0.18 + 0.22 * pulse);
  ctx.fillStyle = '#e05555';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.globalAlpha = Math.min(1, flash) * (0.5 + 0.4 * pulse);
  ctx.strokeStyle = '#e05555';
  ctx.lineWidth = 1;
  ctx.strokeRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3);
  ctx.restore();
}
