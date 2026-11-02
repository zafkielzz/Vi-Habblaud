// Habblaud helper for messages to Codex when Habblaud runs in Docker. Runs on the HOST (Mac), with tsx:
//
//   npm run codex:bridge     (options: --port <n>, --once)
//
// Messages to Codex enter the session via `codex queue --thread <threadId> --message <text>`, which must run on the
// host (where Codex and account folders reside); inside Docker the server cannot reach the binary. Every 2 s, this
// process polls Habblaud for messages destined for Codex sessions (POST /api/codex/bridge/poll), runs the command
// for each in order with the account's CODEX_HOME, and acknowledges the result (POST /api/codex/bridge/ack). While
// running, the office allows sending messages to Codex agents (Habblaud considers it present up to 10 s after the
// last round). Outside Docker it is not needed: the server itself runs the command.
//
// Binary: HABBLAUD_CODEX_BIN or `codex` in PATH. Never runs Codex with -c, --enable, --disable or --no-daemon, and
// verifies each message first (thread id, existing Codex folder). Message text is never printed to the screen.
// Also starts new agents requested in the office (with HABBLAUD_PTY=1 in Habblaud; attachments saved to
// ~/.habblaud/attachments/), reads delivery files (only from known project folders, temp folder, and attachments),
// and transcribes dictation with local Whisper (whisper-cli + ffmpeg + model; see server/dictation/whisper.ts).
// Files and dictation use long-polling rounds: Habblaud only responds when work arrives (or every 20 s).
// Ctrl+C to stop.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { createCodexQueueRunner, findCodexBin, THREAD_ID, type CodexQueueResult, type CodexQueueRunner } from '../server/messages/codex';
import { tr } from '../shared/i18n';
import { createCliRunner, createOpener, folderProblem, launch, parseSpawn, type CliRunner, type Opener, type SpawnHow } from '../server/spawn/spawn';
import { runnableClaudeBin } from '../server/claude-bin';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_SPAWN, attachmentsRoot, promptWithAttachments, safeFileName, writeAttachments, type Attachment } from '../server/spawn/attachments';
import { createWhisperTranscriber, findWhisper, type Transcriber } from '../server/dictation/whisper';
import { checkFile, insideKnownFolder, tempRoots } from '../server/deliveries/files';
import { discoverClaudeDirs } from '../server/accounts/detect';
import { HOST_WAIT_MS } from '../server/host-wait';
import { readFileSync } from 'node:fs';

export const DEFAULT_PORT = 4747;
/** Interval between polling rounds. */
export const POLL_MS = 2_000;
/** Minimum pause between long-poll rounds (older Habblaud, which responds immediately) and after a refusal. */
export const WAIT_ROUND_MIN_MS = 500;
export const REFUSED_RETRY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;

const USAGE = tr('Usage: npm run codex:bridge [-- options]\n\nDelivers office messages to Codex sessions when Habblaud runs in Docker (keep it running on the computer).\n\nOptions:\n  --port <n>   Habblaud port (default: HABBLAUD_PORT or {0})\n  --once       runs a single pass and exits\n  -h, --help   shows this help\n\nCodex binary: HABBLAUD_CODEX_BIN or `codex` from PATH.', [DEFAULT_PORT]);

export interface BridgeMessage {
  id: string;
  account: string;
  codexHome: string;
  thread: string;
  text: string;
}

export interface BridgeResult {
  id: string;
  ok: boolean;
  error?: string;
  /** New agents: running in background (`cli`) or on app screen waiting for Enter (`app`). */
  how?: SpawnHow;
  note?: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { port: number; once: boolean } | 'help' {
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--once') once = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError(tr('--port needs a number between 1 and 65535.'));
    } else throw new FatalError(tr('unknown option: {0}\n\n{1}', [a, USAGE]));
  }
  return { port, once };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validates a message from Habblaud before running the command: id, text, thread id (UUID) and an existing
 * Codex folder on this computer (never a Claude Code one). Returns the message or refusal reason.
 */
export function checkMessage(raw: unknown): BridgeMessage | { id?: string; error: string } {
  const r = rec(raw);
  const id = typeof r?.id === 'string' && r.id.trim() ? r.id : undefined;
  if (!r || !id) return { error: tr('message without id') };
  if (typeof r.text !== 'string' || !r.text.trim()) return { id, error: tr('empty message') };
  if (typeof r.thread !== 'string' || !THREAD_ID.test(r.thread)) return { id, error: tr('invalid Codex thread id') };
  const home = typeof r.codexHome === 'string' ? r.codexHome : '';
  if (!home || !isAbsolute(home) || !isDir(home) || isClaudeDir(home)) return { id, error: tr("the Codex folder {0} doesn't exist on this computer", [home || tr('(empty)')]) };
  return { id, account: typeof r.account === 'string' ? r.account : '', codexHome: resolve(home), thread: r.thread, text: r.text };
}

/** POST JSON to local Habblaud; null = unreachable, timed out, or unreadable response. */
export type Post = (path: string, body: unknown) => Promise<{ status: number; json: unknown } | null>;

export function httpPost(port: number, timeoutMs = REQUEST_TIMEOUT_MS): Post {
  return async (path, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        // Habblaud's guard requires JSON on every API POST (even the empty round body).
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  };
}

export type RoundResult =
  | { state: 'down' }
  | { state: 'refused'; status: number; error?: string }
  | { state: 'ok'; results: BridgeResult[] };

/** One round: polls messages, runs `codex queue` for each (in order), and confirms results. Never throws. */
export async function round(post: Post, run: CodexQueueRunner, log: (line: string) => void = () => {}): Promise<RoundResult> {
  const polled = await post('/api/codex/bridge/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.messages;
  if (polled.status !== 200 || !Array.isArray(list)) {
    const error = rec(polled.json)?.error;
    return { state: 'refused', status: polled.status, ...(typeof error === 'string' ? { error } : {}) };
  }
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const m = checkMessage(raw);
    if ('error' in m) {
      if (m.id) {
        const result = { id: m.id, ok: false, error: m.error };
        results.push(result);
        await post('/api/codex/bridge/ack', { results: [result] });
      }
      log(tr('✗ message rejected: {0}', [m.error]));
      continue;
    }
    let r: CodexQueueResult;
    try {
      r = await run({ codexHome: m.codexHome, thread: m.thread, text: m.text });
    } catch (err) {
      r = { ok: false, error: String(err) };
    }
    const result = r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error };
    results.push(result);
    await post('/api/codex/bridge/ack', { results: [result] });
    log(r.ok ? tr('✓ message queued for thread {0}… ({1})', [m.thread.slice(0, 8), m.account || 'Codex']) : `✗ thread ${m.thread.slice(0, 8)}…: ${r.error}`);
  }
  return { state: 'ok', results };
}

/** Attachments of request from Habblaud: safe names, valid base64, size and count within limits. */
export function checkFiles(raw: unknown): Attachment[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_PER_SPAWN) return { error: tr('invalid attachments') };
  const out: Attachment[] = [];
  for (const f of raw) {
    const r = rec(f);
    if (!r || typeof r.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: tr('unreadable attachment') };
    const data = Buffer.from(r.data, 'base64');
    if (!data.length || data.length > ATTACHMENT_MAX_BYTES) return { error: tr('attachment empty or too large') };
    out.push({ name: safeFileName(typeof r.name === 'string' ? r.name : 'arquivo'), type: typeof r.type === 'string' ? r.type : '', data });
  }
  return out;
}

/** Log line for a newly opened agent: a full sentence per case (attachments and note), for translation. */
function spawnedLine(folder: string, how: SpawnHow, files: number, note?: string): string {
  if (how === 'cli') {
    if (!files) return tr('✓ new agent in {0} running in the background', [folder]);
    return files > 1
      ? tr('✓ new agent in {0} running in the background with {1} attachments', [folder, files])
      : tr('✓ new agent in {0} running in the background with 1 attachment', [folder]);
  }
  if (note) {
    if (!files) return tr("✓ new agent in {0} opened in the Claude app (didn't run on its own: {1})", [folder, note]);
    return files > 1
      ? tr("✓ new agent in {0} opened in the Claude app with {1} attachments (didn't run on its own: {2})", [folder, files, note])
      : tr("✓ new agent in {0} opened in the Claude app with 1 attachment (didn't run on its own: {1})", [folder, note]);
  }
  if (!files) return tr('✓ new agent in {0} opened in the Claude app', [folder]);
  return files > 1
    ? tr('✓ new agent in {0} opened in the Claude app with {1} attachments', [folder, files])
    : tr('✓ new agent in {0} opened in the Claude app with 1 attachment', [folder]);
}

/**
 * New agents via the office: polls requests (POST /api/host/spawn/poll), validates each (folder exists locally),
 * runs in background with `claude --bg` (with `cli`) or falls back to building claude://code/new link and opening
 * the Claude app; confirms at /api/host/spawn/ack. Never throws.
 */
export async function spawnRound(
  post: Post,
  open: Opener,
  log: (line: string) => void = () => {},
  problem: (folder: string) => string | undefined = folderProblem,
  write: (id: string, files: readonly Attachment[]) => string[] = (id, files) => writeAttachments(attachmentsRoot(), id, files),
  cli?: CliRunner,
): Promise<RoundResult> {
  const polled = await post('/api/host/spawn/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.spawns;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const id = typeof rec(raw)?.id === 'string' ? (rec(raw)!.id as string) : '';
    if (!id) continue;
    const req = parseSpawn(raw);
    const files = checkFiles(rec(raw)?.files);
    const bad = 'error' in req ? req.error : 'error' in files ? files.error : problem(req.folder);
    if (bad || 'error' in req || 'error' in files) {
      results.push({ id, ok: false, error: bad ?? tr('invalid request') });
      log(tr('✗ new agent rejected: {0}', [bad]));
      continue;
    }
    let r: { ok: true; how: SpawnHow; note?: string } | { ok: false; error: string };
    try {
      const paths = write(id, files);
      r = await launch({ folder: req.folder, prompt: promptWithAttachments(req.prompt, paths) }, open, cli);
    } catch (err) {
      r = { ok: false, error: String((err as Error)?.message ?? err) };
    }
    results.push(r.ok ? { id, ok: true, how: r.how, ...(r.note ? { note: r.note } : {}) } : { id, ok: false, error: r.error });
    log(!r.ok ? tr('✗ new agent in {0}: {1}', [req.folder, r.error]) : spawnedLine(req.folder, r.how, files.length, r.note));
  }
  if (results.length) await post('/api/host/spawn/ack', { results });
  return { state: 'ok', results };
}

/**
 * Dictation: polls audio clips (POST /api/host/dictation/poll), transcribes each with local Whisper, and returns
 * text and language to /api/host/dictation/ack. Text is never logged to screen. Never throws.
 */
export async function dictationRound(post: Post, transcribe: Transcriber, log: (line: string) => void = () => {}, opts: { wait?: boolean } = {}): Promise<RoundResult> {
  const polled = await post(`/api/host/dictation/poll${opts.wait ? '?wait=1' : ''}`, {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.dictations;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: Array<BridgeResult & { text?: string; lang?: string }> = [];
  for (const raw of list) {
    const r = rec(raw);
    const id = typeof r?.id === 'string' ? r.id : '';
    if (!id) continue;
    if (typeof r?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) {
      results.push({ id, ok: false, error: tr('unreadable audio') });
      continue;
    }
    const started = Date.now();
    try {
      const t = await transcribe(Buffer.from(r.data, 'base64'), typeof r.type === 'string' ? r.type : '');
      results.push({ id, ok: true, text: t.text, lang: t.lang });
      log(tr('✓ dictation transcribed ({0}, {1} s)', [t.lang || '?', ((Date.now() - started) / 1000).toFixed(1)]));
    } catch (err) {
      const error = (err as Error)?.message || tr('Whisper failed');
      results.push({ id, ok: false, error });
      log(tr('✗ dictation: {0}', [error]));
    }
  }
  if (results.length) await post('/api/host/dictation/ack', { results });
  return { state: 'ok', results };
}

/**
 * Delivery files: polls requested paths (POST /api/host/files/poll), validates each with checkFile (safe type,
 * no secrets, up to 25 MB, resolved symlinks) and `inside` (allowed folders), and returns content to
 * /api/host/files/ack. Never throws.
 */
export async function filesRound(
  post: Post,
  log: (line: string) => void = () => {},
  read: (p: string) => Buffer = readFileSync,
  check: typeof checkFile = checkFile,
  opts: { inside?: (realPath: string) => boolean; wait?: boolean } = {},
): Promise<RoundResult> {
  const polled = await post(`/api/host/files/poll${opts.wait ? '?wait=1' : ''}`, {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.files;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: Array<BridgeResult & { data?: string }> = [];
  for (const raw of list) {
    const r = rec(raw);
    const id = typeof r?.id === 'string' ? r.id : '';
    if (!id) continue;
    const checked = check(typeof r?.path === 'string' ? r.path : '');
    const c = 'error' in checked || !opts.inside || opts.inside(checked.path) ? checked : { error: tr('outside the known project folders') };
    if ('error' in c) {
      results.push({ id, ok: false, error: c.error });
      log(tr('✗ delivery file rejected: {0}', [c.error]));
      continue;
    }
    try {
      results.push({ id, ok: true, data: read(c.path).toString('base64') });
    } catch {
      results.push({ id, ok: false, error: tr('unreadable file') });
    }
  }
  if (results.length) await post('/api/host/files/ack', { results });
  return { state: 'ok', results: results.map(({ id, ok, error }) => ({ id, ok, ...(error ? { error } : {}) })) };
}

/** Repeats a long-poll round: down, every 2 s; refused (feature disabled), every minute. */
async function waitLoop(roundFn: () => Promise<RoundResult>): Promise<never> {
  for (;;) {
    const started = Date.now();
    const r = await roundFn();
    const pause = r.state === 'down' ? POLL_MS : r.state === 'refused' ? REFUSED_RETRY_MS : Math.max(0, WAIT_ROUND_MIN_MS - (Date.now() - started));
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const bin = findCodexBin(process.env);
  const run = bin ? createCodexQueueRunner(bin) : undefined;
  const open = createOpener();
  const claudeBin = runnableClaudeBin(process.env);
  const cli = claudeBin ? createCliRunner(claudeBin) : undefined;
  const post = httpPost(parsed.port);
  const log = (line: string) => console.log(`[codex-bridge] ${line}`);
  log(
    bin
      ? tr('Delivering Habblaud messages (http://127.0.0.1:{0}) to Codex sessions with {1}, and starting the new agents requested in the office. Ctrl+C to stop.', [parsed.port, bin])
      : tr('No Codex (codex in PATH or HABBLAUD_CODEX_BIN): only starting the new agents requested in Habblaud (http://127.0.0.1:{0}). Ctrl+C to stop.', [parsed.port]),
  );
  log(cli ? tr('New agents run in the background with {0} --bg (trusted folder; otherwise, in the Claude app).', [claudeBin]) : tr('No claude in PATH (or HABBLAUD_CLAUDE_BIN): new agents open in the Claude app and wait for Enter.'));
  const whisper = findWhisper(process.env);
  let transcribe: Transcriber | undefined;
  if ('missing' in whisper) log(tr('Dictation off: {0} is missing.', [whisper.missing]));
  else {
    log(tr('Dictation: local Whisper ({0}), languages {1} auto-detected.', [whisper.model.split('/').pop(), whisper.langs.join('/')]));
    transcribe = createWhisperTranscriber(whisper);
  }
  // Delivery files and dictation (user is waiting): long-poll rounds, each in its own loop.
  if (!parsed.once) {
    const waitPost = httpPost(parsed.port, HOST_WAIT_MS + 10_000);
    const accountDirs = discoverClaudeDirs(process.env);
    const roots = [...tempRoots(), attachmentsRoot()];
    const inside = (p: string) => insideKnownFolder(p, { accountDirs, roots });
    void waitLoop(() => filesRound(waitPost, log, undefined, undefined, { inside, wait: true }));
    if (transcribe) {
      const t = transcribe;
      void waitLoop(() => dictationRound(waitPost, t, log, { wait: true }));
    }
  }
  let last = '';
  // New agents disabled in Habblaud (without HABBLAUD_PTY=1): poll again only once per minute.
  let spawnRetryAt = 0;
  let spawned: RoundResult = { state: 'ok', results: [] };
  for (;;) {
    if (Date.now() >= spawnRetryAt) {
      spawned = await spawnRound(post, open, log, undefined, undefined, cli);
      if (spawned.state === 'refused') spawnRetryAt = Date.now() + REFUSED_RETRY_MS;
    }
    const r = run ? await round(post, run, log) : spawned;
    const state =
      r.state === 'down'
        ? tr('Habblaud is down at http://127.0.0.1:{0}; retrying every {1} s.', [parsed.port, POLL_MS / 1_000])
        : r.state === 'refused'
          ? tr('Habblaud refused ({0}{1}).', [r.status, r.error ? `: ${r.error}` : ''])
          : run
            ? tr('connected: Codex agents now receive messages from the office.')
            : tr('connected to Habblaud.');
    if (state !== last) log(state);
    last = state;
    if (parsed.once) {
      process.exitCode = r.state === 'ok' && r.results.every((x) => x.ok) ? 0 : 1;
      return;
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? tr('[codex-bridge] Error: {0}', [err.message]) : tr('[codex-bridge] Unexpected error: {0}', [String(err)]));
    process.exitCode = 1;
  });
}
