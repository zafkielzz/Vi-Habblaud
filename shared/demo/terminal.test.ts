import { describe, expect, it } from 'vitest';
import type { Activity, AgentInfo, TerminalEntry } from '../types';
import { describePrompt, describeTool, SPECIAL, type ActivityDescription } from '../activity';
import { DemoSimulator } from './simulator';
import { demoTerminalEntries } from './terminal';

const ROOT = '/Users/dev/projetos/loja-virtual';
const T0 = 1_000_000;

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'demo:x-1',
    kind: 'main',
    roomId: `demo:${ROOT}`,
    name: 'Marina',
    look: 'f',
    role: 'Main agent',
    title: 'Build the checkout page with an order summary',
    sessionId: 'demo:sess-1',
    account: 'demo:.claude',
    status: 'working',
    recent: [],
    tasks: [
      { id: '1', title: 'Create checkout page', status: 'completed' },
      { id: '2', title: 'Validate address form', status: 'in_progress' },
      { id: '3', title: 'Write cart tests', status: 'pending' },
    ],
    gitBranch: 'feat/checkout',
    startedAt: T0,
    lastEventAt: T0,
    statusSince: T0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...over,
  };
}

/** Activities as the simulator creates them (same description functions). */
function history(): Activity[] {
  let seq = 0;
  let at = T0;
  const act = (d: ActivityDescription & { tool?: string; error?: boolean }, sameTick = false): Activity => {
    if (!sameTick) at += 2_000;
    return { id: `demo:x-a${++seq}`, at, ...d };
  };
  const bg = { description: 'Run the test suite', command: 'npm test -- --runInBand' };
  return [
    act(describePrompt('Build the checkout page with an order summary')),
    act(SPECIAL.think()),
    act(describeTool('Read', { file_path: `${ROOT}/src/pages/Checkout.tsx` })),
    act(describeTool('Grep', { pattern: 'useCart' })),
    act(describeTool('Glob', { pattern: '**/*.ts' })),
    act(describeTool('Edit', { file_path: `${ROOT}/src/components/Cart.tsx` })),
    act(describeTool('Write', { file_path: `${ROOT}/src/api/orders.ts` })),
    act(describeTool('Bash', { command: 'npm test' })),
    act(describeTool('Bash', { command: 'git status' })),
    act(describeTool('Bash', { command: 'npm run build' })),
    act(describeTool('WebSearch', { query: 'react checkout form validation' })),
    act(describeTool('WebFetch', { url: 'https://developer.mozilla.org/pt-BR/docs/Web' })),
    act(describeTool('TodoWrite', { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] })),
    act(describeTool('Agent', { description: '3 parallel tracks', subagent_type: 'general-purpose' })),
    act({ kind: 'think', icon: '📥', text: "Gathering the team's results" }),
    act(SPECIAL.waiting('approve a permission')),
    act(describeTool('Bash', { ...bg, run_in_background: true })),
    act(SPECIAL.waitingShell('Run the test suite', 1, bg.command), true),
    act(SPECIAL.shellDone('Run the test suite', 'ok', 95_000, bg.command)),
    act(SPECIAL.shellDone('Production build', 'failed', 40_000, 'npm run build -- --mode production')),
    act(SPECIAL.turnDone(130_000)),
    act({ kind: 'compact', icon: '🧹', text: 'Tidying up memory (compacting)' }),
    act({ kind: 'error', icon: '⚠️', text: 'Bash error', detail: 'Exit code 1' }),
    act(describeTool('SendMessage', { to: 'Bruno', message: 'can you review?' })),
  ];
}

const byActivity = (entries: TerminalEntry[], h: Activity[]) => h.map((a) => entries.filter((e) => e.id.startsWith(`${a.id}:`)));

describe('demoTerminalEntries', () => {
  it('is deterministic and does not alter the input', () => {
    const h = history();
    const before = JSON.stringify(h);
    const a = demoTerminalEntries(agent(), h);
    const b = demoTerminalEntries(agent(), structuredClone(h));
    expect(b).toEqual(a);
    expect(JSON.stringify(h)).toBe(before);
  });

  it('each activity becomes entries with unique ids derived from it, and each tool has a result', () => {
    const h = history();
    const e = demoTerminalEntries(agent(), h);
    expect(new Set(e.map((x) => x.id)).size).toBe(e.length);
    const groups = byActivity(e, h);
    groups.forEach((g) => expect(g.length).toBeGreaterThan(0));
    expect(groups.flat()).toHaveLength(e.length);
    for (const t of e.filter((x) => x.kind === 'tool')) {
      const r = e.find((x) => x.kind === 'result' && x.toolUseId === t.id);
      expect(r && r.kind === 'result' && r.text.length).toBeTruthy();
    }
    // Chronological order.
    expect(e.map((x) => x.at)).toEqual([...e.map((x) => x.at)].sort((x, y) => x - y));
  });

  it('covers activity types with consistent entries', () => {
    const h = history();
    const groups = byActivity(demoTerminalEntries(agent(), h), h);
    const kinds = (i: number) => groups[i].map((x) => x.kind);
    const tool = (i: number) => groups[i].find((x) => x.kind === 'tool') as Extract<TerminalEntry, { kind: 'tool' }>;
    const result = (i: number) => groups[i].find((x) => x.kind === 'result') as Extract<TerminalEntry, { kind: 'result' }>;
    const system = (i: number) => groups[i].find((x) => x.kind === 'system') as Extract<TerminalEntry, { kind: 'system' }>;

    expect(groups[0]).toEqual([expect.objectContaining({ kind: 'user', text: 'Build the checkout page with an order summary' })]);
    expect(kinds(1)).toEqual(['thinking']);
    expect(tool(2)).toMatchObject({ tool: 'Read', title: 'Read(src/pages/Checkout.tsx)' });
    expect(result(2).text).toMatch(/^ +1\t/);
    expect(tool(3)).toMatchObject({ tool: 'Grep', title: 'Grep(useCart)' });
    expect(result(3).text).toMatch(/^src\/\S+:\d+: .*useCart/);
    expect(tool(4)).toMatchObject({ tool: 'Glob', title: 'Glob(**/*.ts)' });
    // Edit with diff.
    expect(tool(5)).toMatchObject({ tool: 'Edit', title: 'Edit(src/components/Cart.tsx)', inputKind: 'diff' });
    expect(tool(5).input).toMatch(/^- .+\n\+ .+$/);
    expect(tool(6)).toMatchObject({ tool: 'Write', title: 'Write(src/api/orders.ts)', inputKind: 'diff' });
    expect(tool(6).input!.split('\n').every((l) => l.startsWith('+ '))).toBe(true);
    // Bash with command and output.
    expect(tool(7)).toMatchObject({ tool: 'Bash', title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    expect(result(7).text).toMatch(/✓ \d+ tests passed/);
    expect(result(8).text).toContain('On branch feat/checkout');
    expect(result(9).text).toContain('built in');
    expect(tool(10)).toMatchObject({ tool: 'WebSearch', title: 'WebSearch(react checkout form validation)' });
    expect(tool(11)).toMatchObject({ tool: 'WebFetch', title: 'WebFetch(https://developer.mozilla.org/pt-BR/docs/Web)' });
    expect(tool(12)).toMatchObject({ tool: 'TodoWrite', title: 'TodoWrite(1/3 done)' });
    expect(tool(12).input).toBe('☒ Create checkout page\n◐ Validate address form\n☐ Write cart tests');
    expect(tool(13)).toMatchObject({ tool: 'Agent', title: 'Agent(general-purpose: 3 parallel tracks)' });
    expect(kinds(14)).toEqual(['thinking']);
    expect(system(15)).toMatchObject({ text: 'Waiting on you: approve a permission', level: 'warn' });
    // Background shell: launch, wait, and completion (ok and failure).
    expect(result(16).text).toMatch(/background/);
    expect(groups[17]).toEqual([expect.objectContaining({ kind: 'assistant' })]);
    expect(system(18)).toMatchObject({ text: 'Background task completed: npm test -- --runInBand (1min 35s)', level: 'info' });
    expect(system(19)).toMatchObject({ text: 'Background task failed: npm run build -- --mode production', level: 'warn' });
    // Turn completion: assistant summary and duration.
    expect(kinds(20)).toEqual(['assistant', 'system']);
    expect(system(20).text).toBe('Turn completed in 2min 10s');
    expect(system(21).text).toBe('Conversation compacted automatically');
    expect(system(22)).toMatchObject({ text: 'Bash error', level: 'error', detail: 'Exit code 1' });
    expect(tool(23)).toMatchObject({ tool: 'SendMessage' });
  });

  it('ids and content of old entries do not change when new activities arrive', () => {
    const h = history();
    const full = demoTerminalEntries(agent(), h);
    for (const n of [1, 5, 10, 16, 18, 21]) {
      const part = demoTerminalEntries(agent(), h.slice(0, n));
      expect(full.slice(0, part.length)).toEqual(part);
    }
    // Sliding window (history keeps only the latest activities): shared entries remain equal.
    const slid = demoTerminalEntries(agent(), h.slice(8));
    expect(slid).toEqual(full.slice(full.length - slid.length));
    expect(slid.length).toBeGreaterThan(10);
  });

  it('without activities, title opens the conversation; afterwards, prompts come from activities', () => {
    const empty = demoTerminalEntries(agent(), []);
    expect(empty).toEqual([expect.objectContaining({ kind: 'user', text: 'Build the checkout page with an order summary', at: T0 })]);
    expect(demoTerminalEntries(agent({ title: undefined }), [])).toEqual([]);
    const withPrompt = demoTerminalEntries(agent(), history().slice(0, 1));
    expect(withPrompt.map((x) => x.kind)).toEqual(['user']);
    expect(withPrompt[0].id).not.toBe(empty[0].id);
  });

  it('with simulator: main and subagent conversation, stable across ticks', () => {
    const sim = new DemoSimulator({ seed: 5, idPrefix: 'demo:', speed: 8, sessions: 5 }, 0);
    const lists = new Map<string, TerminalEntry[]>();
    let checked = 0;
    for (let t = 0; t < 300_000; t += 250) {
      sim.tick(t);
      if (t % 5_000) continue;
      for (const a of sim.snapshot(t).agents) {
        const entries = demoTerminalEntries(a, a.recent);
        expect(new Set(entries.map((x) => x.id)).size).toBe(entries.length);
        const prev = lists.get(a.id);
        if (prev) {
          // What already existed and remains in the window has the same content.
          const now = new Map(entries.map((x) => [x.id, x]));
          for (const old of prev) if (now.has(old.id)) expect(now.get(old.id)).toEqual(old);
          checked++;
        }
        lists.set(a.id, entries);
      }
    }
    expect(checked).toBeGreaterThan(20);
    const all = [...lists.values()].flat();
    expect(all.some((x) => x.kind === 'tool' && x.tool === 'Bash' && x.input)).toBe(true);
    expect(all.some((x) => x.kind === 'tool' && x.inputKind === 'diff')).toBe(true);
  });
});

describe('demoTerminalEntries: Codex agent', () => {
  it('shell commands (including read and search), apply_patch with patch, update_plan, web_search, and spawn_agent', () => {
    const h = history();
    const e = demoTerminalEntries(agent({ provider: 'codex', account: 'demo:.codex' }), h);
    expect(new Set(e.map((x) => x.id)).size).toBe(e.length);
    const groups = byActivity(e, h);
    groups.forEach((g) => expect(g.length).toBeGreaterThan(0));
    const tool = (i: number) => groups[i].find((x) => x.kind === 'tool') as Extract<TerminalEntry, { kind: 'tool' }>;
    const result = (i: number) => groups[i].find((x) => x.kind === 'result') as Extract<TerminalEntry, { kind: 'result' }>;
    expect(tool(2)).toMatchObject({ tool: 'Shell', inputKind: 'command' });
    expect(tool(2).title).toMatch(/^Shell\(sed -n '1,\d+p' src\/pages\/Checkout\.tsx\)$/);
    expect(result(2).text).toMatch(/^import /);
    expect(tool(3)).toMatchObject({ tool: 'Shell', title: 'Shell(rg -n "useCart")' });
    expect(tool(4)).toMatchObject({ tool: 'Shell', title: "Shell(rg --files -g '**/*.ts')" });
    // Edit: entire patch (Update File) and apply_patch response; new file: Add File.
    expect(tool(5)).toMatchObject({ tool: 'apply_patch', title: 'apply_patch(src/components/Cart.tsx)', inputKind: 'diff' });
    expect(tool(5).input).toMatch(/^\*\*\* Begin Patch\n\*\*\* Update File: src\/components\/Cart\.tsx\n@@\n-.+\n\+.+\n\*\*\* End Patch$/);
    expect(result(5).text).toBe('Success. Updated the following files:\nM src/components/Cart.tsx');
    expect(tool(6).input).toMatch(/^\*\*\* Begin Patch\n\*\*\* Add File: src\/api\/orders\.ts\n\+/);
    expect(result(6).text).toBe('Success. Updated the following files:\nA src/api/orders.ts');
    expect(tool(7)).toMatchObject({ tool: 'Shell', title: 'Shell(npm test)', input: 'npm test' });
    expect(result(7).text).toMatch(/✓ \d+ tests passed/);
    expect(tool(10)).toMatchObject({ tool: 'web_search', title: 'web_search(react checkout form validation)' });
    expect(tool(11).title).toMatch(/^Shell\(curl -sL https:\/\/developer\.mozilla\.org/);
    expect(tool(12)).toMatchObject({ tool: 'update_plan', title: 'update_plan(1/3 done)' });
    expect(tool(13)).toMatchObject({ tool: 'spawn_agent', title: 'spawn_agent(worker: 3 parallel tracks)' });
    expect(result(16).text).toMatch(/background/);
    // Nothing Claude Code style.
    expect(e.some((x) => x.kind === 'tool' && ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'Bash', 'TodoWrite', 'Agent', 'WebSearch', 'WebFetch'].includes(x.tool))).toBe(false);
  });

  it('with simulator: Codex agents get Codex conversations', () => {
    const sim = new DemoSimulator({ seed: 2, speed: 8, sessions: 5 }, 0);
    for (let t = 0; t < 120_000; t += 250) sim.tick(t);
    const codex = sim.snapshot(120_000).agents.filter((a) => a.provider === 'codex' && a.recent.length);
    expect(codex.length).toBeGreaterThan(0);
    const entries = codex.flatMap((a) => demoTerminalEntries(a, a.recent));
    expect(entries.some((x) => x.kind === 'tool' && (x.tool === 'Shell' || x.tool === 'apply_patch'))).toBe(true);
    expect(entries.some((x) => x.kind === 'tool' && x.tool === 'Bash')).toBe(false);
  });
});
