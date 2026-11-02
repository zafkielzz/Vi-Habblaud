// The office rules' refusals (shared/rules.ts RuleViolation): agy-ask / claude-ask and the rules hook (agy-hub) append
// one JSON line each to rules-log.jsonl next to team.json; this reads them. On start it keeps only the last
// VIOLATIONS_KEEP (days, lines) and rewrites the file; deleting an office drops its lines. `poll()` returns the lines
// added since the last call (each one becomes a Board news item and flashes the office's rules board).
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { VIOLATIONS_KEEP, type RuleViolation } from '../shared/rules';

const KINDS: ReadonlySet<string> = new Set(['deny', 'outside', 'command', 'cwd', 'jobs', 'quota']);
/** Violations an office shows in the snapshot. */
export const VIOLATIONS_SHOWN = 50;

/** One line of the log, or undefined when malformed. */
export function parseViolation(line: string): RuleViolation | undefined {
  try {
    const v = JSON.parse(line) as Partial<RuleViolation>;
    if (typeof v.at !== 'number' || typeof v.office !== 'string' || !KINDS.has(v.kind as string)) return undefined;
    return {
      at: v.at,
      office: v.office,
      who: typeof v.who === 'string' ? v.who.slice(0, 80) : '?',
      kind: v.kind as RuleViolation['kind'],
      detail: typeof v.detail === 'string' ? v.detail.replace(/\s+/g, ' ').slice(0, 200) : '',
      by: v.by === 'hook' ? 'hook' : 'ask',
    };
  } catch {
    return undefined;
  }
}

export class RulesLog {
  private all: RuleViolation[] = [];
  private size = 0;
  private mtime = 0;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.read();
    this.trim();
  }

  /** The office's violations, newest first. */
  of(office: string): RuleViolation[] {
    const out: RuleViolation[] = [];
    for (let i = this.all.length - 1; i >= 0 && out.length < VIOLATIONS_SHOWN; i--) if (this.all[i].office === office) out.push(this.all[i]);
    return out;
  }

  /** Lines added since the last call, oldest first (a file rewritten by someone else is read again, nothing new). */
  poll(): RuleViolation[] {
    return this.read();
  }

  /** Forgets a deleted office's lines (file rewritten). */
  dropOffice(office: string): void {
    this.all = this.all.filter((v) => v.office !== office);
    this.write();
  }

  /** Reads what changed (whole lines only: a line being written waits); returns the appended violations. */
  private read(): RuleViolation[] {
    let st;
    try {
      st = statSync(this.file);
    } catch {
      this.all = [];
      this.size = 0;
      return [];
    }
    if (st.size === this.size && st.mtimeMs === this.mtime) return [];
    const appended = st.size >= this.size;
    const chunk = readFileSync(this.file).subarray(appended ? this.size : 0);
    const end = chunk.lastIndexOf(10) + 1;
    const parsed = chunk
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .map((l) => (l.trim() ? parseViolation(l) : undefined))
      .filter((v): v is RuleViolation => !!v);
    this.all = appended ? [...this.all, ...parsed] : parsed;
    this.size = (appended ? this.size : 0) + end;
    this.mtime = st.mtimeMs;
    return appended ? parsed : [];
  }

  /** Keeps the last days / lines (rewrites only when something goes). */
  private trim(): void {
    const from = this.now() - VIOLATIONS_KEEP.days * 86_400_000;
    const kept = this.all.filter((v) => v.at >= from).slice(-VIOLATIONS_KEEP.lines);
    if (kept.length === this.all.length) return;
    this.all = kept;
    this.write();
  }

  private write(): void {
    if (!existsSync(this.file) && !this.all.length) return;
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, this.all.map((v) => JSON.stringify(v)).join('\n') + (this.all.length ? '\n' : ''));
      renameSync(tmp, this.file);
      const st = statSync(this.file);
      this.size = st.size;
      this.mtime = st.mtimeMs;
    } catch {
      // read-only folder: kept in memory only
    }
  }
}
