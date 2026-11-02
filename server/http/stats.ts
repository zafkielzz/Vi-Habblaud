// "My day" routes: GET /api/stats?day=YYYY-MM-DD&tz=<IANA>&source=real|demo and GET /api/stats/days?tz=<IANA>.
// Only aggregated numbers and project, account and agent names — the same exposure as /api/snapshot, so they work
// with the port exposed (without the local bind lock of the terminal). Parameters are strictly validated (400).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { addDays, canonicalTimeZone, parseDayKey, RETENTION_DAYS, type StatsSource } from '../../shared/daystats';
import type { DayStatsService } from '../history/daystats';
import { tr } from '../../shared/i18n';

type Send = (res: ServerResponse, status: number, body: unknown) => void;

export type StatsQuery = { ok: true; day: string; tz: string; source?: StatsSource } | { ok: false; status: number; error: string };

/** A parameter appears at most once (value is validated by caller). */
function single(url: URL, name: string): { value?: string; error?: string } {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) return { error: tr('repeated parameter "{0}"', [name]) };
  if (!all.length) return {};
  return { value: all[0] };
}

/** Reads and validates `tz` (default: server timezone). */
function parseTz(url: URL, fallback: string): { tz?: string; error?: string } {
  const p = single(url, 'tz');
  if (p.error) return { error: p.error };
  if (p.value === undefined) return { tz: fallback };
  const tz = canonicalTimeZone(p.value);
  if (!tz) return { error: tr('invalid time zone: use an IANA name, e.g. America/New_York') };
  return { tz };
}

/**
 * Validates query for GET /api/stats. `today(tz)` returns today in requested timezone. Errors: 400 (format,
 * non-existent date, future date, repeated parameter, invalid timezone or source) and 404 (outside retention).
 */
export function parseStatsQuery(url: URL, defaultTz: string, today: (tz: string) => string): StatsQuery {
  const t = parseTz(url, defaultTz);
  if (!t.tz) return { ok: false, status: 400, error: t.error ?? tr('invalid time zone') };
  const d = single(url, 'day');
  if (d.error) return { ok: false, status: 400, error: d.error };
  const now = today(t.tz);
  const day = d.value ?? now;
  if (!parseDayKey(day)) return { ok: false, status: 400, error: tr('invalid day: use YYYY-MM-DD (e.g. 2026-10-08)') };
  if (day > now) return { ok: false, status: 400, error: tr('day in the future') };
  if (day < addDays(now, -RETENTION_DAYS)) return { ok: false, status: 404, error: tr('Habblaud only keeps the last {0} days', [RETENTION_DAYS]) };
  const s = single(url, 'source');
  if (s.error) return { ok: false, status: 400, error: s.error };
  if (s.value !== undefined && s.value !== 'real' && s.value !== 'demo') return { ok: false, status: 400, error: tr('invalid source: use real or demo') };
  const out: StatsQuery = { ok: true, day, tz: t.tz };
  if (s.value) out.source = s.value;
  return out;
}

/** Handles /api/stats and /api/stats/*. */
export function handleStatsRoute(req: IncomingMessage, res: ServerResponse, url: URL, stats: DayStatsService | undefined, send: Send): void {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== '/api/stats' && path !== '/api/stats/days') {
    send(res, 404, { error: tr('unknown route') });
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    send(res, 405, { error: tr('method not allowed') });
    return;
  }
  if (!stats) {
    send(res, 404, { error: tr('stats unavailable') });
    return;
  }
  if (path === '/api/stats/days') {
    const t = parseTz(url, stats.tz);
    if (!t.tz) send(res, 400, { error: t.error ?? tr('invalid time zone') });
    else send(res, 200, stats.days(t.tz));
    return;
  }
  const q = parseStatsQuery(url, stats.tz, (tz) => stats.today(tz));
  if (!q.ok) {
    send(res, q.status, { error: q.error });
    return;
  }
  if (q.source === 'demo' && !stats.isDemo()) {
    send(res, 404, { error: tr('demo mode is off') });
    return;
  }
  const body = stats.day(q.day, q.tz, q.source);
  if (body) send(res, 200, body);
  else send(res, 404, { error: tr('no stats for this day') });
}
