// Migration from the project's old name (CodeTown, up to 0.3.2) to Habblaud. What still needs to know the
// old name stays here, to be removed at once when nobody comes from a 0.3 installation anymore.
import { existsSync, readdirSync, renameSync, rmdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../shared/i18n';

/** Old name in lowercase: state folder, plugins, marketplace, project, and Docker volume. */
export const LEGACY_NAME = 'codetown';
const LEGACY_ENV_PREFIX = 'CODETOWN_';
const ENV_PREFIX = 'HABBLAUD_';

/** Old name variables (CODETOWN_*) present in `keys`, with the new name for each. */
export function legacyEnvVars(keys: Iterable<string>): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const k of keys) {
    if (k.startsWith(LEGACY_ENV_PREFIX)) out.push({ from: k, to: ENV_PREFIX + k.slice(LEGACY_ENV_PREFIX.length) });
  }
  return out.sort((a, b) => a.from.localeCompare(b.from));
}

/** Warning for old variables (no longer valid), or undefined if none found. */
export function legacyEnvWarning(keys: Iterable<string>, where = tr('in the environment')): string | undefined {
  const vars = legacyEnvVars(keys);
  if (!vars.length) return undefined;
  return tr('{0} {1}: {2}. Rename to re-enable.', [vars.length === 1 ? tr('old-name variable ignored') : tr('old-name variables ignored'), where, vars.map((v) => `${v.from} → ${v.to}`).join(', ')]);
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Moves from `from` to `to` what is missing there (shared folders are merged); for files on both sides, the newer wins. */
function mergeInto(from: string, to: string, moved: string[], rel: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dst = join(to, name);
    const relName = rel ? `${rel}/${name}` : name;
    if (!existsSync(dst)) {
      renameSync(src, dst);
      moved.push(relName);
    } else if (isDir(src) && isDir(dst)) mergeInto(src, dst, moved, relName);
    else if (isFile(src) && isFile(dst) && statSync(src).mtimeMs > statSync(dst).mtimeMs) {
      // E.g.: old mod kept writing usage to ~/.codetown after the new folder existed.
      renameSync(src, dst);
      moved.push(relName);
    }
  }
  try {
    rmdirSync(from);
  } catch {
    // something remained that already existed in destination: old folder stays, with only those items
  }
}

/**
 * Moves state from ~/.codetown to ~/.habblaud (usage captured by mod/tap and, outside Docker, names, timeline,
 * and statistics). Without the new folder, it's a rename; if it already exists (mod wrote usage beforehand), moves
 * what is missing there and what is newer. Returns what was moved (empty = nothing to do) and never throws.
 */
export function migrateLegacyStateDir(home: string): { moved: string[]; error?: string } {
  const from = join(home, `.${LEGACY_NAME}`);
  const to = join(home, '.habblaud');
  const moved: string[] = [];
  if (!isDir(from)) return { moved };
  try {
    if (!existsSync(to)) {
      renameSync(from, to);
      moved.push('.');
    } else if (isDir(to)) mergeInto(from, to, moved, '');
    else return { moved, error: tr("{0} exists and isn't a folder", [to]) };
    return { moved };
  } catch (err) {
    return { moved, error: (err as Error).message };
  }
}

/** Short sentence for the migration log (undefined if nothing changed). */
export function describeStateMigration(r: { moved: string[]; error?: string }): string | undefined {
  if (r.error) return tr("couldn't move ~/.{0} to ~/.habblaud ({1}); move the folder by hand.", [LEGACY_NAME, r.error]);
  if (!r.moved.length) return undefined;
  return r.moved[0] === '.' ? tr('~/.{0} (old name) is now ~/.habblaud.', [LEGACY_NAME]) : tr('from ~/.{0} (old name) to ~/.habblaud: {1}.', [LEGACY_NAME, r.moved.join(', ')]);
}
