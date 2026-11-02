// Each worker's defaults for jobs that do not say (`~/.agy_profiles/defaults.json`, {"acc2": {"mode": "plan",
// "effort": "low"}}): set from the office (worker drawer), read by agy-ask when a call has no --mode/--effort. Claude
// passes both on its own jobs, so its choice wins; jobs sent from the office and calls without flags use these.
import { readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AgyDefaults {
  /** agy-ask --mode ('plan', 'default', 'accept-edits'). */
  mode?: string;
  /** agy-ask --effort ('low', 'medium', 'high'). */
  effort?: string;
}

export const AGY_DEFAULTS_FILE = 'defaults.json';

/** The defaults file, re-read only when it changes. */
export class AgyDefaultsFile {
  private mtime = -1;
  private data: Record<string, AgyDefaults> = {};

  constructor(private readonly root: string) {}

  get(acc: string): AgyDefaults {
    this.load();
    return { ...this.data[acc] };
  }

  /** Writes one account's defaults (undefined field = removed), replacing the file atomically. */
  set(acc: string, d: AgyDefaults): void {
    this.load();
    const next: AgyDefaults = {};
    if (d.mode) next.mode = d.mode;
    if (d.effort) next.effort = d.effort;
    const data = { ...this.data, [acc]: next };
    if (!next.mode && !next.effort) delete data[acc];
    const path = join(this.root, AGY_DEFAULTS_FILE);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
    this.data = data;
    this.mtime = -1;
  }

  private load(): void {
    const path = join(this.root, AGY_DEFAULTS_FILE);
    let mtime = 0;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      this.data = {};
      this.mtime = 0;
      return;
    }
    if (mtime === this.mtime) return;
    this.mtime = mtime;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      this.data = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, AgyDefaults>) : {};
    } catch {
      this.data = {};
    }
  }
}
