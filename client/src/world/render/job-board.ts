// The job board in the Antigravity workers' room (RoomInfo.board), painted in place of the wall
// whiteboard and much wider. Here only world px drawing (frame, header, one row per job with status
// color and a "scribble" the length of the text); readable text comes from overlay when zoom allows (overlay.ts).
import type { JobBoard } from '../../../../shared/types';

/** Job rows that fit on the board (most recent). */
export const JOB_BOARD_ROWS = 4;

export const JOB_STATUS_COLOR = { working: '#f2b33d', done: '#5cc97b', failed: '#e05555', paused: '#8aa4c8', cancelled: '#8a8a8a' } as const;

export interface BoardRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Internal areas of the board: header and rows (overlay writes on them). */
export function jobBoardParts(r: BoardRect): { head: BoardRect; rows: BoardRect[] } {
  const pad = 2;
  const headH = Math.max(4, Math.round(r.h * 0.26));
  const head = { x: r.x + pad, y: r.y + pad, w: r.w - pad * 2, h: headH };
  const top = head.y + headH + 1;
  const rowH = (r.y + r.h - pad - top) / JOB_BOARD_ROWS;
  const rows = Array.from({ length: JOB_BOARD_ROWS }, (_, i) => ({ x: r.x + pad + 1, y: top + i * rowH, w: r.w - pad * 2 - 2, h: rowH }));
  return { head, rows };
}

export function drawJobBoard(ctx: CanvasRenderingContext2D, r: BoardRect, board: JobBoard, now: number): void {
  // wooden frame and white surface
  ctx.fillStyle = '#5b3d24';
  ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
  ctx.fillStyle = '#f3f0e6';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const { head, rows } = jobBoardParts(r);
  // blue header with two pins; with a new task (last 30 s) it blinks softly
  const fresh = board.order && now - board.order.at < 30_000 && Math.floor(now / 500) % 2 === 0;
  ctx.fillStyle = fresh ? '#3b5bb5' : '#2c3e7a';
  ctx.fillRect(head.x, head.y, head.w, head.h);
  ctx.fillStyle = '#e05555';
  ctx.fillRect(r.x + 3, r.y - 2, 2, 2);
  ctx.fillRect(r.x + r.w - 5, r.y - 2, 2, 2);
  board.items.slice(0, JOB_BOARD_ROWS).forEach((it, i) => {
    const row = rows[i];
    const cy = Math.round(row.y + row.h / 2);
    const pulse = it.status === 'working' && Math.floor(now / 400) % 2 === 0;
    ctx.fillStyle = pulse ? '#ffd86b' : JOB_STATUS_COLOR[it.status];
    ctx.fillRect(row.x, cy - 1, 3, 3);
    // scribble: length based on text, gray (becomes real text in overlay at higher zoom)
    const len = Math.min(row.w - 6, 6 + it.text.length * 0.5);
    ctx.fillStyle = it.status === 'failed' ? '#b85c5c' : '#7d8496';
    ctx.fillRect(row.x + 5, cy, Math.round(len), 1);
  });
}
