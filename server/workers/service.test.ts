// Worker terminals: jobs restart the worker's terminal with the request, the answer comes from the conversation file.
// Fake terminals; real temporary files.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobBoardItem, PtyInfo } from '../../shared/types';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { IDLE_CLOSE_MS, LEAN_TOOLS, leanClaudeArgs, rulesHookSettings, taskOf, TRUST_WAIT_MS, WorkerService, type WorkerPtys, type WorkerTarget } from './service';
import { agyTurn, claudeTranscriptPath, claudeTurn } from './turns';

const T0 = 1_800_000_000_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const step = (o: Record<string, unknown>) => JSON.stringify(o);
const CONV = '26a99462-96c2-4742-9f6d-a9a3620e7176';

describe('turns', () => {
  it('agy: over when the last step is a planner response without tool calls; its content is the answer', () => {
    const user = step({ type: 'USER_INPUT', status: 'DONE', content: 'hi' });
    const tool = step({ type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: '100', output_tokens: '5', tool_calls: [{ name: 'run_command' }] });
    const out = step({ type: 'GENERIC', status: 'DONE', content: 'ok' });
    const fin = step({ type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: '200', output_tokens: '7', content: ' pong ' });
    expect(agyTurn([user, tool, out].join('\n'))).toEqual({ prompts: 1, ended: false, tokens: 105 });
    expect(agyTurn([user, tool, out, fin, ''].join('\n'))).toEqual({ prompts: 1, ended: true, answer: 'pong', tokens: 312 });
    expect(agyTurn('')).toEqual({ prompts: 0, ended: false, tokens: 0 });
  });

  it('claude: over at end_turn with no tool pending; usage counted once per message', () => {
    const user = step({ type: 'user', message: { role: 'user', content: 'do it' } });
    const a1 = step({ type: 'assistant', message: { id: 'm1', stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'tool_use', id: 't1' }] } });
    const res = step({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
    const u2 = { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 400 };
    const a2a = step({ type: 'assistant', message: { id: 'm2', stop_reason: null, usage: u2, content: [{ type: 'thinking', thinking: '…' }] } });
    const a2b = step({ type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', usage: u2, content: [{ type: 'text', text: 'Done.' }] } });
    expect(claudeTurn([user, a1].join('\n')).ended).toBe(false);
    // cached prompt tokens count too (input_tokens alone leaves them out)
    expect(claudeTurn([user, a1, res, a2a, a2b].join('\n'))).toEqual({
      prompts: 1,
      ended: true,
      answer: 'Done.',
      tokens: 1435,
      usage: { input_tokens: 30, output_tokens: 5, cache_read_tokens: 1000, cache_creation_tokens: 400 },
    });
  });
});

function fakePtys() {
  const open = new Map<string, PtyInfo & { args: string[]; env?: Record<string, string>; file: string }>();
  const typed: Array<[string, string]> = [];
  let pid = 100;
  const ptys: WorkerPtys = {
    openProgram: (p) => {
      const info = { id: `p${pid}`, pid: pid++, cwd: p.cwd, account: p.account, agentId: p.agentId, startedAt: T0, args: p.args, env: p.env, file: p.file };
      open.set(p.agentId, info);
      return info;
    },
    ofAgent: (id) => open.get(id),
    typeTo: (id, data) => {
      typed.push([id, data]);
      return open.has(id);
    },
    closeAgent: (id) => void open.delete(id),
  };
  return { ptys, open, typed };
}

function setup(workers = ['acc2', 'claude:.claude-w']) {
  const root = mkdtempSync(join(tmpdir(), 'habblaud-workers-'));
  dirs.push(root);
  const stateDir = join(root, 'acc2', '.gemini', 'antigravity-cli');
  mkdirSync(join(stateDir, 'brain', '0000aaaa-0000-0000-0000-000000000000'), { recursive: true });
  const configDir = join(root, '.claude-w');
  let clock = T0;
  const office = new Office({ names: new NameStore(null), version: 'test', startedAt: T0, accounts: () => [], sources: () => [], accountName: () => undefined, now: () => clock });
  office.addMain({ id: 'agy:acc2', provider: 'agy', account: 'agy:acc2', sessionId: 'agy-acc2', cwd: '/w/agy-hub', role: 'Worker', name: 'two (Agy)', startedAt: T0, status: 'idle' });
  const all: WorkerTarget[] = [
    { id: 'acc2', kind: 'agy', agentId: 'agy:acc2', account: 'agy:acc2', name: 'two (Agy)', acc: 'acc2', stateDir },
    { id: 'claude:.claude-w', kind: 'claude', agentId: 'claude-worker:.claude-w', account: '.claude-w', name: 'w (Claude worker)', configDir },
  ];
  let registered = workers;
  const f = fakePtys();
  const board: JobBoardItem[] = [];
  let changes = 0;
  const logFile = join(root, 'agy-ask.log.jsonl');
  const svc = new WorkerService({
    office,
    ptys: f.ptys,
    targets: () => all.filter((t) => registered.includes(t.id)),
    agyBin: '/bin/agy-as',
    claudeBin: '/bin/claude',
    rulesHook: '/hub/rules-hook',
    room: root,
    logFile,
    onChange: () => void changes++,
    board: (i) => void board.push(i),
    now: () => clock,
    sleep: async () => undefined,
    offices: { has: (w, o) => o === 'main' || (o === 'two' && w === 'acc2'), of: () => 'main' },
  });
  svc.sync();
  /** agy writes the conversation of the job it just opened. */
  const agyWrites = (lines: Array<Record<string, unknown>>, conv = CONV) => {
    const dir = join(stateDir, 'brain', conv, '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'transcript.jsonl'), lines.map(step).join('\n') + '\n');
  };
  return {
    root,
    svc,
    office,
    board,
    logFile,
    configDir,
    ...f,
    agyWrites,
    advance: (ms: number) => (clock += ms),
    register: (w: string[]) => (registered = w),
    changes: () => changes,
    log: () => readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const answer = (content: string) => [{ type: 'USER_INPUT', status: 'DONE', content: 'q' }, { type: 'PLANNER_RESPONSE', status: 'DONE', input_tokens: '50', output_tokens: '5', content }];

describe('WorkerService', () => {
  it('agy job: the terminal restarts with the request, the answer comes from the new conversation, cut to max', async () => {
    const t = setup();
    const r = await t.svc.ask({ worker: 'acc2', prompt: 'Say pong', mode: 'plan', effort: 'low', role: 'qa', by: 'boss', callerPid: 41, max: 200 });
    expect(r).toMatchObject({ ok: true, job: { status: 'working', role: 'qa', by: 'boss' } });
    expect(t.open.get('agy:acc2')).toMatchObject({ file: '/bin/agy-as', args: ['acc2', '-i', 'Say pong', '--mode', 'plan', '--effort', 'low'] });
    expect(t.open.get('agy:acc2')?.env).toMatchObject({ AGY_OFFICE: 'main', AGY_WORKER: 'acc2' });
    t.svc.tick();
    expect(t.svc.jobs()[0].status).toBe('working');
    t.agyWrites(answer('x'.repeat(500)));
    t.svc.tick();
    const job = t.svc.jobs()[0];
    expect(job).toMatchObject({ status: 'done', tokens: 55 });
    expect(job.answer!.length).toBeLessThanOrEqual(200);
    expect(t.svc.sessionList()[0]).toMatchObject({ worker: 'acc2' });
    expect(t.log().map((l) => [l.event, l.status, l.via, l.claude_pid ?? null])).toEqual([
      ['start', undefined, 'terminal', 41],
      ['end', 'SUCCESS', 'terminal', null],
    ]);
    expect(t.board.at(-1)).toMatchObject({ status: 'done', job: job.id, workerId: 'acc2', by: 'boss', role: 'qa' });
    // the terminal stays open after the job
    expect(t.open.has('agy:acc2')).toBe(true);
  });

  it('one job at a time; waitJob returns once it is over', async () => {
    const t = setup();
    const r = await t.svc.ask({ worker: 'acc2', prompt: 'one' });
    expect(await t.svc.ask({ worker: 'acc2', prompt: 'two' })).toMatchObject({ ok: false, status: 409, busy: 'job' });
    const id = (r as { job: { id: string } }).job.id;
    const waiting = t.svc.waitJob(id, 30);
    t.agyWrites(answer('pong'));
    t.svc.tick();
    expect(await waiting).toMatchObject({ status: 'done', answer: 'pong' });
    expect(await t.svc.ask({ worker: 'nope', prompt: 'x' })).toMatchObject({ ok: false, status: 400 });
  });

  it('a job waiting for the old terminal to close does not take an old conversation as its own', async () => {
    const t = setup();
    t.agyWrites(answer('an old answer'), '0000aaaa-0000-0000-0000-000000000000');
    await t.svc.ask({ worker: 'acc2', prompt: 'first' });
    t.agyWrites(answer('first answer'));
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'done', answer: 'first answer' });
    // The first job's terminal closes slowly; the office keeps ticking meanwhile.
    let closing = false;
    let inTick = false;
    const ofAgent = t.ptys.ofAgent;
    t.ptys.closeAgent = () => void (closing = true);
    t.ptys.ofAgent = (id) => {
      if (closing && !inTick) {
        inTick = true;
        t.svc.tick();
        inTick = false;
        closing = false;
        t.open.delete(id);
      }
      return ofAgent(id);
    };
    await t.svc.ask({ worker: 'acc2', prompt: 'second' });
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'working' });
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'working' });
    t.agyWrites(answer('second answer'), '3b094ff8-a5b3-44d7-82d5-ac4ec8b1b6cc');
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'done', answer: 'second answer' });
  });

  it('a job cancelled while the old terminal is closing never starts', async () => {
    const t = setup();
    await t.svc.ask({ worker: 'acc2', prompt: 'first' });
    t.agyWrites(answer('done'));
    t.svc.tick();
    const firstPty = t.open.get('agy:acc2')!.id;
    let closing = false;
    const ofAgent = t.ptys.ofAgent;
    t.ptys.closeAgent = () => void (closing = true);
    t.ptys.ofAgent = (id) => {
      if (closing) {
        closing = false;
        t.svc.cancel({ all: true });
        t.open.delete(id);
      }
      return ofAgent(id);
    };
    expect(await t.svc.ask({ worker: 'acc2', prompt: 'second' })).toMatchObject({ ok: true, job: { status: 'cancelled' } });
    expect(t.open.has('agy:acc2')).toBe(false);
    expect(firstPty).toBeTruthy();
    expect(t.log().filter((l) => l.event === 'start')).toHaveLength(1);
  });

  it('cancel one job or all; a timeout or a closed terminal fails the job', async () => {
    const t = setup();
    const a = await t.svc.ask({ worker: 'acc2', prompt: 'a' });
    expect(t.svc.cancel({ job: (a as { job: { id: string } }).job.id })).toBe(1);
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'cancelled' });
    await t.svc.ask({ worker: 'acc2', prompt: 'b' });
    await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'c' });
    expect(t.svc.cancel({ all: true })).toBe(2);
    await t.svc.ask({ worker: 'acc2', prompt: 'd' });
    t.open.delete('agy:acc2');
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'failed', error: 'the terminal closed before the answer' });
    await t.svc.ask({ worker: 'acc2', prompt: 'e' });
    t.advance(31 * 60_000);
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'failed' });
    expect(t.log().at(-1)).toMatchObject({ status: 'TIMEOUT' });
  });

  it('Claude worker: its own character; the job runs with a chosen session id and its transcript answers', async () => {
    const t = setup();
    expect(t.office.get('claude-worker:.claude-w')).toMatchObject({ kind: 'main', name: 'w (Claude worker)', status: 'idle' });
    const r = await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'Review x', mode: 'accept-edits', model: 'haiku', cwd: t.root });
    expect(r.ok).toBe(true);
    const p = t.open.get('claude-worker:.claude-w')!;
    expect(p.file).toBe('/bin/claude');
    expect(p.env).toMatchObject({ CLAUDE_CONFIG_DIR: t.configDir });
    const sid = p.args[1];
    expect(p.args).toEqual(['--session-id', sid, '--permission-mode', 'acceptEdits', '--model', 'haiku', '--settings', rulesHookSettings('/hub/rules-hook'), 'Review x']);
    expect(t.svc.ownsPid(p.pid)).toBe(true);
    expect(t.office.get('claude-worker:.claude-w')?.status).toBe('working');
    const file = claudeTranscriptPath(t.configDir, t.root, sid);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(
      file,
      [
        step({ type: 'user', message: { role: 'user', content: 'Review x' } }),
        step({ type: 'assistant', message: { id: 'm', stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 1 }, content: [{ type: 'text', text: 'LGTM' }] } }),
      ].join('\n'),
    );
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'done', answer: 'LGTM', tokens: 10 });
    expect(t.office.get('claude-worker:.claude-w')?.status).toBe('idle');
  });

  it('Claude worker in a folder its account does not trust: the job fails fast instead of waiting at the dialog', async () => {
    const t = setup();
    mkdirSync(t.configDir, { recursive: true });
    const trust = (dir: string) => writeFileSync(join(t.configDir, '.claude.json'), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    trust('/elsewhere');
    await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'Find x', cwd: t.root });
    t.advance(TRUST_WAIT_MS - 1000);
    t.svc.tick();
    expect(t.svc.jobs()[0].status).toBe('working');
    t.advance(2000);
    t.svc.tick();
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('does not trust the folder') });
    expect(t.typed).toContainEqual(['claude-worker:.claude-w', '\x1b']);
    // a trusted parent folder: the job keeps waiting
    trust(join(t.root, '..'));
    await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'Find y', cwd: t.root });
    t.advance(TRUST_WAIT_MS + 1000);
    t.svc.tick();
    expect(t.svc.jobs()[0].status).toBe('working');
  });

  it('office rules: a Claude job runs rules-hook for its office and worker; the board shows the task without the rules', async () => {
    const t = setup();
    const prompt = 'Office rules of "Main" (set by the user; they win over the task):\n- Never run: sudo.\n\nFind x';
    expect((await t.svc.ask({ worker: 'claude:.claude-w', prompt, cwd: t.root })).ok).toBe(true);
    const p = t.open.get('claude-worker:.claude-w')!;
    expect(p.env).toMatchObject({ AGY_OFFICE: 'main', AGY_WORKER: 'claude:.claude-w' });
    const hook = JSON.parse(p.args[p.args.indexOf('--settings') + 1]).hooks.PreToolUse[0];
    expect(hook).toMatchObject({ matcher: expect.stringContaining('Edit'), hooks: [{ type: 'command', command: '/hub/rules-hook' }] });
    expect(p.args.at(-1)).toBe(prompt);
    expect(t.svc.jobs()[0].prompt).toBe('Find x');
    expect(taskOf('plain task')).toBe('plain task');
    expect(JSON.parse(rulesHookSettings("/my dir/it's")).hooks.PreToolUse[0].hooks[0].command).toBe("'/my dir/it'\\''s'");
  });

  it('Claude worker, lean job (claude-ask): no MCP, skills or slash commands, few tools, the worker rule with the cap', async () => {
    const t = setup();
    expect((await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'Find x', max: 500, lean: true, cwd: t.root })).ok).toBe(true);
    const args = t.open.get('claude-worker:.claude-w')!.args;
    expect(args.slice(2, -3)).toEqual(leanClaudeArgs(500));
    expect(args.at(-1)).toBe('Find x');
    expect(args[args.indexOf('--tools') + 1]).toBe(LEAN_TOOLS);
    expect(args[args.indexOf('--append-system-prompt') + 1]).toContain('under 500 characters');
  });

  it('a worker that is no longer registered loses its job, terminal and (Claude) character', async () => {
    const t = setup();
    await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'x' });
    t.register(['acc2']);
    t.svc.sync();
    expect(t.svc.jobs()[0].status).toBe('cancelled');
    expect(t.open.has('claude-worker:.claude-w')).toBe(false);
    expect(t.office.get('claude-worker:.claude-w')?.status).toBe('offline');
    expect(t.svc.sessionList().map((s) => s.worker)).toEqual(['acc2']);
  });

  it('stopping a job that has just ended does not press Esc (it would quit an idle agy): the job is done', async () => {
    const t = setup();
    const r = await t.svc.ask({ worker: 'acc2', prompt: 'quick' });
    t.agyWrites(answer('already'));
    expect(t.svc.cancel({ job: (r as { job: { id: string } }).job.id })).toBe(1);
    expect(t.svc.jobs()[0]).toMatchObject({ status: 'done', answer: 'already' });
    expect(t.typed).toEqual([]);
  });

  it('an idle worker terminal closes after a while (not while a job runs or you drive)', async () => {
    const t = setup();
    await t.svc.ask({ worker: 'acc2', prompt: 'job' });
    t.advance(IDLE_CLOSE_MS + 1);
    t.svc.tick();
    expect(t.open.has('agy:acc2')).toBe(true);
    t.agyWrites(answer('ok'));
    t.svc.tick();
    t.advance(IDLE_CLOSE_MS - 1000);
    t.svc.tick();
    expect(t.open.has('agy:acc2')).toBe(true);
    t.advance(2000);
    t.svc.tick();
    expect(t.open.has('agy:acc2')).toBe(false);
  });

  it('offices: a job carries its office (given, else the first office of the worker); a worker of another office is refused', async () => {
    const t = setup();
    expect(await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'x', office: 'two' })).toMatchObject({ ok: false, status: 400 });
    expect(await t.svc.ask({ worker: 'acc2', prompt: 'x', office: 'two' })).toMatchObject({ ok: true, job: { office: 'two' } });
    expect(t.board.at(-1)).toMatchObject({ office: 'two' });
    expect(t.log().at(-1)).toMatchObject({ event: 'start', office: 'two' });
    expect(await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'y' })).toMatchObject({ ok: true, job: { office: 'main' } });
    expect(t.svc.cancel({ office: 'two' })).toBe(1);
    expect(t.svc.jobs().find((j) => j.office === 'main')?.status).toBe('working');
  });

  it('seats: a Claude worker has one character per office; the job shows on the seat of its office', async () => {
    const t = setup();
    // give the Claude worker a second seat (office "two")
    const svc = t.svc as unknown as { opts: { targets: () => WorkerTarget[] } };
    const targets = svc.opts.targets;
    svc.opts.targets = () =>
      targets().map((x) =>
        x.kind === 'claude'
          ? { ...x, seats: [{ office: 'main', agentId: x.agentId, name: x.name, room: t.root }, { office: 'two', agentId: `${x.agentId}@two`, name: `${x.name} (2)`, room: `${t.root}@two` }] }
          : x,
      );
    t.svc.sync();
    expect(t.office.get('claude-worker:.claude-w@two')).toMatchObject({ name: 'w (Claude worker) (2)', status: 'idle' });
    expect(t.svc.sessionList().find((x) => x.kind === 'claude')?.agentIds).toEqual({ main: 'claude-worker:.claude-w', two: 'claude-worker:.claude-w@two' });
    // the stub says "claude:.claude-w" is not in office two; let it be for this test
    (t.svc as unknown as { opts: { offices: unknown } }).opts.offices = { has: () => true, of: () => 'main' };
    await t.svc.ask({ worker: 'claude:.claude-w', prompt: 'x', office: 'two' });
    expect(t.office.get('claude-worker:.claude-w@two')?.status).toBe('working');
    expect(t.office.get('claude-worker:.claude-w')?.status).toBe('idle');
    expect(t.board.at(-1)).toMatchObject({ agentId: 'claude-worker:.claude-w@two', office: 'two' });
    expect(t.svc.statusOf('claude:.claude-w', 'two')?.busy).toBe(true);
    expect(t.svc.statusOf('claude:.claude-w', 'main')?.busy).toBe(false);
  });
});
