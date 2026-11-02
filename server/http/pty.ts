// Interactive terminal routes (PtyManager, server/pty/manager.ts):
//   GET  /api/pty                      feature status and open terminals
//   POST /api/pty                      {cwd, account?, cols?, rows?}: new Claude Code session;
//                                      {agy: agentId, cols?, rows?}: an Antigravity worker's interactive agy
//   GET  /api/pty/:id/stream           SSE: reset (screen buffer) | data | exit
//   POST /api/pty/:id/input|resize|close
//   POST /api/agents/:id/stop          stops agent (here or in another terminal)
//   POST /api/agents/:id/takeover      takes over session: stops there and resumes here
// Controlling these terminals executes commands on the machine: connections from computer itself only, with
// local Host and (when browser sends it) same-origin Origin. Request guard (http/guard.ts) already requires
// JSON on POST.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PtyError, type PtyManager } from '../pty/manager';
import { HttpError, readJson, sendJson } from './app';
import { isLoopbackHost } from './guard';
import { tr } from '../../shared/i18n';

/** /api/agents/:id/(stop|takeover) (ids never contain '/'). */
const AGENT_ACTION_ROUTE = /^\/api\/agents\/([^/]+)\/(stop|takeover)$/;

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return a === '::1' || a.startsWith('127.');
}

/** Rejection reason, or null. */
export function ptyRequestProblem(req: IncomingMessage): string | null {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return tr('the interactive terminal can only be used on the computer running Habblaud');
  const host = req.headers.host;
  if (!isLoopbackHost(host)) return tr('open Habblaud at http://localhost to use the interactive terminal');
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    let same = false;
    try {
      same = new URL(origin).host.toLowerCase() === String(host).trim().toLowerCase();
    } catch {
      same = false;
    }
    if (!same) return tr('origin not allowed for the interactive terminal');
  }
  // Browsers tag requests from another site (or another port on localhost = "same-site").
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return tr('origin not allowed for the interactive terminal');
  return null;
}

export function createPtyRoutes(ptys: PtyManager): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError || err instanceof PtyError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('internal error') });
  };
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('method not allowed') });
  };
  const noContent = (res: ServerResponse) => {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  };
  const decode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, tr('invalid id'));
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    const problem = ptyRequestProblem(req);
    if (problem) throw new HttpError(403, problem);
    const method = req.method ?? 'GET';
    const action = AGENT_ACTION_ROUTE.exec(path);
    if (action) {
      if (method !== 'POST') return notAllowed(res, 'POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      const id = decode(action[1]);
      if (action[2] === 'stop') {
        await ptys.stop(id);
        return noContent(res);
      }
      return sendJson(res, 201, await ptys.takeover(id, { cols: body?.cols, rows: body?.rows }));
    }
    const [rawId, act] = path.slice('/api/pty'.length).split('/').filter(Boolean);
    if (!rawId) {
      if (method === 'GET') return sendJson(res, 200, { status: ptys.status(), ptys: ptys.list() });
      if (method !== 'POST') return notAllowed(res, 'GET, POST');
      const body = (await readJson(req)) as Record<string, unknown>;
      if (body?.agy !== undefined) return sendJson(res, 201, ptys.openAgy({ agent: body.agy, cols: body?.cols, rows: body?.rows }));
      return sendJson(res, 201, ptys.create({ cwd: body?.cwd, account: body?.account, cols: body?.cols, rows: body?.rows }));
    }
    const id = decode(rawId);
    if (act === 'stream') {
      if (method !== 'GET') return notAllowed(res, 'GET');
      return ptys.attach(id, req, res);
    }
    if (method !== 'POST') return notAllowed(res, 'POST');
    const body = (await readJson(req)) as Record<string, unknown>;
    if (act === 'input') ptys.input(id, body?.data);
    else if (act === 'resize') ptys.resize(id, body?.cols, body?.rows);
    else if (act === 'close') ptys.close(id);
    else throw new HttpError(404, tr('unknown route'));
    noContent(res);
  };

  return (req, res, path) => {
    handle(req, res, path).catch((err) => fail(res, err));
  };
}
