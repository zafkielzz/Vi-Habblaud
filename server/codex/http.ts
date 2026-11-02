// Codex hook events (mod/habblaud-codex/hook.mjs, which npm run codex:install adds to <CODEX_HOME>/hooks.json):
// SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop, SubagentStart, SubagentStop, and
// SessionEnd arrive here with the account and go to the Codex source (CodexLive), which updates the agent immediately
// without waiting for conversation to hit disk. Events only observe (responses never return to session), but are only
// valid from the computer itself: lock (local Host and, outside Docker, loopback connection) is checked in
// http/app.ts (hook runs on Mac and talks to 127.0.0.1; in Docker, via published port). Guard (http/guard.ts)
// already required JSON.
//
//   POST /api/codex/events   (hook)   {account?, codexHome?, event: <hook stdin, trimmed text>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CodexLive } from '../sources/codex/live';
import { tr } from '../../shared/i18n';

type Rec = Record<string, unknown>;

export interface CodexHookEvent {
  /** Account computed by hook (basename of CODEX_HOME). */
  account?: string;
  /** Session's CODEX_HOME directory, on computer where hook runs. */
  codexHome?: string;
  /** Hook's stdin (hook_event_name, session_id...). */
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Body of POST /api/codex/events. Without `event` (object with hook_event_name): 400. */
export function parseCodexEvent(raw: unknown): CodexHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'expected {account?, codexHome?, event: <Codex hook JSON>}');
  const out: CodexHookEvent = { event };
  const account = shortStr(r.account, 200);
  const codexHome = shortStr(r.codexHome, 4_096);
  if (account) out.account = account;
  if (codexHome) out.codexHome = codexHome;
  return out;
}

/**
 * Codex account of a hook event: from CODEX_HOME dir sent (via host path, AccountInfo.configDir,
 * or read by this process); otherwise what it computed (basename unaware of disambiguated ids, e.g. ".codex~2").
 */
export function codexAccountOf(entries: readonly AccountEntry[], account: string | undefined, codexHome: string | undefined): string | undefined {
  if (codexHome && isAbsolute(codexHome)) {
    const abs = resolve(codexHome);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

/** Handles POST /api/codex/events (method and Host already checked). `ok` = Codex source handled the event. */
export async function handleCodexEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: CodexLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseCodexEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(codexAccountOf(deps.entries(), body.account, body.codexHome), body.event) === true;
    } catch (err) {
      log.warnOnce(`codex-event:${errMsg(err)}`, tr('Codex events: failed to apply an event ({0}).', [errMsg(err)]));
    }
  }
  sendJson(res, 200, { ok });
}
