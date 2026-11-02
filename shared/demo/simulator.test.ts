import { describe, expect, it } from 'vitest';
import { DemoSimulator } from './simulator';

describe('DemoSimulator', () => {
  it('with ?mock=1 mimics accounts C and D (and Codex last)', () => {
    const sim = new DemoSimulator({ seed: 1 }, 1_000);
    expect(sim.snapshot(1_000).accounts.map((a) => [a.id, a.short, a.provider])).toEqual([
      ['.claude', 'C', undefined],
      ['.claude-conta2', 'D', undefined],
      ['.codex', 'X', 'codex'],
    ]);
  });

  it('with idPrefix uses own accounts and ids that do not collide with real data', () => {
    const sim = new DemoSimulator({ seed: 1, idPrefix: 'demo:', sessions: 5 }, 1_000);
    const snap = sim.snapshot(1_000);
    expect(snap.accounts.map((a) => [a.id, a.short, a.name])).toEqual([
      ['demo:.claude', 'X', 'Demo X'],
      ['demo:.claude-conta2', 'Y', 'Demo Y'],
      ['demo:.codex', 'Z', 'Demo Codex'],
    ]);
    expect(snap.agents.every((a) => a.id.startsWith('demo:') && a.account.startsWith('demo:'))).toBe(true);
    expect(snap.rooms.every((r) => r.id.startsWith('demo:'))).toBe(true);
  });

  it('activity ids do not repeat across instances (restarting the demo)', () => {
    const ids = new Set<string>();
    for (const start of [1_000, 2_000]) {
      const sim = new DemoSimulator({ seed: 7, idPrefix: 'demo:', speed: 20 }, start);
      for (let t = start; t < start + 60_000; t += 250) for (const f of sim.tick(t).feed) {
        expect(ids.has(f.id)).toBe(false);
        ids.add(f.id);
      }
    }
    expect(ids.size).toBeGreaterThan(10);
  });

  it('opens with someone waiting on a background shell (with job and balloon), and the shell ends with ShellDone', () => {
    const start = 5_000;
    const sim = new DemoSimulator({ seed: 3 }, start);
    const waiting = sim.snapshot(start).agents.filter((a) => a.status === 'shell');
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    const a = waiting[0];
    expect(a.shells?.length).toBeGreaterThanOrEqual(1);
    expect(a.shells!.every((j) => j.background && j.kind === 'shell' && j.startedAt < start && j.label)).toBe(true);
    expect(a.activity).toMatchObject({ tool: 'ShellWait' });
    const done: string[] = [];
    for (let t = start; t < start + 200_000; t += 250) {
      for (const f of sim.tick(t).feed) if (f.activity.tool === 'ShellDone') done.push(f.agentId);
    }
    expect(done).toContain(a.id);
  });

  it('over time: background shells (shell status), long foreground commands, and failures', () => {
    for (const seed of [1, 2, 3]) {
      const sim = new DemoSimulator({ seed, speed: 10, sessions: 5 }, 0);
      const seen = { shell: 0, foreground: 0, ok: 0, failed: 0, noticeWait: 0 };
      for (let t = 0; t < 3_600_000 / 10; t += 250) {
        const r = sim.tick(t);
        for (const f of r.feed) {
          if (f.activity.tool !== 'ShellDone') continue;
          if (f.activity.error) seen.failed++;
          else seen.ok++;
        }
        seen.noticeWait += r.notices.filter((n) => n.text.includes('is waiting on the shell')).length;
        if (!r.changed) continue;
        for (const a of sim.snapshot(t).agents) {
          if (a.status === 'shell') {
            seen.shell++;
            expect(a.shells?.some((j) => j.background)).toBe(true);
          }
          if (a.status === 'working' && a.shells?.some((j) => !j.background)) seen.foreground++;
          if (a.status === 'idle') expect(a.shells).toBeUndefined();
        }
      }
      expect(seen.shell).toBeGreaterThan(0);
      expect(seen.foreground).toBeGreaterThan(0);
      expect(seen.ok).toBeGreaterThan(0);
      expect(seen.noticeWait).toBeGreaterThan(0);
      if (seed === 1) expect(seen.ok + seen.failed).toBeGreaterThan(3);
    }
  });
});

describe('DemoSimulator: Codex', () => {
  const MIN = 60_000;

  it('opens with a room having Claude Code and Codex together (and the rest of the sessions in Claude Code)', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const snap = new DemoSimulator({ seed }, 1_000).snapshot(1_000);
      const mains = snap.agents.filter((a) => a.kind === 'main');
      const codex = mains.filter((a) => a.provider === 'codex');
      expect(codex).toHaveLength(1);
      const room = codex[0].roomId;
      expect(mains.some((a) => a.roomId === room && a.provider === undefined)).toBe(true);
      // Codex agent: own account, gpt-*-codex model, neutral role, approval instead of permission mode, no cost.
      expect(codex[0]).toMatchObject({ account: '.codex', role: 'Main agent', permissionMode: 'on-request', canMessage: true });
      expect(codex[0].model).toMatch(/^gpt-5\.\d-codex/);
      expect(codex[0].stats.costUSD).toBeUndefined();
      // Never writes provider 'claude'.
      expect(mains.every((a) => a.provider === undefined || a.provider === 'codex')).toBe(true);
    }
  });

  it('deterministic: the same seed generates the same office', () => {
    const run = () => {
      const sim = new DemoSimulator({ seed: 9, speed: 6, sessions: 6 }, 0);
      for (let t = 0; t < 600_000; t += 250) sim.tick(t);
      return sim.snapshot(600_000);
    };
    expect(run()).toEqual(run());
  });

  it('over time, ~30% of new sessions are Codex; subagents inherit the tool', () => {
    const sim = new DemoSimulator({ seed: 11, speed: 10, sessions: 6 }, 0);
    const seen = new Map<string, boolean>();
    let codexSub = false;
    for (let t = 0; t < 3_600_000 / 5; t += 250) {
      if (!sim.tick(t).changed) continue;
      for (const a of sim.snapshot(t).agents) {
        if (a.kind === 'main') seen.set(a.id, a.provider === 'codex');
        else if (a.provider === 'codex') {
          codexSub = true;
          expect(['explorer', 'worker', 'reviewer']).toContain(a.role);
        }
      }
    }
    const codex = [...seen.values()].filter(Boolean).length;
    expect(codex).toBeGreaterThan(1);
    expect(codex).toBeLessThan(seen.size);
    expect(codexSub).toBe(true);
  });

  it('Codex usage: "Codex files", read in the last activity of its session (ages without a session)', () => {
    const sim = new DemoSimulator({ seed: 3 }, 0);
    const acc = () => sim.snapshot(t).accounts.find((a) => a.provider === 'codex')!;
    let t = 0;
    expect(acc()).toMatchObject({ id: '.codex', short: 'X', name: 'Codex', plan: 'Team', usageStatus: 'ok' });
    expect(acc().email).toBeUndefined();
    expect(acc().usage).toMatchObject({ source: 'codex' });
    // Read before opening: age appears.
    expect(acc().usage!.fetchedAt).toBeLessThan(0);
    const before = acc().usage!.fetchedAt;
    for (; t < 120_000; t += 250) sim.tick(t);
    // Some Codex session worked: read is new (and never "now" on its own).
    expect(acc().usage!.fetchedAt).toBeGreaterThan(before);
    expect(acc().usage!.fetchedAt).toBeLessThanOrEqual(t);
    expect(acc().usage!.fiveHour?.utilization).toBeGreaterThan(0);
    expect(acc().usage!.sevenDayOpus).toBeUndefined();
  });

  it('"no quota": no windows (never 0%), always with the option and occasionally without it', () => {
    const forced = new DemoSimulator({ seed: 3, codexNoQuota: true }, 0).snapshot(0).accounts.find((a) => a.provider === 'codex')!;
    expect(forced.usage).toEqual({ source: 'codex', noQuota: true, fetchedAt: forced.usage!.fetchedAt });
    const sim = new DemoSimulator({ seed: 4, speed: 4, sessions: 6 }, 0);
    let noQuota = 0;
    let numbers = 0;
    for (let t = 0; t < (90 * MIN) / 4; t += 1_000) {
      sim.tick(t);
      const u = sim.snapshot(t).accounts.find((a) => a.provider === 'codex')!.usage!;
      if (u.noQuota) {
        noQuota++;
        expect(u.fiveHour).toBeUndefined();
        expect(u.sevenDay).toBeUndefined();
      } else numbers++;
    }
    expect(noQuota).toBeGreaterThan(0);
    expect(numbers).toBeGreaterThan(noQuota);
  });

  it('message to Codex: enters the queue and only becomes an activity when the session becomes idle', () => {
    const start = 10_000;
    const sim = new DemoSimulator({ seed: 6 }, start);
    const codex = sim.snapshot(start).agents.find((a) => a.provider === 'codex')!;
    expect(sim.receiveMessage(codex.id, 'run lint too', start)).toBe(true);
    // Right away, nothing appears (it is queued).
    expect(sim.snapshot(start).agents.find((a) => a.id === codex.id)!.recent.some((r) => r.text === 'Message via Habblaud')).toBe(false);
    let t = start;
    let deliveredAt = 0;
    let statusAtDelivery = '';
    while (t < start + 400_000 && !deliveredAt) {
      t += 250;
      sim.tick(t);
      const a = sim.snapshot(t).agents.find((x) => x.id === codex.id)!;
      const m = a.recent.find((r) => r.text === 'Message via Habblaud');
      if (m) {
        deliveredAt = m.at;
        statusAtDelivery = a.recent[a.recent.indexOf(m) - 1]?.kind ?? '';
        expect(m.detail).toBe('run lint too');
      }
    }
    expect(deliveredAt).toBeGreaterThan(start);
    // Arrived after turn ended (Codex only uses the queue when session is idle).
    expect(['done', 'communicate']).toContain(statusAtDelivery);
  });
});
