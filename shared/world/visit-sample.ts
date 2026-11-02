// Sample building, matching format sent by world server on building entry (`WorldBuildingDetail`): for tests
// and visit demo mode (?mock=1) only. Incoming ONLY: nothing here uploads to world or enters building
// packet (packet produced only by projection.ts, from real office). 3 floors and 6 Claude Code and Codex agents:
// working, waiting, watching a shell (counts as working in building summary), and idle, with one subagent
// whose parent is on floor and one without (parent departed).
import { hash32 } from '../hash';
import { flattenAppearance } from './appearance-flat';
import type { WorldAgent, WorldBuildingDetail } from './protocol';

function agent(id: string, name: string, look: 'f' | 'm', kind: WorldAgent['kind'], provider: WorldAgent['provider'], status: WorldAgent['status'], parentId?: string): WorldAgent {
  return { id, kind, ...(parentId ? { parentId } : {}), provider, status, look, name, parts: flattenAppearance(hash32(id), undefined, look) };
}

/** Sample interior: live; `discreet` = discreet mode; `away` = powered-down (paused). Floors remain in both. */
export function sampleBuildingDetail(mode: 'live' | 'discreet' | 'away' = 'live'): WorldBuildingDetail {
  const live = mode === 'live';
  const floors: WorldBuildingDetail['floors'] = [
    {
      id: 'f_0a1b2c3d4e',
      label: 'ipe',
      agents: [agent('a_1f2e3d4c', 'Marina', 'f', 'main', 'claude', 'working'), agent('a_2a3b4c5d', 'Rafael', 'm', 'sub', 'claude', 'working', 'a_1f2e3d4c')],
    },
    {
      id: 'f_1b2c3d4e5f',
      label: 'jade',
      agents: [agent('a_3c4d5e6f', 'Beatriz', 'f', 'main', 'codex', 'waiting'), agent('a_4d5e6f70', 'Thiago', 'm', 'sub', 'codex', 'shell')],
    },
    {
      id: 'f_2c3d4e5f60',
      label: 'aurora',
      agents: [agent('a_5e6f7081', 'Larissa', 'f', 'main', 'claude', 'idle'), agent('a_6f708192', 'Gustavo', 'm', 'main', 'codex', 'idle')],
    },
  ].map((f) => (live ? f : { ...f, agents: [] }));
  return {
    building: {
      id: 'o_7a8b9c0d1e2f',
      lot: { district: 'centro', x: 3, y: 5 },
      owner: { id: 'o_7a8b9c0d1e2f', name: 'Helena', country: 'BR' },
      state: mode === 'away' ? 'away' : 'online',
      theme: 'none',
      floors: floors.length,
      ...(live ? { agents: { total: 6, working: 3, waiting: 1, idle: 2 } } : {}),
      ...(mode === 'discreet' ? { discreet: true } : {}),
      rev: 12,
      likes: 3,
      sinceMonth: '2026-10',
    },
    floors,
    visitors: 1,
  };
}
