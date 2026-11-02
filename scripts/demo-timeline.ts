// Generates a timeline ONLY with mock data for timelapse (e.g. recording the README GIF).
// Runs demo mode simulator (shared/demo/simulator.ts) offline, with its own clock, for
// N simulated hours, and writes with the server recorder (server/history/timeline.ts) to
// <folder>/timeline/YYYY-MM-DD.jsonl. No real data enters the file.
//
//   npm run demo:timeline                                   # yesterday, 9am to 7pm, in <tmp>/habblaud-demo
//   npm run demo:timeline -- --date 2026-10-07 --start 8:30 --hours 11 --sessions 7
//
// To watch: HABBLAUD_DATA_DIR=<folder> HABBLAUD_TIMELINE=0 npm start (or npm run dev) and click the
// Timelapse button in top bar. Throughout the day sessions ramp in morning, dip at lunch,
// rise again in afternoon, and zero out at the end (sessionsAt), giving timelapse a workday feel.
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DemoSimulator } from '../shared/demo/simulator';
import { dayKey, isDayKey, shiftDay } from '../shared/timeline';
import { TIMELINE_DIR, TimelineRecorder } from '../server/history/timeline';

const HOUR = 3_600_000;

const USAGE = `Usage: npm run demo:timeline [-- options]

Generates a mock timeline (demo mode simulator) for the timelapse.

Options:
  --date YYYY-MM-DD   day to record (default: yesterday, to avoid mixing with today's recording)
  --start H[:MM]      start hour (default: 9)
  --hours N           simulated hours (default: 10; max 24)
  --sessions N        open sessions at peak of day (default: 6)
  --pace X            simulator pace: 1 = live demo mode (turns of 40 s to 4 min);
                      0.25 = 4× slower, like a real workday (default: 0.25)
  --seed N            seed (default: 1; same seed generates same day)
  --data-dir FOLDER   Habblaud data directory (default: <tmp>/habblaud-demo); file saved to FOLDER/timeline/
  --force             overwrites day file if it exists
  -h, --help          shows this help

To watch: HABBLAUD_DATA_DIR=FOLDER HABBLAUD_TIMELINE=0 npm start and open Timelapse.`;

export interface DemoTimelineOptions {
  date: string;
  /** Minutes after midnight. */
  startMin: number;
  hours: number;
  sessions: number;
  pace: number;
  seed: number;
  dataDir: string;
  force: boolean;
  help: boolean;
}

// ---------------------------------------------------------------------------------------------
// Pure functions (tested in server/test/demo-timeline.test.ts)
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv: string[], now = Date.now()): DemoTimelineOptions {
  const o: DemoTimelineOptions = {
    date: shiftDay(dayKey(now), -1),
    startMin: 9 * 60,
    hours: 10,
    sessions: 6,
    pace: 0.25,
    seed: 1,
    dataDir: join(tmpdir(), 'habblaud-demo'),
    force: false,
    help: false,
  };
  const num = (flag: string, v: string | undefined, min: number, max: number): number => {
    const n = Number(v);
    if (v === undefined || v.trim() === '' || !Number.isFinite(n) || n < min || n > max) {
      throw new Error(`${flag}: expected a number between ${min} and ${max}`);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--date': {
        const v = next();
        if (!isDayKey(v)) throw new Error('--date: use AAAA-MM-DD');
        o.date = v;
        break;
      }
      case '--start': {
        const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(next() ?? '');
        if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) throw new Error('--start: use H or H:MM (0 to 23:59)');
        o.startMin = Number(m[1]) * 60 + Number(m[2] ?? 0);
        break;
      }
      case '--hours':
        o.hours = num(a, next(), 0.1, 24);
        break;
      case '--sessions':
        o.sessions = Math.round(num(a, next(), 1, 20));
        break;
      case '--pace':
        o.pace = num(a, next(), 0.05, 10);
        break;
      case '--seed':
        o.seed = Math.round(num(a, next(), 0, 2 ** 31));
        break;
      case '--data-dir': {
        const v = next();
        if (!v) throw new Error('--data-dir: specify the folder');
        o.dataDir = resolve(v);
        break;
      }
      case '--force':
        o.force = true;
        break;
      case '-h':
      case '--help':
        o.help = true;
        break;
      default:
        throw new Error(`opção desconhecida: ${a}`);
    }
  }
  return o;
}

/** Fraction of peak sessions throughout the day (0 = start, 1 = end): morning, lunch, afternoon, evening. */
const DAY_CURVE: readonly [number, number][] = [
  [0, 0.2],
  [0.08, 0.6],
  [0.2, 1],
  [0.36, 0.85],
  [0.44, 0.35],
  [0.54, 0.55],
  [0.68, 1],
  [0.84, 0.75],
  [0.94, 0.2],
  [1, 0],
];

/** Sessions to keep open at fraction `p` of simulated day, with peak `peak`. */
export function sessionsAt(p: number, peak: number): number {
  const x = Math.min(1, Math.max(0, p));
  for (let i = 1; i < DAY_CURVE.length; i++) {
    const [x1, y1] = DAY_CURVE[i];
    if (x > x1) continue;
    const [x0, y0] = DAY_CURVE[i - 1];
    const k = x1 === x0 ? 1 : (x - x0) / (x1 - x0);
    return Math.round(peak * (y0 + (y1 - y0) * k));
  }
  return 0;
}

export interface DemoTimelineResult {
  /** Written files (more than one if time span crosses midnight). */
  files: string[];
  from: number;
  to: number;
}

/** Files occupied by a time span (one per local day). */
function filesFor(dir: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let day = dayKey(from); day <= dayKey(to); day = shiftDay(day, 1)) out.push(join(dir, `${day}.jsonl`));
  return out;
}

/** Simulates and records. `stepMs` = simulated clock step (server advances demo every 250 ms). */
export function generateDemoTimeline(o: Omit<DemoTimelineOptions, 'help'>, stepMs = 500): DemoTimelineResult {
  const [y, mo, d] = o.date.split('-').map(Number);
  const from = new Date(y, mo - 1, d, Math.floor(o.startMin / 60), o.startMin % 60).getTime();
  const to = from + o.hours * HOUR;
  const dir = join(o.dataDir, TIMELINE_DIR);
  const files = filesFor(dir, from, to);
  for (const f of files) {
    if (!existsSync(f)) continue;
    if (!o.force) throw new Error(`${f} já existe (use --force para sobrescrever)`);
    unlinkSync(f);
  }
  let now = from;
  // Starts with at most one session (office fills via elevator throughout the morning).
  const sim = new DemoSimulator({ seed: o.seed, speed: o.pace, sessions: 1 }, from);
  // Everything here is mock data: all agents are marked as demo.
  const rec = new TimelineRecorder({ dir, now: () => now, isDemo: () => true, retentionDays: 0 });
  rec.ingest(sim.snapshot(now));
  for (; now <= to; now += stepMs) {
    sim.setSessions(sessionsAt((now - from) / (to - from), o.sessions));
    const r = sim.tick(now);
    if (r.changed) rec.ingest(sim.snapshot(now));
    else rec.tick();
  }
  now = to;
  rec.stop();
  return { files: files.filter((f) => existsSync(f)), from, to };
}

async function main(): Promise<void> {
  let opts: DemoTimelineOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const t0 = Date.now();
  const r = generateDemoTimeline(opts);
  const hhmm = (at: number) => new Date(at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Mock timeline for ${opts.date}, ${hhmm(r.from)}–${hhmm(r.to)}, generated in ${sec} s:`);
  for (const f of r.files) console.log(`  ${f}`);
  console.log(
    `\nTo watch:\n  HABBLAUD_DATA_DIR=${opts.dataDir} HABBLAUD_TIMELINE=0 npm start\nand open Timelapse in top bar.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
