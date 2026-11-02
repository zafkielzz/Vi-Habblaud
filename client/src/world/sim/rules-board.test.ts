// The reception rules poster: active rules per office, and a short flash for a NEW violation only.
import { describe, expect, it } from 'vitest';
import type { OfficeInfo, OfficeSnapshot } from '../../../../shared/types';
import { defaultRules, type RuleViolation } from '../../../../shared/rules';
import type { Appearance, ArtModule, RoomTheme } from '../../art/api';
import { DEFAULT_WORLD_OPTIONS } from '../api';
import { RULES_FLASH_MS, Sim } from './sim';

const T0 = 1_700_000_000_000;
const theme = { carpet: '#4f6d8f', carpet2: '#486685', wall: { base: '#e6e2da', trim: '#9a8f80', pattern: 'plain' }, accent: '#3f7fd8', deskVariant: 'wood', chairVariant: 'black' } as RoomTheme;
const art = { appearanceFromSeed: () => ({}) as Appearance, roomTheme: () => theme } as unknown as ArtModule;
const violation = (at: number): RuleViolation => ({ at, office: 'a', who: 'acc2', kind: 'deny', detail: '~/.ssh/id', by: 'hook' });
const snap = (offices: OfficeInfo[]): OfficeSnapshot =>
  ({ rev: 1, serverTime: T0, rooms: [], agents: [], accounts: [], meta: { demo: true, sources: [], startedAt: T0, version: 't' }, team: { workers: [], agy: [], offices } }) as OfficeSnapshot;
const rules = defaultRules();
const office = (id: string, extra: Partial<OfficeInfo> = {}): OfficeInfo => ({ id, name: id, folder: `/${id}`, workers: [], ...extra });

describe('reception rules poster', () => {
  it('counts the active rules; no poster without rules from the server', () => {
    const sim = new Sim(art, () => DEFAULT_WORLD_OPTIONS);
    const two = { ...rules, items: [...rules.items, { id: 'r2', text: 'x', for: 'all' as const, on: false }, { id: 'r3', text: 'y', for: 'boss' as const, on: true }] };
    sim.applySnapshot(snap([office('a', { rules: two }), office('b')]), T0);
    expect(sim.officeRules('a')?.rules).toBe(2);
    expect(sim.officeRules('b')).toBeUndefined();
  });

  it('old violations do not flash on load; a newer one flashes for a few seconds', () => {
    const sim = new Sim(art, () => DEFAULT_WORLD_OPTIONS);
    sim.applySnapshot(snap([office('a', { rules, violations: [violation(T0 - 1000)] })]), T0);
    expect(sim.officeRules('a')?.flashUntil).toBe(0);
    sim.applySnapshot(snap([office('a', { rules, violations: [violation(T0 - 1000)] })]), T0 + 10);
    expect(sim.officeRules('a')?.flashUntil).toBe(0);
    sim.applySnapshot(snap([office('a', { rules, violations: [violation(T0 + 50), violation(T0 - 1000)] })]), T0 + 100);
    expect(sim.officeRules('a')?.flashUntil).toBe(T0 + 100 + RULES_FLASH_MS);
    // the office loses its rules (older server, or deleted): no poster
    sim.applySnapshot(snap([office('a')]), T0 + 200);
    expect(sim.officeRules('a')).toBeUndefined();
  });
});
