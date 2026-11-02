// Accounts dialog routes (client/src/ui/accounts.ts): add and sign in Claude Code and Antigravity accounts, apart
// from sessions. Each one opens a sign-in terminal (PtyManager.openLogin), so it needs the interactive terminal and
// has its guard (computer only, local Host, same origin: ptyRequestProblem).
//   GET  /api/accounts                 Antigravity profiles on disk: {agy: [{acc, account, state}]}
//   POST /api/accounts/claude {name}   new ~/.claude-<name>, watched at once; `claude auth login` in it
//   POST /api/accounts/agy             new ~/.agy_profiles/accN (an unfinished one, else first free N); `agy-as accN`
//   POST /api/accounts/login {account} sign in again: Claude `claude auth login`, Antigravity `agy-as accN`
// Answers {account, acc?, pty} (the terminal, opened by the page) or {error}.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import { PtyError, type PtyManager } from '../pty/manager';
import { AGY_OFF_ROLE, emailFromLogs, parseRolesConf } from '../sources/agy/profiles';
import { HttpError, readJson, sendJson } from './app';
import { ptyRequestProblem } from './pty';
import { tr } from '../../shared/i18n';
import type { PtyInfo } from '../../shared/types';

/** What the accounts routes need from the server. */
export interface AccountsRouteDeps {
  ptys: PtyManager;
  home: string;
  /** Antigravity profile root (~/.agy_profiles). */
  agyRoot: string;
  claudeBin: string;
  /** The agy-as script (~/.local/bin/agy-as). */
  agyBin: string;
  /** Claude Code accounts watched now: id and config dir. */
  claudeAccounts: () => Array<{ id: string; dir: string; isDefault: boolean }>;
  /** Starts watching a new Claude Code config dir; its account id. */
  addClaudeDir: (dir: string) => string | undefined;
  /** Reads the accounts again (after a sign-in terminal closes). */
  refresh: () => void;
}

/**
 * An Antigravity profile on disk: `ready` = signed in (agy's log has its OAuth e-mail; the login itself sits in the
 * profile's keyring), `new` = sign-in not finished (agy makes its state folder before you sign in, so that folder
 * says nothing), `off` = vacant in roles.conf.
 */
export interface AgyProfileState {
  acc: string;
  /** Account id in the office (AccountInfo.id). */
  account: string;
  state: 'ready' | 'new' | 'off';
}

/** Claude account name typed in the dialog: becomes the folder ~/.claude-<name>. */
const CLAUDE_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/i;
const AGY_ACC = /^acc(\d+)$/;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Antigravity profiles (accN folders) in natural order, with their state. */
export function agyProfileStates(root: string): AgyProfileState[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  let roles = new Map<string, string>();
  try {
    roles = parseRolesConf(readFileSync(join(root, 'roles.conf'), 'utf8'));
  } catch {
    // no roles.conf: no vacant accounts
  }
  return names
    .filter((n) => AGY_ACC.test(n) && isDir(join(root, n)))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((acc) => ({
      acc,
      account: `agy:${acc}`,
      state: roles.get(acc) === AGY_OFF_ROLE ? 'off' : emailFromLogs(join(root, acc, '.gemini', 'antigravity-cli')) ? 'ready' : 'new',
    }));
}

/** First free profile name: acc1, acc2... (gaps are reused). */
export function nextAgyAcc(root: string): string {
  const taken = new Set(agyProfileStates(root).map((p) => p.acc));
  for (let n = 1; ; n++) if (!taken.has(`acc${n}`)) return `acc${n}`;
}

export function createAccountsRoutes(deps: AccountsRouteDeps): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError || err instanceof PtyError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('internal error') });
  };
  const size = (body: Record<string, unknown>) => ({ cols: body.cols, rows: body.rows });

  const claudeLogin = (account: { id: string; dir: string; isDefault: boolean }, body: Record<string, unknown>): PtyInfo =>
    deps.ptys.openLogin({
      account: account.id,
      file: deps.claudeBin,
      args: ['auth', 'login'],
      cwd: deps.home,
      env: account.isDefault ? {} : { CLAUDE_CONFIG_DIR: account.dir },
      onExit: deps.refresh,
      ...size(body),
    });

  const agyLogin = (acc: string, body: Record<string, unknown>): PtyInfo =>
    deps.ptys.openLogin({ account: `agy:${acc}`, file: deps.agyBin, args: [acc], cwd: join(deps.agyRoot, acc), onExit: deps.refresh, ...size(body) });

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const problem = ptyRequestProblem(req);
    if (problem) throw new HttpError(403, problem);
    const method = req.method ?? 'GET';
    if (path === '/api/accounts') {
      if (method !== 'GET') throw new HttpError(405, tr('method not allowed'));
      return sendJson(res, 200, { agy: agyProfileStates(deps.agyRoot) });
    }
    if (method !== 'POST') throw new HttpError(405, tr('method not allowed'));
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;
    if (path === '/api/accounts/claude') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!CLAUDE_NAME.test(name)) throw new HttpError(400, tr('Account name: letters, digits, - or _ (up to 31)'));
      const dir = join(deps.home, `.claude-${name}`);
      if (deps.claudeAccounts().some((a) => a.dir === dir)) throw new HttpError(409, tr('{0} is already an account: use "Sign in again"', [basename(dir)]));
      if (existsSync(dir) && !isDir(dir)) throw new HttpError(409, tr('{0} exists and is not a folder', [dir]));
      // `projects/` makes the folder a Claude Code account for discovery (also after a restart).
      mkdirSync(join(dir, 'projects'), { recursive: true });
      const id = deps.addClaudeDir(dir);
      const account = deps.claudeAccounts().find((a) => a.id === id);
      if (!account) throw new HttpError(500, tr('the new account was not picked up'));
      return sendJson(res, 201, { account: account.id, pty: claudeLogin(account, body) });
    }
    if (path === '/api/accounts/agy') {
      // A profile whose sign-in was left unfinished is used again rather than leaving empty ones behind.
      const acc = agyProfileStates(deps.agyRoot).find((p) => p.state === 'new')?.acc ?? nextAgyAcc(deps.agyRoot);
      mkdirSync(join(deps.agyRoot, acc), { recursive: true });
      return sendJson(res, 201, { account: `agy:${acc}`, acc, pty: agyLogin(acc, body) });
    }
    if (path === '/api/accounts/login') {
      const id = typeof body.account === 'string' ? body.account : '';
      const claude = deps.claudeAccounts().find((a) => a.id === id);
      if (claude) return sendJson(res, 201, { account: id, pty: claudeLogin(claude, body) });
      const agy = agyProfileStates(deps.agyRoot).find((p) => p.account === id);
      if (agy) return sendJson(res, 201, { account: id, acc: agy.acc, pty: agyLogin(agy.acc, body) });
      throw new HttpError(404, tr('unknown account'));
    }
    throw new HttpError(404, tr('unknown route'));
  };

  return (req, res, path) => {
    handle(req, res, path).catch((err) => fail(res, err));
  };
}
