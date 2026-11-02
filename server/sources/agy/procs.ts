// Running `agy` processes read from /proc (Linux only): tells if an Antigravity worker is working,
// with zero cost (no calls to agy or the model).
//
// A process belongs to an account when its HOME is the profile folder (~/.agy_profiles/accN, as set up by `agy-as`).
// With `-p`/`--print`/`--prompt` it is a headless call (agy-ask, batch scripts); without, it is an interactive agy
// (in a herdr panel or a terminal). Slash commands (`agy -p /usage`) are not work and are excluded. An agy spawned by
// another agy (same account) counts once only. Invoker: the first `claude` ancestor in the process tree, if any.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface AgyProc {
  pid: number;
  acc: string;
  /** Headless call (-p); false = interactive agy. */
  headless: boolean;
  /** Prompt of a headless call. */
  prompt?: string;
  cwd?: string;
  /** Process start time (epoch ms). */
  startedAt: number;
  /** Parent PID (in agy-ask, agy-ask itself: it writes the completion to the log). */
  ppid?: number;
  /** PID of the Claude Code that opened the call (agy-ask run by it), if any. */
  claudePid?: number;
  /** Its parent died: it was reparented to init or `systemd --user` (agy-ask killed, terminal gone). */
  orphan?: boolean;
}

const PRINT_FLAGS = new Set(['-p', '--print', '--prompt']);

/** Fields of /proc/<pid>/stat after the comm name (which may contain spaces and parentheses). */
function statFields(text: string): string[] {
  return text.slice(text.lastIndexOf(')') + 2).split(' ');
}

export interface ProcReader {
  list(): number[];
  comm(pid: number): string | undefined;
  environ(pid: number): string[] | undefined;
  cmdline(pid: number): string[] | undefined;
  cwd(pid: number): string | undefined;
  /** [ppid, starttime in ticks]. */
  stat(pid: number): { ppid: number; startTicks: number } | undefined;
  /** Boot time (epoch ms), from /proc/stat. */
  bootMs(): number;
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Reader for a real /proc (`root` swappable in tests). */
export function procReader(root = '/proc'): ProcReader {
  let boot: number | undefined;
  return {
    list: () => (safe(() => readdirSync(root)) ?? []).filter((n) => /^\d+$/.test(n)).map(Number),
    comm: (pid) => safe(() => readFileSync(join(root, String(pid), 'comm'), 'utf8').trim()),
    environ: (pid) => safe(() => readFileSync(join(root, String(pid), 'environ'), 'utf8').split('\0')),
    cmdline: (pid) => safe(() => readFileSync(join(root, String(pid), 'cmdline'), 'utf8').split('\0').filter((s, i, a) => s || i < a.length - 1)),
    cwd: (pid) => safe(() => readlinkSync(join(root, String(pid), 'cwd'))),
    stat: (pid) =>
      safe(() => {
        const f = statFields(readFileSync(join(root, String(pid), 'stat'), 'utf8'));
        return { ppid: Number(f[1]), startTicks: Number(f[19]) };
      }),
    bootMs: () => {
      if (boot === undefined) {
        const m = /^btime (\d+)$/m.exec(safe(() => readFileSync(join(root, 'stat'), 'utf8')) ?? '');
        boot = m ? Number(m[1]) * 1000 : 0;
      }
      return boot;
    },
  };
}

/** Clock ticks per second from /proc/<pid>/stat (USER_HZ: 100 on almost all Linux). */
const CLK_TCK = 100;

/** Process account from HOME: exact "<profilesRoot>/<acc>". */
function accOf(env: string[] | undefined, profilesRoot: string): string | undefined {
  const home = env?.find((v) => v.startsWith('HOME='))?.slice(5).replace(/\/+$/, '');
  const root = profilesRoot.replace(/\/+$/, '');
  if (!home?.startsWith(`${root}/`)) return undefined;
  const acc = home.slice(root.length + 1);
  return acc && !acc.includes('/') ? acc : undefined;
}

/** Running `agy` processes for the accounts in `profilesRoot`. */
export function scanAgyProcs(profilesRoot: string, r: ProcReader = procReader()): AgyProc[] {
  const found = new Map<number, AgyProc>();
  for (const pid of r.list()) {
    if (r.comm(pid) !== 'agy') continue;
    const acc = accOf(r.environ(pid), profilesRoot);
    const st = r.stat(pid);
    if (!acc || !st) continue;
    const args = r.cmdline(pid) ?? [];
    const flag = args.findIndex((a, i) => i > 0 && PRINT_FLAGS.has(a));
    const prompt = flag > 0 ? args[flag + 1] : undefined;
    if (prompt?.trim().startsWith('/')) continue;
    const p: AgyProc = { pid, acc, headless: flag > 0, startedAt: r.bootMs() + (st.startTicks / CLK_TCK) * 1000, ppid: st.ppid };
    if (prompt) p.prompt = prompt;
    if (st.ppid <= 1 || r.comm(st.ppid) === 'systemd') p.orphan = true;
    const cwd = r.cwd(pid);
    if (cwd) p.cwd = cwd;
    found.set(pid, p);
  }
  const out: AgyProc[] = [];
  for (const p of found.values()) {
    const parent = found.get(p.ppid!);
    if (parent && parent.acc === p.acc) continue;
    const proc = { ...p };
    let up = p.ppid ?? 0;
    for (let i = 0; i < 16 && up > 1; i++) {
      if (r.comm(up) === 'claude') {
        proc.claudePid = up;
        break;
      }
      up = r.stat(up)?.ppid ?? 0;
    }
    out.push(proc);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}
