// Terminal history (/api/sessions/* routes):
//   GET /api/sessions/recent                       -> RecentSessionsResponse (sessions from the last 7 days)
//   GET /api/sessions/:account/:sessionId/terminal -> SSE with the same protocol as the agent terminal
// Same lock as the terminal (ServerConfig.terminal + local Host), because they expose titles and conversations. The
// account must be one of the known ones, the id must have a UUID format, and the transcript must stay inside the
// account folder (each tool validates its own: sources/history.ts for Claude Code): no path traversal.
// HistorySet (sources/source.ts) lists and resolves, joining history across all tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecentSessionsResponse } from '../../shared/types';
import { errMsg, log } from '../log';
import { HISTORY_DAYS, HISTORY_LIMIT } from '../sources/history';
import type { SessionLookup } from '../sources/source';
import { sendJson } from './app';
import { isLoopbackHost } from './guard';
import type { TerminalStreams } from './terminal';
import { tr } from '../../shared/i18n';

export interface SessionRoutesDeps {
  /** Missing = feature disabled (no local bind). */
  history?: SessionLookup;
  /** Missing = terminal disabled. */
  terminals?: TerminalStreams;
  /** Remote port (http/remote.ts): decision already made by API; missing = local Host lock, as before. */
  trusted?: boolean;
}

const RECENT_ROUTE = '/api/sessions/recent';
/** GET /api/sessions/:account/:sessionId/terminal (segments without '/'; %2F only appears after decode). */
const TERMINAL_ROUTE = /^\/api\/sessions\/([^/]+)\/([^/]+)\/terminal$/;

/** Why lock rejects request (undefined = allowed): same text as agent terminal. */
export function sessionsLockError(enabled: boolean, host: string | undefined, trusted?: boolean): string | undefined {
  if (!enabled) return tr('terminal disabled: it only works when Habblaud is reachable only from the computer running it');
  if (trusted === false) return tr('not allowed over remote access (see HABBLAUD_REMOTE_ALLOW)');
  if (trusted === undefined && !isLoopbackHost(host)) return tr('the terminal only opens from the computer running Habblaud (http://localhost or http://127.0.0.1)');
  return undefined;
}

function decode(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** Handles /api/sessions/* (route already recognized by prefix in http/app.ts). */
export function handleSessionsRoute(req: IncomingMessage, res: ServerResponse, path: string, deps: SessionRoutesDeps): void {
  const method = req.method ?? 'GET';
  const terminalMatch = TERMINAL_ROUTE.exec(path);
  const recent = path === RECENT_ROUTE;
  if (!recent && !terminalMatch) return sendJson(res, 404, { error: tr('unknown route') });
  if (method !== 'GET' && !(recent && method === 'HEAD')) {
    res.setHeader('Allow', recent ? 'GET, HEAD' : 'GET');
    return sendJson(res, 405, { error: tr('method not allowed') });
  }
  const { history, terminals } = deps;
  const locked = sessionsLockError(!!history && !!terminals, req.headers.host, deps.trusted);
  if (locked || !history || !terminals) return sendJson(res, 403, { error: locked });

  if (recent) {
    history
      .list()
      .then((sessions) => {
        const body: RecentSessionsResponse = { sessions, days: HISTORY_DAYS, limit: HISTORY_LIMIT };
        sendJson(res, 200, body);
      })
      .catch((err) => {
        log.warnOnce(`history-list:${errMsg(err)}`, tr('Session history: failed to list ({0}).', [errMsg(err)]));
        if (!res.headersSent) sendJson(res, 500, { error: tr("couldn't list the sessions") });
      });
    return;
  }

  const account = decode(terminalMatch![1]);
  const sessionId = decode(terminalMatch![2]);
  if (account === undefined || sessionId === undefined) return sendJson(res, 400, { error: tr('invalid address') });
  const found = history.resolve(account, sessionId);
  if ('error' in found) return sendJson(res, found.status, { error: found.error });
  terminals.attachSession(req, res, `session:${account}:${sessionId}`, found.path, found.createParser);
}
