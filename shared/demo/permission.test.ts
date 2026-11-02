// Fictional demo permission requests: appear while waiting, answered through the office (approve, deny,
// answer question, return to terminal) and disappear when wait ends on its own.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../hash';
import { DEMO_CODEX_PERMISSION_MS, demoCodexPermission, demoPermission } from './permission';
import { DemoSimulator } from './simulator';

describe('demoPermission', () => {
  it('builds complete requests (title, summary, arguments) with expiration', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed < 60; seed++) {
      const p = demoPermission(`p${seed}`, { files: ['src/app.ts'], commands: ['npm test'] }, mulberry32(seed), 1_000);
      kinds.add(p.tool);
      expect(p).toMatchObject({ id: `p${seed}`, createdAt: 1_000 });
      expect(p.expiresAt).toBeGreaterThan(1_000);
      expect(p.title).toMatch(/^(Bash|Edit|WebFetch|AskUserQuestion)\(/);
      expect(p.input).toBeTruthy();
      expect(p.text).toBeTruthy();
      if (p.tool === 'Bash') expect(p.suggestions).toEqual([{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }]);
    }
    expect(kinds).toEqual(new Set(['Bash', 'Edit', 'WebFetch', 'AskUserQuestion']));
  });

  it('question (AskUserQuestion): one single choice and one multiple, with positions to answer', () => {
    const p = demoPermission('q', { files: [], commands: [] }, mulberry32(3), 1_000, 'question');
    expect(p).toMatchObject({ tool: 'AskUserQuestion', icon: '❓', inputKind: 'text' });
    expect(p.suggestions).toBeUndefined();
    const qs = p.questions!;
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.index)).toEqual([0, 1]);
    expect(qs[0]!.multiSelect).toBeUndefined();
    expect(qs[1]!.multiSelect).toBe(true);
    for (const q of qs) {
      expect(q.header).toBeTruthy();
      expect(q.options.map((o) => o.index)).toEqual(q.options.map((_, i) => i));
      expect(p.input).toContain(q.question);
    }
  });
});

describe('DemoSimulator: permission requests', () => {
  const start = 10_000;

  it('forcePermission: agent waits with request; approving resumes work and logs activity', () => {
    const sim = new DemoSimulator({ seed: 4, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'permission')!;
    let a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'approve a permission' });
    const p = a.permission!;
    expect(p.id.startsWith('demo:perm-')).toBe(true);
    expect(sim.decidePermission('other', { behavior: 'allow' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(true);
    a = sim.snapshot(start + 1).agents.find((x) => x.id === id)!;
    expect(a.status).toBe('working');
    expect(a.permission).toBeUndefined();
    expect(a.recent.map((r) => r.text)).toContain('Approved in Habblaud (always allow)');
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 2)).toBe(false);
  });

  it('denying resumes with denial activity; terminal only removes request (waiting continues briefly)', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const a1 = sim.forcePermission(start, 'permission')!;
    const p1 = sim.snapshot(start).agents.find((x) => x.id === a1)!.permission!;
    sim.decidePermission(p1.id, { behavior: 'deny', message: 'not now' }, start + 1);
    const after = sim.snapshot(start + 1).agents.find((x) => x.id === a1)!;
    expect(after.status).toBe('working');
    expect(after.recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Denied in Habblaud' });

    const sim2 = new DemoSimulator({ seed: 6 }, start);
    const a2 = sim2.forcePermission(start, 'permission')!;
    const p2 = sim2.snapshot(start).agents.find((x) => x.id === a2)!.permission!;
    expect(sim2.decidePermission(p2.id, { behavior: 'terminal' }, start + 1)).toBe(true);
    const still = sim2.snapshot(start + 1).agents.find((x) => x.id === a2)!;
    expect(still.status).toBe('waiting');
    expect(still.permission).toBeUndefined();
    let t = start + 1;
    while (t < start + 20_000 && sim2.snapshot(t).agents.find((x) => x.id === a2)?.status === 'waiting') sim2.tick((t += 250));
    expect(sim2.snapshot(t).agents.find((x) => x.id === a2)?.status).toBe('working');
  });

  it('question: answering resumes with summary of choices; approving or incomplete answers are invalid', () => {
    const sim = new DemoSimulator({ seed: 7, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'question')!;
    const a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'answer a question' });
    const p = a.permission!;
    expect(p.tool).toBe('AskUserQuestion');
    const [single, multi] = p.questions!;
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 1)).toBe(false);
    // Missing second question; single choice with two options.
    expect(sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [0] }] }, start + 1)).toBe(false);
    expect(
      sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [0, 1] }, { question: multi!.index, options: [0] }] }, start + 1),
    ).toBe(false);
    expect(
      sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [1] }, { question: multi!.index, options: [2, 0], other: 'lint also' }] }, start + 1),
    ).toBe(true);
    const after = sim.snapshot(start + 1).agents.find((x) => x.id === id)!;
    expect(after.status).toBe('working');
    expect(after.permission).toBeUndefined();
    const act = after.recent.at(-1)!;
    expect(act).toMatchObject({ icon: '💬', text: 'Answered in Habblaud' });
    expect(act.detail).toBe(`${single!.header}: ${single!.options[1]!.label} · ${multi!.header}: ${multi!.options[0]!.label}, ${multi!.options[2]!.label}, “lint also”`);
  });

  it('question: deny and "answer in terminal" are also valid', () => {
    const sim = new DemoSimulator({ seed: 8 }, start);
    const id = sim.forcePermission(start, 'question')!;
    const p = sim.snapshot(start).agents.find((x) => x.id === id)!.permission!;
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'you decide' }, start + 1)).toBe(true);
    expect(sim.snapshot(start + 1).agents.find((x) => x.id === id)!.recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Denied in Habblaud' });
  });

  it('over time, waits for permission bring requests and they disappear when wait ends', () => {
    const sim = new DemoSimulator({ seed: 2, speed: 10, sessions: 5 }, 0);
    let withPermission = 0;
    for (let t = 0; t < 600_000; t += 250) {
      sim.tick(t);
      for (const a of sim.snapshot(t).agents) {
        if (a.permission) {
          withPermission++;
          expect(a.status).toBe('waiting');
        }
        if (a.status !== 'waiting') expect(a.permission).toBeUndefined();
      }
    }
    expect(withPermission).toBeGreaterThan(0);
  });
});

describe('Codex requests (demo)', () => {
  const start = 10_000;

  it('demoCodexPermission: command, apply_patch or network; no suggestions or questions; timeout of seconds', () => {
    const tools = new Set<string>();
    for (let seed = 1; seed < 80; seed++) {
      const p = demoCodexPermission(`c${seed}`, { files: ['src/app.ts'], commands: ['npm test'] }, mulberry32(seed), 1_000);
      tools.add(p.text.startsWith('Network access') ? 'network' : p.tool);
      expect(p).toMatchObject({ provider: 'codex', createdAt: 1_000, expiresAt: 1_000 + DEMO_CODEX_PERMISSION_MS });
      expect(p.suggestions).toBeUndefined();
      expect(p.questions).toBeUndefined();
      expect(p.input).toBeTruthy();
      if (p.tool === 'apply_patch') expect(p.input).toMatch(/^\*\*\* Begin Patch\n\*\*\* Update File: src\/app\.ts\n/);
    }
    expect(tools).toEqual(new Set(['Bash', 'apply_patch', 'network']));
  });

  it('forcePermission on Codex: waits to "approve a command"; deny requires reason; no always allow or interrupt', () => {
    const sim = new DemoSimulator({ seed: 4, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'question', 'codex')!;
    const a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ provider: 'codex', status: 'waiting', waitingFor: 'approve a command' });
    const p = a.permission!;
    expect(p.provider).toBe('codex');
    expect(p.tool).not.toBe('AskUserQuestion');
    expect(sim.decidePermission(p.id, { behavior: 'deny' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: '   ' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'no', interrupt: true }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'answer', answers: [] }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'use pnpm' }, start + 1)).toBe(true);
    expect(sim.snapshot(start + 1).agents.find((x) => x.id === id)!.recent.at(-1)).toMatchObject({ text: 'Denied in Habblaud' });
  });

  it('Codex timeout expires: request leaves office and agent keeps waiting in terminal', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const id = sim.forcePermission(start, 'permission', 'codex')!;
    sim.tick(start + DEMO_CODEX_PERMISSION_MS - 1_000);
    expect(sim.snapshot(start + DEMO_CODEX_PERMISSION_MS - 1_000).agents.find((x) => x.id === id)!.permission).toBeDefined();
    sim.tick(start + DEMO_CODEX_PERMISSION_MS);
    const after = sim.snapshot(start + DEMO_CODEX_PERMISSION_MS).agents.find((x) => x.id === id)!;
    expect(after.permission).toBeUndefined();
    expect(after.status).toBe('waiting');
  });

  it('forcePermission without tool keeps choosing a Claude Code agent', () => {
    for (const seed of [4, 5, 6, 7, 8]) {
      const sim = new DemoSimulator({ seed }, start);
      const id = sim.forcePermission(start)!;
      expect(sim.snapshot(start).agents.find((x) => x.id === id)!.provider).toBeUndefined();
    }
  });
});
