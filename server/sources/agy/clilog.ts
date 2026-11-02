// What an agy run really uses, read from its own log: `<stateDir>/log/cli-<YYYYMMDD_HHMMSS>.log`, one file per agy
// process, whose first line names the process ("Starting language server process with pid N"). The flags a job asked
// for (agy-ask's start line) are only a request; these lines say what agy applied:
//   "Print mode: applying agent mode plan"  /  "SetCycleMode called: plan"            -> mode
//   "Propagating selected model override to backend: label="Gemini 3.8 Flash (Low)"" -> model and effort
// The model line comes a few seconds after the start, so a run is read again while its file grows.
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Mode, model id and effort an agy run applied (each absent until its line shows up). */
export interface AgyRunInfo {
  mode?: string;
  model?: string;
  effort?: string;
}

/** How many of the newest log files are searched for a PID (agy starts one per process, usage checks included). */
const SEARCH_FILES = 40;
/** Logs are ~25 KB; a runaway one is read only up to here. */
const MAX_READ = 2 * 1024 * 1024;

/** "Gemini 3.8 Flash (Low)" -> { model: "gemini-3.8-flash", effort: "low" }. */
export function parseModelLabel(label: string): { model: string; effort?: string } {
  const m = /^(.*?)\s*\((\w+)\)\s*$/.exec(label.trim());
  const name = (m ? m[1] : label).trim();
  const model = name.toLowerCase().replace(/\s+/g, '-');
  return m ? { model, effort: m[2].toLowerCase() } : { model };
}

/** The account's own default (`settings.json` "model", the label `/model` saved), e.g. { effort: "high" }; {} without one. */
export function settingsModel(stateDir: string): { model?: string; effort?: string } {
  try {
    const label = (JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8')) as { model?: unknown }).model;
    return typeof label === 'string' && label.trim() ? parseModelLabel(label) : {};
  } catch {
    return {};
  }
}

/** The last mode and model line of a log: later lines win (a mode or model changed during the run). */
export function parseAgyCliLog(text: string): AgyRunInfo {
  const info: AgyRunInfo = {};
  for (const m of text.matchAll(/(?:applying agent mode|SetCycleMode called:)\s+([\w-]+)|model override to backend: label="([^"]+)"/g)) {
    if (m[1]) info.mode = m[1].replace(/_/g, '-');
    else if (m[2]) Object.assign(info, parseModelLabel(m[2]));
  }
  return info;
}

/** The log file of agy process `pid` among the newest ones in `logDir`, or undefined. */
export function findAgyCliLog(logDir: string, pid: number): string | undefined {
  let names: string[];
  try {
    names = readdirSync(logDir).filter((n) => /^cli-\d{8}_\d{6}\.log$/.test(n));
  } catch {
    return undefined;
  }
  names.sort().reverse();
  const needle = `process with pid ${pid}\n`;
  for (const name of names.slice(0, SEARCH_FILES)) {
    const path = join(logDir, name);
    if (firstBytes(path, 256).includes(needle)) return path;
  }
  return undefined;
}

/** Reads a run's log (up to MAX_READ) and parses it. */
export function readAgyRun(path: string): AgyRunInfo {
  try {
    return parseAgyCliLog(statSync(path).size > MAX_READ ? firstBytes(path, MAX_READ) : readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function firstBytes(path: string, n: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(n);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, n, 0));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
