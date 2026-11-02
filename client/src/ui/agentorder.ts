// User-selected agent order per project (dragging rows in sidebar): one order per project,
// stored in browser by Claude Code session (not by process, which changes on session resume).
const ORDER_KEY = 'habblaud.tabs.order';
/** Remembered projects (most recent). */
const MAX_ROOMS = 50;

type OrderMap = Record<string, string[]>;

/** Stored order first (by session); unlisted items go to the end in the order they arrived. */
export function orderAgents<T>(roomId: string, items: readonly T[], sessionOf: (item: T) => string): T[] {
  const saved = loadOrder()[roomId];
  if (!saved?.length) return items.slice();
  const rank = new Map(saved.map((sid, i) => [sid, i]));
  return items
    .map((item, i) => ({ item, i, r: rank.get(sessionOf(item)) }))
    .sort((x, y) => (x.r ?? Infinity) - (y.r ?? Infinity) || x.i - y.i)
    .map((x) => x.item);
}

/** Places `from` before (or after) `to` in `items` (already in displayed order) and saves project order. */
export function moveAgent<T>(roomId: string, items: readonly T[], idOf: (item: T) => string, sessionOf: (item: T) => string, from: string, to: string, after: boolean): boolean {
  const moved = items.find((a) => idOf(a) === from);
  const rest = items.filter((a) => idOf(a) !== from);
  const at = rest.findIndex((a) => idOf(a) === to);
  if (!moved || at < 0) return false;
  rest.splice(after ? at + 1 : at, 0, moved);
  saveOrder(roomId, rest.map(sessionOf));
  return true;
}

function loadOrder(): OrderMap {
  try {
    const v = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    // Session lists only: unexpected format (manually edited, other version) must not break the sidebar.
    const map: OrderMap = {};
    for (const [room, ids] of Object.entries(v)) {
      if (Array.isArray(ids)) map[room] = ids.filter((x): x is string => typeof x === 'string');
    }
    return map;
  } catch {
    return {};
  }
}

function saveOrder(roomId: string, sessions: string[]): void {
  try {
    const map = loadOrder();
    delete map[roomId];
    map[roomId] = sessions;
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ROOMS))) delete map[k];
    localStorage.setItem(ORDER_KEY, JSON.stringify(map));
  } catch {
    // no storage: order lasts only until page reload
  }
}
