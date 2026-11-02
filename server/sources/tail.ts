// Incremental reading of append-only files (JSONL): returns only new complete lines,
// saves the partial line for the next cycle (up to MAX_LINE_BYTES), and detects truncation/rotation.
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { log } from '../log';
import { tr } from '../../shared/i18n';

export interface TailRead {
  lines: string[];
  /** The file was truncated or replaced: reading restarted from the beginning. */
  reset: boolean;
  /** The file does not exist (yet or anymore). */
  missing: boolean;
  /** There are still unread bytes (the per-read limit was reached). */
  more: boolean;
}

const NL = 0x0a;
/** How much of the file start to keep to confirm a replacement indicated only by birthtime (see `replaced`). */
const HEAD_BYTES = 256;
/**
 * Cap for a JSONL line. In real Claude Code and Codex conversations the largest line was
 * 5.8 MiB (large tool_result, which must be read whole to become activity). 8 MiB
 * covers this comfortably; beyond that, the line is discarded until the next `\n`.
 */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Warns once per file that a line exceeded the limit and was skipped. Without line content. */
export function warnOversizedLine(path: string): void {
  const mb = MAX_LINE_BYTES / (1024 * 1024);
  log.warnOnce(`oversize-line:${path}`, tr('Line over {0} MiB in {1} skipped until the next line break.', [mb, path]));
}

/**
 * Incomplete line in pieces: joins only when `\n` is found. Each read copies only the new piece;
 * above `max`, releases the accumulated content and discards until the next newline.
 */
export class LineBuffer {
  private pieces: Buffer[] = [];
  private bytes = 0;
  private skipping = false;

  constructor(private readonly max = MAX_LINE_BYTES) {}

  reset(): void {
    this.pieces = [];
    this.bytes = 0;
    this.skipping = false;
  }

  /** Consumes `chunk` and returns complete lines without `\n`. */
  push(chunk: Buffer): { lines: Buffer[]; discarded: number } {
    const lines: Buffer[] = [];
    let discarded = 0;
    let i = 0;
    while (i < chunk.length) {
      if (this.skipping) {
        const nl = chunk.indexOf(NL, i);
        if (nl === -1) return { lines, discarded };
        this.skipping = false;
        i = nl + 1;
        continue;
      }
      const nl = chunk.indexOf(NL, i);
      if (nl === -1) {
        const rest = chunk.length - i;
        if (rest > 0 && this.bytes + rest > this.max) {
          this.pieces = [];
          this.bytes = 0;
          this.skipping = true;
          discarded++;
        } else if (rest > 0) {
          this.pieces.push(Buffer.from(chunk.subarray(i)));
          this.bytes += rest;
        }
        return { lines, discarded };
      }
      const total = this.bytes + (nl - i);
      if (total > this.max) discarded++;
      else if (total > 0) lines.push(this.take(chunk.subarray(i, nl)));
      this.pieces = [];
      this.bytes = 0;
      i = nl + 1;
    }
    return { lines, discarded };
  }

  /** Remainder without `\n` at EOF; null if empty or if line exceeded the cap. */
  flush(): Buffer | null {
    if (this.skipping || this.bytes === 0) return null;
    const out = this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    this.pieces = [];
    this.bytes = 0;
    return out;
  }

  private take(tail: Buffer): Buffer {
    if (this.pieces.length === 0) return tail;
    if (tail.length === 0) return this.pieces.length === 1 ? this.pieces[0] : Buffer.concat(this.pieces);
    return Buffer.concat([...this.pieces, tail]);
  }
}

/** The first `max` bytes of the file, via a positional read (does not alter incremental read offset). */
function readHead(fd: number, max: number): Buffer {
  const buf = Buffer.alloc(max);
  return max > 0 ? buf.subarray(0, readSync(fd, buf, 0, max, 0)) : buf;
}

export class FileTail {
  /** Next byte to read. */
  offset = 0;
  size = 0;
  mtimeMs = 0;
  /** Line still without `\n`. Above MAX_LINE_BYTES, the rest is discarded until the newline. */
  private pending = new LineBuffer();
  private ino: number | undefined;
  /** File creation time (0 when the filesystem does not report it). */
  private birthtimeMs = 0;
  /** File start (up to HEAD_BYTES); null = not read yet. */
  private head: Buffer | null = null;
  private readonly maxChunk: number;

  constructor(
    readonly path: string,
    opts: { maxChunk?: number } = {},
  ) {
    this.maxChunk = opts.maxChunk ?? 8 * 1024 * 1024;
  }

  /**
   * Positions reading at the last `maxBytes` of the file, aligned to the start of the next line
   * (the cut line is discarded). Returns the chosen offset (0 = entire file).
   */
  seekTail(maxBytes: number): number {
    this.pending.reset();
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      this.offset = 0;
      return 0;
    }
    try {
      const st = fstatSync(fd);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.head = readHead(fd, Math.min(st.size, HEAD_BYTES));
      if (st.size <= maxBytes) {
        this.offset = 0;
        return 0;
      }
      // Look for the first line break starting from (window start - 1).
      let pos = st.size - maxBytes - 1;
      const buf = Buffer.allocUnsafe(64 * 1024);
      while (pos < st.size) {
        const n = readSync(fd, buf, 0, buf.length, pos);
        if (n <= 0) break;
        const i = buf.subarray(0, n).indexOf(NL);
        if (i !== -1) {
          this.offset = pos + i + 1;
          return this.offset;
        }
        pos += n;
      }
      this.offset = st.size;
      return this.offset;
    } finally {
      closeSync(fd);
    }
  }

  /** Positions at the end of the file (only what is written from now on will be read). */
  seekEnd(): void {
    this.pending.reset();
    this.head = null;
    try {
      const st = statSync(this.path);
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      this.offset = st.size;
    } catch {
      this.offset = 0;
    }
  }

  /**
   * Was the file replaced with another? A different inode is sufficient, but the filesystem may reuse the
   * number of a deleted file (ext4): therefore, when both sides report birthtime, it also counts.
   * However, on Linux without statx (WSL1, legacy seccomp), Node returns ctime instead, and ctime changes on
   * every write: birthtime changes only count if the file header also changed. A new file starting with the
   * same bytes passes as the same file, as before birthtime was checked.
   * The same applies to mtime: rewriting the file on the same inode (`writeFileSync` over it) does not change inode
   * or birthtime, and with the same (or larger) size `size < offset` will not trigger. Appending lines changes
   * mtime without altering the beginning, so only a change in the beginning counts as a replacement.
   */
  private replaced(fd: number, st: { ino: number; birthtimeMs: number; mtimeMs: number }): boolean {
    if (this.ino === undefined) return false;
    if (st.ino !== this.ino) return true;
    const born = this.birthtimeMs > 0 && st.birthtimeMs > 0 && st.birthtimeMs !== this.birthtimeMs;
    const written = st.mtimeMs !== this.mtimeMs;
    if (!born && !written) return false;
    return !!this.head && !readHead(fd, this.head.length).equals(this.head);
  }

  read(): TailRead {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], reset: false, missing: true, more: false };
      throw err;
    }
    try {
      const st = fstatSync(fd);
      let reset = false;
      if (this.replaced(fd, st) || st.size < this.offset) {
        this.offset = 0;
        this.pending.reset();
        this.head = null;
        reset = true;
      }
      this.ino = st.ino;
      this.birthtimeMs = st.birthtimeMs;
      this.size = st.size;
      this.mtimeMs = st.mtimeMs;
      // The beginning is only re-read while the file has not yet reached HEAD_BYTES.
      const headLen = Math.min(st.size, HEAD_BYTES);
      if (!this.head || this.head.length < headLen) this.head = readHead(fd, headLen);
      const avail = st.size - this.offset;
      if (avail <= 0) return { lines: [], reset, missing: false, more: false };
      const len = Math.min(avail, this.maxChunk);
      const chunk = Buffer.allocUnsafe(len);
      const n = readSync(fd, chunk, 0, len, this.offset);
      this.offset += n;
      const fed = this.pending.push(chunk.subarray(0, n));
      if (fed.discarded) warnOversizedLine(this.path);
      const lines: string[] = [];
      for (const buf of fed.lines) {
        const line = buf.toString('utf8').replace(/\r$/, '');
        if (line.trim()) lines.push(line);
      }
      return { lines, reset, missing: false, more: avail > len };
    } finally {
      closeSync(fd);
    }
  }
}
