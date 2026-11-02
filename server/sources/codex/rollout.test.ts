// Codex rollout interpretation (synthetic lines in paginated and legacy formats).
import { describe, expect, it } from 'vitest';
import { R, SOURCES, threadId } from '../../test/codex-fixtures';
import {
  commandText,
  createCodexState,
  describeCodexTool,
  fileChanges,
  parseRolloutLine,
  parseSessionMeta,
  patchFiles,
  pathFromUri,
  usageFromRateLimits,
  type CodexLineResult,
  type CodexState,
} from './rollout';

const T = threadId(1);
const ctx = { idPrefix: 'acc:t', now: 0 };

function feed(lines: string[], state: CodexState = createCodexState()): { state: CodexState; results: CodexLineResult[] } {
  const results = lines.map((l) => parseRolloutLine(state, l, ctx));
  return { state, results };
}

const texts = (results: CodexLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.text));
const ids = (results: CodexLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.id));

describe('Codex rollout: paginated', () => {
  it('conversation comes from item_completed; injected context (response_item message) is excluded', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const { state, results } = feed([
      R.meta(T, { at }),
      R.message('developer', '<permissions instructions> system secret'),
      R.message('user', '<environment_context>cwd</environment_context>'),
      R.taskStarted('turn1', at + 1),
      R.user(T, 'turn1', 'u1', 'Fix the broken store test', at + 2),
      R.reasoning(T, 'turn1', 'r1', ['Reading the tests'], at + 3),
      R.reasoning(T, 'turn1', 'r2', ['Still thinking'], at + 4),
      R.agent(T, 'turn1', 'a1', 'Fixed the test.', at + 5),
      R.taskComplete('turn1', at + 6, 6_000),
    ]);
    expect(texts(results)).toEqual(['Received “Fix the broken store test”', 'Thinking…', 'Writing the reply', 'Done in 6s']);
    expect(ids(results)).toEqual(['acc:t#u1', 'acc:t#r1', 'acc:t#a1', 'acc:t#turn1:done']);
    expect(results.find((r) => r.activities[0]?.activity.kind === 'prompt')?.activities[0].activity.kind).toBe('prompt');
    expect(state.title).toBe('Fix the broken store test');
    expect(state.mode).toBe('paginated');
    expect(state.gitBranch).toBe('main');
    expect(state.turnOpen).toBe(false);
    const signals = results.flatMap((r) => r.signals.map((s) => s.type));
    expect(signals).toContain('turnStart');
    expect(signals).toContain('turnEnd');
  });

  it('command: same Bash activities, command as list or text, error and decline', () => {
    const { results, state } = feed([
      R.command(T, 't', 'call_1', 'npm test', { output: 'ok' }),
      R.command(T, 't', 'call_2', 'git push origin main', { exit: 1, output: 'rejected\n' }),
      R.command(T, 't', 'call_3', 'rm -rf build', { status: 'declined' }),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text, a.tool])).toEqual([
      ['acc:t#call_1', 'Running tests', 'Bash'],
      ['acc:t#call_2', 'Pushing commits (git push)', 'Bash'],
      ['acc:t#call_2:e', 'Error in Bash', 'Bash'],
      ['acc:t#call_3', 'Organizing files', 'Bash'],
      ['acc:t#call_3:r', 'You denied: Bash', undefined],
    ]);
    expect(acts[0].detail).toBe('npm test');
    expect(state.stats.toolCalls).toBe(3);
    expect(commandText(['/bin/bash', '-c', 'ls -la'])).toBe('ls -la');
    expect(commandText(['git', 'commit', '-m', 'a message'])).toBe("git commit -m 'a message'");
    expect(commandText('  echo hi ')).toBe('echo hi');
  });

  it('in-progress activity (function_call without output) and completed item do not duplicate (same call_id)', () => {
    const { results: all, state } = feed([
      R.meta(T),
      R.functionCall('call_9', 'exec_command', { cmd: 'npm run build', yield_time_ms: 10_000 }),
      R.customToolCall('call_x', 'exec', 'await tools.exec_command({cmd: "ls"})'),
    ]);
    const results = all.slice(1);
    expect(results[0].activities[0].activity).toMatchObject({ id: 'acc:t#call_9', text: 'Building the project', tool: 'Bash' });
    expect(results[1].activities[0].activity).toMatchObject({ id: 'acc:t#call_x', text: 'Running code' });
    expect([...state.pending.keys()]).toEqual(['call_9', 'call_x']);
    const done = parseRolloutLine(state, R.command(T, 't', 'call_9', 'npm run build'), ctx);
    expect(done.activities[0].activity.id).toBe('acc:t#call_9');
    expect(state.pending.has('call_9')).toBe(false);
    // In paginated, only the completed item counts as a tool.
    expect(state.stats.toolCalls).toBe(1);
  });

  it('file changes (rollout map or list), apply_patch, MCP, and plan', () => {
    const { results, state } = feed([
      R.fileChange(T, 't', 'call_p', {
        '/projetos/loja/src/app.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null },
        '/projetos/loja/src/novo.ts': { type: 'add', content: 'export {}\n' },
      }),
      R.mcp(T, 't', 'call_m', 'github', 'create_pull_request', { owner: 'o', repo: 'r', title: 'x' }, { result: '{"number": 7, "html_url": "https://github.com/o/r/pull/7"}' }),
      R.functionCall('call_plan', 'update_plan', { plan: [{ step: 'Read the code', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] }),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text])).toEqual([
      ['acc:t#call_p', 'Editing app.ts'],
      ['acc:t#call_p:1', 'Writing novo.ts'],
      ['acc:t#call_m', 'GitHub: create pull request'],
      ['acc:t#call_plan', 'Updating the plan'],
    ]);
    expect(acts[2].tool).toBe('mcp__github__create_pull_request');
    expect(state.tasks).toEqual([
      { id: '1', title: 'Read the code', status: 'completed' },
      { id: '2', title: 'Fix', status: 'in_progress' },
    ]);
    expect(results[1].signals.find((s) => s.type === 'github')).toMatchObject({ event: { kind: 'pr_opened', number: 7, repo: 'o/r' }, key: 'call_m' });
    expect(fileChanges([{ path: '/x/a.ts', kind: 'add', diff: 'hi' }])).toEqual([{ path: '/x/a.ts', kind: 'add', text: 'hi' }]);
    expect(patchFiles('*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch')).toEqual([
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ]);
    expect(describeCodexTool('apply_patch', { command: '*** Begin Patch\n*** Add File: docs/x.md\n+hi\n*** End Patch' })).toMatchObject({ tool: 'Write', desc: { text: 'Writing x.md' } });
    expect(describeCodexTool('Bash', { command: 'pytest -q' }).desc.text).toBe('Running tests');
    expect(describeCodexTool('create_issue', {}, 'mcp__github__').tool).toBe('mcp__github__create_issue');
  });

  it('app code mode: message sent to you (user_messaging) is reply, without duplicating recorded delivery', () => {
    const { results } = feed([
      R.meta(T),
      R.customToolCall('call_js', 'exec', 'await tools.user_messaging.send_message({text: "Found the bug"})'),
      R.delivered('call_msg', 'Found the checkout bug'),
      R.mcp(T, 't', 'call_msg', 'codex_apps', 'user_messaging_send_message', { text: 'Found the checkout bug' }, { result: 'ok' }),
      R.delivered('call_cut', 'Truncated text', Date.now(), false),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text, a.detail])).toEqual([
      ['acc:t#call_js', 'Running code', undefined],
      ['acc:t#call_msg', 'Writing the reply', 'Found the checkout bug'],
      // The completed item has the same id: the office does not duplicate.
      ['acc:t#call_msg', 'Writing the reply', 'Found the checkout bug'],
      ['acc:t#call_cut', 'Writing the reply', 'Truncated text'],
    ]);
  });

  it('plan usage: only default quota (other limit_id is excluded)', () => {
    const rl = { ...R.rateLimits({}), limit_id: 'codex_outro_modelo' };
    expect(usageFromRateLimits(rl, 1)).toBeUndefined();
    expect(usageFromRateLimits({ ...rl, limit_id: null }, 1)).toMatchObject({ fiveHour: { utilization: 12.5 } });
  });

  it('GitHub: successful push becomes an event; failed push does not', () => {
    const ok = 'To github.com:o/r.git\n   abc1234..def5678  main -> main\n';
    const rejected = 'To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n';
    const { results } = feed([R.command(T, 't', 'c1', 'git push', { output: ok }), R.command(T, 't', 'c2', 'git push', { exit: 1, output: rejected })]);
    expect(results[0].signals).toContainEqual({ type: 'github', event: { kind: 'push', branch: 'main' }, key: 'c1' });
    expect(results[1].signals.some((s) => s.type === 'github')).toBe(false);
  });

  it('tokens: cumulative total, without re-adding cache', () => {
    const { state } = feed([R.tokens({ input: 1_000, cached: 800, output: 50 }), R.tokens({ input: 3_000, cached: 2_500, output: 120, reasoning: 60 })]);
    expect(state.stats.tokensIn).toBe(3_000);
    expect(state.stats.tokensOut).toBe(120);
  });

  it('plan usage: window by duration, line age, and no quota', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    // Swapped positions: duration takes precedence (10080 = week).
    const swapped = usageFromRateLimits(R.rateLimits({ primary: { used: 70, minutes: 10080, resetsAt: 1_900_000_000 }, secondary: { used: 5.5, minutes: 300 } }), at);
    expect(swapped).toEqual({ source: 'codex', fetchedAt: at, sevenDay: { utilization: 70, resetsAt: 1_900_000_000_000 }, fiveHour: { utilization: 5.5, resetsAt: 2_000_000_000_000 } });
    const none = usageFromRateLimits(R.rateLimits({ primary: null, secondary: null, reached: 'workspace_owner_credits_depleted' }), at);
    expect(none).toEqual({ source: 'codex', fetchedAt: at, noQuota: true });
    expect(usageFromRateLimits(R.rateLimits({ primary: null, secondary: null }), at)).toBeUndefined();
    const { state, results } = feed([R.tokens({ input: 1, output: 1, at, rateLimits: { plan: 'pro' } })]);
    expect(state.planType).toBe('pro');
    expect(results[0].signals).toContainEqual({ type: 'usage', usage: expect.objectContaining({ fetchedAt: at, fiveHour: { utilization: 12.5, resetsAt: 2_000_000_000_000 } }), plan: 'pro' });
  });

  it('interrupted turn and stable ids on re-reading (even without its own id)', () => {
    // Without session_meta in window, format is not yet known: legacy reply is used.
    const lines = [R.taskStarted('t9'), R.turnAborted('t9'), R.legacyAgent('x')];
    const a = feed(lines);
    const b = feed(lines);
    expect(texts(a.results)).toEqual(['Interrupted by you', 'Writing the reply']);
    expect(ids(a.results)).toEqual(ids(b.results));
    expect(a.state.turnOpen).toBe(false);
  });
});

describe('Codex rollout: legacy', () => {
  it('the basics: prompt, reasoning, reply, and completed command (function_call + output)', () => {
    const { results, state } = feed([
      R.meta(T, { history: null }),
      R.legacyUser('List files'),
      R.legacyReasoning('thinking'),
      R.functionCall('c1', 'shell', { command: ['bash', '-lc', 'ls -la'] }),
      R.functionOutput('c1', JSON.stringify({ output: 'error', metadata: { exit_code: 2 } })),
      R.legacyAgent('Done, listed.'),
      // In legacy, UserMessage item_completed does not exist; if present, does not duplicate conversation.
    ]);
    expect(state.mode).toBe('legacy');
    expect(texts(results)).toEqual(['Received “List files”', 'Thinking…', 'Exploring folders', 'Error in Bash', 'Writing the reply']);
    expect(state.stats.toolCalls).toBe(1);
    expect(state.title).toBe('List files');
  });

  it('legacy events are ignored in a paginated rollout', () => {
    const { results } = feed([R.meta(T), R.legacyUser('duplicate'), R.legacyAgent('duplicate')]);
    expect(texts(results)).toEqual([]);
  });
});

describe('session_meta', () => {
  const meta = (source: unknown, extra: Record<string, unknown> = {}) =>
    parseSessionMeta({ id: T, session_id: T, cwd: '/p', source, history_mode: 'paginated', ...extra });

  it('subagent (thread_spawn), internal, and common sources', () => {
    const parent = threadId(2);
    expect(meta(SOURCES.sub(parent))).toMatchObject({ parentThreadId: parent, agentRole: 'explorer', agentNickname: 'Kepler', internal: false });
    // The key has appeared as subAgent (camelCase) in documentation: both are accepted.
    expect(meta({ subAgent: { threadSpawn: { parent_thread_id: parent } } }).parentThreadId).toBe(parent);
    expect(meta(SOURCES.guardian()).internal).toBe(true);
    expect(meta(SOURCES.internal()).internal).toBe(true);
    expect(meta(SOURCES.review()).internal).toBe(true);
    expect(meta('cli', { thread_source: 'guardian_review' }).internal).toBe(true);
    expect(meta('vscode')).toMatchObject({ internal: false, cwd: '/p', historyMode: 'paginated' });
    expect(meta('vscode').parentThreadId).toBeUndefined();
    // Without thread_spawn, but root differs from own id: parent is root.
    expect(meta('exec', { session_id: parent }).parentThreadId).toBe(parent);
    expect(parseSessionMeta({ id: T }).historyMode).toBe('legacy');
  });
});

describe('pathFromUri', () => {
  it('POSIX path, with percent-encoding', () => {
    expect(pathFromUri('file:///repo/a.png')).toBe('/repo/a.png');
    expect(pathFromUri('file:///home/user/my%20file.png')).toBe('/home/user/my file.png');
    expect(pathFromUri('file:///tmp/caf%C3%A9.png')).toBe('/tmp/café.png');
  });

  it('Windows drive (URI letter decides, not OS), with percent-encoding', () => {
    expect(pathFromUri('file:///C:/repo/a.png')).toBe('C:\\repo\\a.png');
    expect(pathFromUri('file:///C:/repo/my%20file.png')).toBe('C:\\repo\\my file.png');
  });

  it('UNC preserves server, with percent-encoding', () => {
    expect(pathFromUri('file://servidor/share/a.png')).toBe('\\\\servidor\\share\\a.png');
    expect(pathFromUri('file://servidor/share/my%20file.png')).toBe('\\\\servidor\\share\\my file.png');
  });

  it('non-file:// and invalid URIs remain unchanged', () => {
    expect(pathFromUri('/repo/a.png')).toBe('/repo/a.png');
    expect(pathFromUri('C:\\repo\\a.png')).toBe('C:\\repo\\a.png');
    expect(pathFromUri('FILE:///C:/repo/a.png')).toBe('FILE:///C:/repo/a.png');
    expect(pathFromUri(undefined)).toBeUndefined();
    expect(pathFromUri('')).toBeUndefined();
    expect(pathFromUri('   ')).toBeUndefined();
    // Invalid %: decoding fails and leaves remainder after "file://". %2F is decoded into slash.
    expect(pathFromUri('file:///tmp/%ZZ')).toBe('/tmp/%ZZ');
    expect(pathFromUri('file://%')).toBe('%');
    expect(pathFromUri('file:///home/user/a%2Fb.png')).toBe('/home/user/a/b.png');
  });
});
