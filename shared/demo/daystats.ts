// Fictional "My day" history for demo mode. Pure (no Node/DOM): server uses in demo bucket and browser in ?mock=1.
// Fills from yesterday (since midnight) to now with plausible workdays (busy morning and afternoon, calmer lunch,
// quiet night) across demo projects and accounts, giving the dashboard data as soon as demo starts.
// Deterministic via seed; nothing here comes from real data. Codex account rooms only add tokens (no cost recorded).
import { addDays, dayKeyOf, dayStart, HOUR_MS, hourStart, localHourOf, type AgentRef, type StatsBook, type StatsView, type TimedStatus } from '../daystats';
import { hash32, mulberry32 } from '../hash';
import { pickName } from '../names';
import { DEMO_PROJECT_NAMES } from './simulator';
import { tr } from '../i18n';

/** Work intensity by local hour (0 = idle, 1 = peak). */
const PROFILE = [0.03, 0.01, 0, 0, 0, 0, 0.02, 0.1, 0.4, 0.75, 0.95, 0.85, 0.4, 0.55, 0.9, 1, 0.95, 0.8, 0.55, 0.35, 0.3, 0.25, 0.15, 0.06];

const REASONS = [tr('approve a permission'), tr('answer a question'), tr('choose an option'), tr('approve the plan')];

interface FakeRoom {
  id: string;
  name: string;
  account: string;
  accountMeta?: { name: string; short: string; color: string };
  /** Codex account room: tokens, no cost. */
  codex: boolean;
  /** Room activity weight and how much it usually waits for you. */
  weight: number;
  waitiness: number;
  people: string[];
}

/**
 * Seeds `book` with fictional hours from yesterday 00:00 (in `tz` timezone) to `now`, for demo projects
 * (`view` rooms plus remainder of simulator list) and `view.accounts` (pass demo accounts only).
 * `tz` determines the profile's "business hours" (server timezone, or browser timezone in ?mock=1).
 */
export function seedDemoHistory(book: StatsBook, view: StatsView, now: number, tz: string, seed = hash32(`meu-dia:${hourStart(now)}`)): void {
  const rng = mulberry32(seed);
  const between = (a: number, b: number) => a + rng() * (b - a);
  const accounts = view.accounts.map((a) => ({ id: a.id, codex: 'provider' in a && a.provider === 'codex', meta: { name: a.name, short: a.short, color: a.color } }));
  // Other projects: half in first Claude Code account, 30% in last, and 20% in Codex (when present).
  const claude = accounts.filter((a) => !a.codex);
  const codex = accounts.find((a) => a.codex);
  const accountFor = (r: number) => (codex && claude.length ? (r < 0.5 ? claude[0] : r < 0.8 ? claude[claude.length - 1] : codex) : accounts[r < 0.6 ? 0 : accounts.length - 1]);
  const roomNames = new Map(view.rooms.map((r) => [r.id, r.name]));
  const usedNames = new Set(view.agents.map((a) => a.name));

  // Rooms with agents right now (in their most common account) alongside other demo projects.
  const byRoom = new Map<string, Map<string, number>>();
  for (const a of view.agents) {
    const accs = byRoom.get(a.roomId) ?? new Map<string, number>();
    accs.set(a.account, (accs.get(a.account) ?? 0) + 1);
    byRoom.set(a.roomId, accs);
  }
  const first = [...byRoom.keys()][0];
  if (!first || !accounts.length) return;
  const base = first.slice(0, first.lastIndexOf('/'));
  const extra: string[] = [];
  for (const name of DEMO_PROJECT_NAMES) {
    const id = `${base}/${name}`;
    if (byRoom.has(id)) continue;
    byRoom.set(id, new Map([[accountFor(rng()).id, 1]]));
    extra.push(id);
  }
  // Codex always has some project in history (dashboard shows its tokens, without cost).
  const extraCodex = extra.some((id) => byRoom.get(id)!.has(codex?.id ?? ''));
  if (codex && extra.length && !extraCodex) byRoom.set(extra[extra.length - 1], new Map([[codex.id, 1]]));
  const rooms: FakeRoom[] = [...byRoom].map(([id, accs]) => {
    const account = [...accs].sort((x, y) => y[1] - x[1])[0]?.[0] ?? accounts[0].id;
    const people = [0, 1, 2].map((k) => {
      const p = pickName(`${id}:${k}:${seed}`, usedNames);
      usedNames.add(p.name);
      return p.name;
    });
    const room: FakeRoom = {
      id,
      name: roomNames.get(id) ?? id.split('/').pop() ?? id,
      account,
      codex: !!accounts.find((a) => a.id === account)?.codex,
      weight: between(0.35, 1.1),
      waitiness: between(0.05, 0.3),
      people,
    };
    const meta = accounts.find((a) => a.id === account)?.meta;
    if (meta) room.accountMeta = meta;
    return room;
  });

  const current = hourStart(now);
  const from = hourStart(dayStart(addDays(dayKeyOf(now, tz), -1), tz));
  for (let hs = from; hs <= current; hs += HOUR_MS) {
    const span = Math.min(HOUR_MS, now - hs);
    if (span <= 0) continue;
    const frac = span / HOUR_MS;
    const base = PROFILE[localHourOf(hs, tz)] ?? 0;
    let wall = 0;
    rooms.forEach((room, ri) => {
      const level = base * room.weight * between(0.7, 1.3);
      if (level < 0.04) return;
      const mains = level > 0.6 ? 2 : 1;
      const ref = (key: string): AgentRef => {
        const r: AgentRef = { key, room: room.id, roomName: room.name, account: room.account };
        if (room.accountMeta) r.accountMeta = room.accountMeta;
        return r;
      };
      const mainRefs = Array.from({ length: mains }, (_, k) => ref(`m:demo-dia-${ri}-${k}`));
      const working = Math.min(0.92, level * between(0.55, 0.85)) * HOUR_MS * frac;
      const waiting = working * room.waitiness * between(0.5, 1.4);
      const shell = working * between(0, 0.12);
      const idle = Math.max(0, mains * HOUR_MS * frac * 0.9 - working - waiting - shell) * between(0.3, 0.7);
      const parts: Array<[TimedStatus, number]> = [
        ['working', working],
        ['waiting', waiting],
        ['shell', shell],
        ['idle', idle],
      ];
      for (const [status, ms] of parts) for (const r of mainRefs) book.addMsAt(r, status, hs, ms / mains, Math.min(now, hs + span));
      // Subagents: a bit of extra work during busy hours.
      const subs = Math.round(level * between(0, 2.2));
      for (let j = 0; j < subs; j++) book.addMsAt(ref(`s:demo-dia-${ri}-${hs}-${j}`), 'working', hs, working * between(0.15, 0.45), Math.min(now, hs + span));

      const workMin = working / 60_000;
      const at = hs + span / 2;
      const r0 = mainRefs[0];
      book.addCount(r0, 'prompts', Math.round((workMin / 7) * between(0.6, 1.4)), at);
      book.addCount(r0, 'toolCalls', Math.round(workMin * between(1.5, 3)), at);
      book.addCount(r0, 'tasksDone', Math.round((workMin / 12) * between(0.4, 1.2)), at);
      const tokensIn = Math.round(workMin * between(90_000, 160_000));
      const tokensOut = Math.round(workMin * between(1_000, 2_200));
      book.addCount(r0, 'tokensIn', tokensIn, at);
      book.addCount(r0, 'tokensOut', tokensOut, at);
      if (!room.codex) book.addCount(r0, 'costUSD', Math.round((tokensIn * 0.3e-6 + tokensOut * 15e-6) * 10_000) / 10_000, at);

      // Hour waits become 1 to 3 episodes from occupants in the room.
      if (waiting >= 30_000) {
        const n = 1 + Math.floor(rng() * Math.min(3, waiting / 60_000));
        let left = waiting;
        for (let k = 0; k < n && left >= 5_000; k++) {
          const dur = k === n - 1 ? left : left * between(0.3, 0.7);
          left -= dur;
          const start = hs + rng() * Math.max(0, span - dur);
          const who = room.people[Math.floor(rng() * room.people.length)];
          // Codex only waits for approval (selection still runs, keeping remainder unchanged).
          const reason = REASONS[Math.floor(rng() * REASONS.length)];
          book.addWait({
            agentId: `demo-dia:${ri}:${who}`,
            agentName: who,
            roomId: room.id,
            account: room.account,
            start: Math.round(start),
            end: Math.round(start + dur),
            reason: room.codex ? tr('approve a command') : reason,
          });
        }
        wall += waiting * between(0.75, 0.95);
      }
    });
    book.addWaitWallAt(hs, Math.min(wall, span), Math.min(now, hs + span));
  }
}
