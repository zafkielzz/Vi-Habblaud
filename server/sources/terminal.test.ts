import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../shared/types';
import { L } from '../test/fixtures';
import { createTerminalParser, DETAIL_MAX, INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX } from './terminal';

const T0 = Date.parse('2026-10-06T10:00:00Z');
// Fake token assembled in parts (no literal secret in the repository).
const TOKEN = ['sk', 'ant', 'api03', 'testeFALSO0123456789abcdefXYZ'].join('-');

function run(lines: string[]): TerminalEntry[] {
  const p = createTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

function only<K extends TerminalEntry['kind']>(entries: TerminalEntry[], kind: K): Array<Extract<TerminalEntry, { kind: K }>> {
  return entries.filter((e): e is Extract<TerminalEntry, { kind: K }> => e.kind === kind);
}

/** Attachment line `queued_command` (prompt typed while agent busy or notification delivered mid-turn). */
function queued(prompt: unknown, extra: Record<string, unknown> = {}, at = T0): string {
  return JSON.stringify({
    type: 'attachment',
    uuid: `att-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date(at).toISOString(),
    sessionId: 'sess-teste',
    cwd: '/projetos/demo',
    attachment: { type: 'queued_command', prompt, ...extra },
  });
}

function userBlocks(blocks: Array<Record<string, unknown>>, at = T0): string {
  return JSON.stringify({ type: 'user', uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: new Date(at).toISOString(), cwd: '/projetos/demo', message: { role: 'user', content: blocks } });
}

describe('terminal — user prompts', () => {
  it('prompt becomes user; meta and system reminders disappear; at comes from timestamp', () => {
    const e = run([
      L.meta('Caveat: local messages'),
      L.prompt('<system-reminder>internal context</system-reminder>\nFix the cart bug\n\ncalmly', { at: T0 }),
      L.prompt('<system-reminder>only this</system-reminder>'),
    ]);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: 'user', at: T0, text: 'Fix the cart bug\n\ncalmly' });
  });

  it('images become "[image]" (without repeating when text already has "[Image #1]")', () => {
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const e = run([
      userBlocks([{ type: 'text', text: 'look at this' }, img, img]),
      userBlocks([{ type: 'text', text: '[Image #1] want it like this' }, img]),
      userBlocks([img]),
    ]);
    expect(only(e, 'user').map((x) => x.text)).toEqual(['look at this\n[image] [image]', '[Image #1] want it like this', '[image]']);
  });

  it('slash commands become "/x args" and local output becomes system (including in system local_command lines)', () => {
    const e = run([
      L.prompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>123</command-args>'),
      L.prompt('<local-command-stdout>\x1b[1mReview ready\x1b[22m</local-command-stdout>'),
      L.system('local_command', { content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>', level: 'info' }),
      L.system('local_command', { content: '<local-command-stdout>Model kept</local-command-stdout>', level: 'info' }),
      L.system('local_command', { content: '<local-command-stdout></local-command-stdout>', level: 'info' }),
    ]);
    expect(e.map((x) => [x.kind, x.kind === 'system' ? `${x.text} | ${x.detail}` : 'text' in x ? x.text : ''])).toEqual([
      ['user', '/review 123'],
      ['system', 'Output of /review | Review ready'],
      ['user', '/model'],
      ['system', 'Output of /model | Model kept'],
    ]);
  });

  it('user bash mode: "! cmd" and output as system', () => {
    const e = run([L.prompt('<bash-input>ls -la</bash-input>'), L.prompt('<bash-stdout>a.txt\nb.txt</bash-stdout><bash-stderr></bash-stderr>')]);
    expect(e[0]).toMatchObject({ kind: 'user', text: '! ls -la' });
    expect(e[1]).toMatchObject({ kind: 'system', text: 'Command output', detail: 'a.txt\nb.txt', level: 'info' });
  });

  it('prompt typed while agent busy (queued_command) becomes user; messages from other agents (meta) do not', () => {
    const e = run([
      queued('and also the footer', { commandMode: 'prompt', origin: { kind: 'human' } }),
      queued([{ type: 'text', text: 'look at the screen' }, { type: 'image', source: { type: 'base64', data: 'AA' } }], { commandMode: 'prompt' }),
      queued('message from another agent', { commandMode: 'prompt', isMeta: true, origin: { kind: 'peer' } }),
    ]);
    expect(only(e, 'user').map((x) => x.text)).toEqual(['and also the footer', 'look at the screen\n[image]']);
    expect(e).toHaveLength(2);
  });

  it('scheduled task becomes inner prompt', () => {
    const e = run([L.prompt('<scheduled-task name="x" file="/tmp/x.md">\nCheck open PRs\n</scheduled-task>')]);
    expect(e).toEqual([expect.objectContaining({ kind: 'user', text: 'Check open PRs' })]);
  });
});

describe('terminal — session events', () => {
  it('interruption (with and without tool) becomes warning', () => {
    const e = run([L.prompt('[Request interrupted by user]'), userBlocks([{ type: 'text', text: '[Request interrupted by user for tool use]' }])]);
    expect(e.map((x) => x.kind === 'system' && [x.text, x.level])).toEqual([
      ['Interrupted by user', 'warn'],
      ['Interrupted by user', 'warn'],
    ]);
  });

  it('background task notification (user line and attachment), with result in detail', () => {
    const withResult =
      '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "Map files" completed</summary>\n<result>Found 3 files.</result>\n</task-notification>';
    const e = run([
      L.notification('toolu_bg', 'completed', 'Background command "Run tests" completed (exit code 0)'),
      L.shellNotification('message', { taskId: 'b2', status: 'failed', summary: 'Background command "build" failed' }),
      queued(withResult, { commandMode: 'task-notification' }),
      // Queue operation is not delivery: ignored.
      L.shellNotification('queue', { taskId: 'b3', status: 'completed' }),
    ]);
    const s = only(e, 'system');
    expect(s.map((x) => [x.text, x.level])).toEqual([
      ['Background task completed: Background command "Run tests" completed (exit code 0)', 'info'],
      ['Background task failed: Background command "build" failed', 'warn'],
      ['Background task completed: Agent "Map files" completed', 'info'],
    ]);
    expect(s[0].detail).toBeUndefined();
    expect(s[2].detail).toBe('Found 3 files.');
    expect(e).toHaveLength(3);
  });

  it('compaction: boundary and summary (truncated in detail)', () => {
    const summary = `Summary of previous conversation.\n${'summary line\n'.repeat(1_000)}`;
    const e = run([
      L.system('compact_boundary', { content: 'Conversation compacted', compactMetadata: { trigger: 'auto' } }),
      JSON.stringify({ ...JSON.parse(L.prompt(summary)), isCompactSummary: true, isVisibleInTranscriptOnly: true }),
      L.system('compact_boundary', { compactMetadata: { trigger: 'manual' } }),
    ]);
    const s = only(e, 'system');
    expect(s.map((x) => x.text)).toEqual(['Conversation compacted automatically', 'Compacted conversation summary', 'Conversation compacted (/compact)']);
    expect(s[1].detail!.startsWith('Summary of previous conversation.')).toBe(true);
    expect(s[1].detail!.length).toBeLessThanOrEqual(DETAIL_MAX + 2);
    expect(s[1].detail!.endsWith('\n…')).toBe(true);
    expect(e.some((x) => x.kind === 'user')).toBe(false);
  });

  it('API errors: one entry per sequence of attempts and synthetic error message', () => {
    const err = { message: '529 overloaded', formatted: 'Server overloaded (529)' };
    const e = run([
      L.system('api_error', { level: 'error', error: err, retryAttempt: 1, maxRetries: 10, retryInMs: 500 }),
      L.system('api_error', { level: 'error', error: err, retryAttempt: 2, maxRetries: 10, retryInMs: 1000 }),
      L.system('api_error', { level: 'error', error: err, retryAttempt: 3, maxRetries: 10, retryInMs: 2000 }),
      JSON.stringify({ ...JSON.parse(L.assistant([L.text('API Error: 529 Overloaded. Try again.')], { model: '<synthetic>' })), isApiErrorMessage: true, error: 'server_error' }),
      L.assistant([L.text('No response requested.')], { model: '<synthetic>' }),
    ]);
    expect(e.map((x) => x.kind === 'system' && [x.text, x.level])).toEqual([
      ['API error: Server overloaded (529) — retrying (up to 10 times)', 'error'],
      ['API Error: 529 Overloaded. Try again.', 'error'],
    ]);
  });

  it('end of turn, informational warnings, and recap', () => {
    const e = run([
      L.system('turn_duration', { durationMs: 65_000 }),
      L.system('informational', { content: 'Unknown command: /xyz', level: 'warning' }),
      L.system('away_summary', { content: 'You asked for X and it is ready.' }),
      L.system('stop_hook_summary', { level: 'suggestion', hookCount: 1 }),
      L.system('bridge_status', { content: '/remote-control is active · https://exemplo.invalid/sessao' }),
    ]);
    expect(e.map((x) => x.kind === 'system' && [x.text, x.level])).toEqual([
      ['Turn completed in 1min 5s', 'info'],
      ['Unknown command: /xyz', 'warn'],
      ['Recap: You asked for X and it is ready.', 'info'],
    ]);
  });

  it('ignores remainder without throwing', () => {
    const p = createTerminalParser();
    const junk = [
      L.raw('summary', { summary: 'x', leafUuid: 'y' }),
      L.raw('file-history-snapshot', { snapshot: {} }),
      L.raw('custom-title', { customTitle: 'Store' }),
      L.raw('progress', { data: { type: 'hook_progress' } }),
      L.raw('last-prompt', { lastPrompt: 'hi' }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'hi' }),
      queued('x', { commandMode: 'bash' }),
      JSON.stringify({ type: 'attachment', attachment: { type: 'hook_success', content: 'ok' } }),
      L.raw('tipo-do-futuro', { x: 1 }),
      JSON.stringify({ type: 'assistant', message: { content: [null, 42, { type: 'tool_use' }, { type: 'text', text: 7 }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result' }] } }),
      JSON.stringify({ type: 'user', message: null }),
      'this is not json',
      '{"type":"user","message":{"content":"corta',
      '[]',
      'null',
      '"text"',
      '',
    ];
    const out = junk.flatMap((l) => p.push(l));
    // The only usable entry: nameless and id-less tool_use still appears.
    expect(out.map((e) => e.kind)).toEqual(['tool']);
  });
});

describe('terminal — responses and tools', () => {
  it('text (raw markdown) and thinking (with and without text)', () => {
    const e = run([
      L.assistant([{ type: 'thinking', thinking: 'I will look at the cart first.', signature: 'sig1' }], { msgId: 'm1' }),
      L.assistant([{ type: 'thinking', thinking: '', signature: 'sig2' }], { msgId: 'm1' }),
      L.assistant([{ type: 'redacted_thinking', data: 'opaque' }], { msgId: 'm1' }),
      L.assistant([L.text('## Done\n\n- fixed the **total**\n- `npm test` passes')], { msgId: 'm1', stop: 'end_turn' }),
      L.assistant([L.text('   \n')], { msgId: 'm1' }),
    ]);
    expect(e.map((x) => x.kind)).toEqual(['thinking', 'thinking', 'thinking', 'assistant']);
    expect((e[0] as { text?: string }).text).toBe('I will look at the cart first.');
    expect('text' in e[1]).toBe(false);
    expect('text' in e[2]).toBe(false);
    expect(e[3]).toMatchObject({ text: '## Done\n\n- fixed the **total**\n- `npm test` passes' });
  });

  it('Claude Code style titles, paths relative to cwd, and arguments', () => {
    const tools = [
      L.tool('t1', 'Bash', { command: 'npm test -- --run\necho done', description: 'Run tests' }),
      L.tool('t2', 'Read', { file_path: '/projetos/demo/src/Cart.tsx' }),
      L.tool('t3', 'Read', { file_path: '/outro/lugar/x.ts', offset: 10, limit: 20 }),
      L.tool('t4', 'Edit', { file_path: '/projetos/demo/src/a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 3;' }),
      L.tool('t5', 'Write', { file_path: '/projetos/demo/README.md', content: '# Demo\n\nHello\n' }),
      L.tool('t6', 'Grep', { pattern: 'useCart', path: '/projetos/demo/src', output_mode: 'content' }),
      L.tool('t7', 'Glob', { pattern: '**/*.ts' }),
      L.tool('t8', 'WebFetch', { url: 'https://exemplo.invalid/docs', prompt: 'Summarize the API' }),
      L.tool('t9', 'WebSearch', { query: 'pix devolução api' }),
      L.tool('t10', 'Agent', { description: 'Map files', subagent_type: 'Explore', prompt: 'List checkout files' }),
      L.tool('t11', 'mcp__claude_ai_Exemplo__buscar_itens', { termo: 'x', limite: 3 }),
      L.tool('t12', 'TodoWrite', {
        todos: [
          { content: 'Read code', status: 'completed' },
          { content: 'Fix', status: 'in_progress' },
          { content: 'Test', status: 'pending' },
        ],
      }),
      L.tool('t13', 'TaskUpdate', { taskId: '3', status: 'completed' }),
      L.tool('t14', 'FerramentaNova', { alvo: 'servidor', vezes: 2 }),
      L.tool('t15', 'mcp__srv__ping', {}),
      L.tool('t16', 'MultiEdit', { file_path: '/projetos/demo/b.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] }),
    ];
    const e = only(run([L.assistant(tools, { msgId: 'm1' })]), 'tool');
    const view = (id: string) => {
      const t = e.find((x) => x.id === id)!;
      return { title: t.title, input: t.input, kind: t.inputKind };
    };
    expect(e.map((x) => x.tool)).toEqual(tools.map((t) => t.name));
    expect(view('t1')).toEqual({ title: 'Bash(npm test -- --run …)', input: 'npm test -- --run\necho done', kind: 'command' });
    expect(view('t2')).toEqual({ title: 'Read(src/Cart.tsx)', input: undefined, kind: undefined });
    expect(view('t3')).toEqual({ title: 'Read(/outro/lugar/x.ts)', input: '{\n  "offset": 10,\n  "limit": 20\n}', kind: 'json' });
    expect(view('t4')).toEqual({ title: 'Edit(src/a.ts)', input: '- const a = 1;\n- const b = 2;\n+ const a = 3;', kind: 'diff' });
    expect(view('t5')).toEqual({ title: 'Write(README.md)', input: '+ # Demo\n+ \n+ Hello', kind: 'diff' });
    expect(view('t6')).toEqual({ title: 'Grep(useCart)', input: '{\n  "path": "src",\n  "output_mode": "content"\n}', kind: 'json' });
    expect(view('t7')).toEqual({ title: 'Glob(**/*.ts)', input: undefined, kind: undefined });
    expect(view('t8')).toEqual({ title: 'WebFetch(https://exemplo.invalid/docs)', input: 'Summarize the API', kind: 'text' });
    expect(view('t9')).toEqual({ title: 'WebSearch(pix devolução api)', input: undefined, kind: undefined });
    expect(view('t10')).toEqual({ title: 'Agent(Explore: Map files)', input: 'List checkout files', kind: 'text' });
    expect(view('t11')).toEqual({ title: 'Exemplo - buscar_itens (MCP)', input: '{\n  "termo": "x",\n  "limite": 3\n}', kind: 'json' });
    expect(view('t12')).toEqual({ title: 'TodoWrite(1/3 done)', input: '☒ Read code\n◐ Fix\n☐ Test', kind: 'text' });
    expect(view('t13').title).toBe('TaskUpdate(#3 → completed)');
    expect(view('t14')).toEqual({ title: 'FerramentaNova(servidor)', input: '{\n  "vezes": 2\n}', kind: 'json' });
    expect(view('t15')).toEqual({ title: 'srv - ping (MCP)', input: undefined, kind: undefined });
    expect(view('t16')).toEqual({ title: 'MultiEdit(b.ts)', input: '- x\n+ y\n@@\n- p\n+ q', kind: 'diff' });
  });

  it('results: text, blocks, image, error, denial, and own id', () => {
    const e = run([
      L.assistant([L.tool('a', 'Bash', { command: 'npm test' }), L.tool('b', 'Read', { file_path: '/projetos/demo/logo.png' })], { at: T0 }),
      L.result('a', '\x1b[32m✓ 42 tests passed\x1b[0m\n', { at: T0 + 2_000 }),
      userBlocks([{ type: 'tool_result', tool_use_id: 'b', content: [{ type: 'text', text: 'Image read' }, { type: 'image', source: { type: 'base64', data: 'AA' } }] }]),
      L.result('c', '<tool_use_error>File not found</tool_use_error>', { error: true }),
      L.result('d', "The user doesn't want to proceed with this tool use. The tool use was rejected. To tell you how to proceed, the user said:\nuse the other folder", { error: true }),
      L.result('e', ''),
    ]);
    const r = only(e, 'result');
    expect(r.map((x) => [x.id, x.toolUseId, x.text, x.error ?? false])).toEqual([
      ['a:r', 'a', '✓ 42 tests passed', false],
      ['b:r', 'b', 'Image read\n[image]', false],
      ['c:r', 'c', 'File not found', true],
      ['d:r', 'd', 'Denied by the user: use the other folder', true],
      ['e:r', 'e', '(no output)', false],
    ]);
    expect(r[0].at).toBe(T0 + 2_000);
    expect(r.every((x) => x.truncated === undefined)).toBe(true);
  });

  it('fork: inherited copy of parent call does not appear; directive becomes prompt', () => {
    const e = run([...L.forkStart('afork1', 'toolu_pai', 'Review checkout'), L.assistant([L.tool('f1', 'Read', { file_path: '/projetos/demo/a.ts' })])]);
    expect(e.map((x) => [x.kind, x.kind === 'user' ? x.text : x.id])).toEqual([
      ['user', 'Review checkout'],
      ['tool', 'f1'],
    ]);
  });
});

describe('terminal — security, limits, and duplicates', () => {
  it('masks secrets in all exposed text', () => {
    const e = run([
      L.prompt(`use key ${TOKEN} to test`),
      L.assistant([{ type: 'thinking', thinking: `the key is ${TOKEN}`, signature: 's' }]),
      L.assistant([L.text(`Configured ${TOKEN}.`)]),
      L.assistant([L.tool('t1', 'Bash', { command: `ANTHROPIC_API_KEY=${TOKEN} npm start` })]),
      L.assistant([L.tool('t2', 'WebFetch', { url: `https://api.exemplo.invalid/?k=${TOKEN}`, prompt: `token ${TOKEN}` })]),
      L.assistant([L.tool('t3', 'mcp__x__y', { header: `Authorization: Bearer ${TOKEN}` })]),
      L.assistant([L.tool('t4', 'Edit', { file_path: '/projetos/demo/.env', old_string: 'KEY=old', new_string: `KEY=${TOKEN}` })]),
      L.result('t1', `started with ${TOKEN}`),
      L.prompt(`<local-command-stdout>${TOKEN}</local-command-stdout>`),
      L.notification('toolu_bg', 'completed', `summary ${TOKEN}`),
      L.system('informational', { content: `notice ${TOKEN}`, level: 'notice' }),
    ]);
    expect(e.length).toBeGreaterThanOrEqual(11);
    const json = JSON.stringify(e);
    expect(json).not.toContain('testeFALSO');
    expect(json).toContain('sk-***');
  });

  it('long result: truncates to lines and chars and marks truncated', () => {
    const manyLines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
    const wide = 'x'.repeat(RESULT_MAX * 5);
    const r = only(run([L.result('a', manyLines), L.result('b', wide), L.result('c', 'short')]), 'result');
    expect(r[0].text.split('\n')).toHaveLength(RESULT_MAX_LINES);
    expect(r[0].text.endsWith(`line ${RESULT_MAX_LINES}`)).toBe(true);
    expect(r[0].truncated).toBe(true);
    expect(r[1].text.length).toBeLessThanOrEqual(RESULT_MAX);
    expect(r[1].truncated).toBe(true);
    expect(r[2].truncated).toBeUndefined();
  });

  it('long texts: user/assistant, thinking, and arguments stay within limits', () => {
    const huge = 'word '.repeat(10_000);
    const e = run([
      L.prompt(huge),
      L.assistant([L.text(huge)]),
      L.assistant([{ type: 'thinking', thinking: huge, signature: 's' }]),
      L.assistant([L.tool('t1', 'Bash', { command: huge })]),
      L.assistant([L.tool('t2', 'Write', { file_path: '/projetos/demo/a.txt', content: 'line\n'.repeat(5_000) })]),
    ]);
    const len = (x: TerminalEntry) => ('text' in x && x.text ? x.text.length : 0);
    expect(len(e[0])).toBeLessThanOrEqual(TEXT_MAX + 2);
    expect(len(e[1])).toBeLessThanOrEqual(TEXT_MAX + 2);
    expect(len(e[2])).toBeLessThanOrEqual(THINKING_MAX + 2);
    expect((e[0] as { text: string }).text.endsWith('\n…')).toBe(true);
    for (const t of only(e, 'tool')) {
      expect(t.input!.length).toBeLessThanOrEqual(INPUT_MAX + 8);
      expect(t.title.length).toBeLessThanOrEqual(120);
    }
    expect(only(e, 'tool')[1].input!.endsWith('+ …')).toBe(true);
  });

  it('masks before truncating: secret at cutoff boundary does not leak half', () => {
    for (const pad of [RESULT_MAX - 10, RESULT_MAX * 2 + 1_024 - 12, RESULT_MAX * 2 + 1_024 - 30]) {
      const r = only(run([L.result('a', `${'a'.repeat(pad)} ${TOKEN} end`)]), 'result')[0];
      expect(r.text).not.toMatch(/sk-ant|testeFALSO|testeF/);
    }
    const t = only(run([L.assistant([L.tool('t', 'Bash', { command: `${'b'.repeat(INPUT_MAX - 6)} ${TOKEN}` })])]), 'tool')[0];
    expect(t.input).not.toMatch(/sk-ant|teste/);
    // Many secrets shrink text when masked: the end of prior slice (with half a token, too short
    // for the regexes) would remain visible if not discarded.
    const window = RESULT_MAX * 2 + 1_024;
    const step = TOKEN.length + 1;
    const lead = window - 9 - step * 200 - 1; // slice leaves only "sk-ant-ap"
    const r = only(run([L.result('b', `${'z'.repeat(lead)} ${`${TOKEN} `.repeat(400)}`)]), 'result')[0];
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('sk-***');
    expect(r.text).not.toMatch(/sk-ant|testeF/);
  });

  it('no duplicates: repeated line, multi-line message, and repeated block', () => {
    const think = L.assistant([{ type: 'thinking', thinking: '', signature: 'abc' }], { msgId: 'm1' });
    const lines = [
      L.prompt('hi', { at: T0 }),
      think,
      think,
      L.assistant([L.text('First')], { msgId: 'm1' }),
      L.assistant([L.tool('t1', 'Bash', { command: 'ls' })], { msgId: 'm1' }),
      // Cumulative line (different uuid, repeating previous blocks of same message).
      L.assistant([L.text('First'), L.tool('t1', 'Bash', { command: 'ls' }), L.text('Second')], { msgId: 'm1' }),
      L.result('t1', 'ok'),
    ];
    const e = run([...lines, lines[6]]);
    expect(e.map((x) => x.kind)).toEqual(['user', 'thinking', 'assistant', 'tool', 'assistant', 'result']);
    expect(only(e, 'assistant').map((x) => x.text)).toEqual(['First', 'Second']);
    expect(new Set(e.map((x) => x.id)).size).toBe(e.length);
  });

  it('line without timestamp uses last seen', () => {
    const noTs = JSON.parse(L.prompt('without timestamp')) as Record<string, unknown>;
    delete noTs.timestamp;
    const e = run([L.prompt('with timestamp', { at: T0 + 5_000 }), JSON.stringify(noTs)]);
    expect(e.map((x) => x.at)).toEqual([T0 + 5_000, T0 + 5_000]);
  });

  it('handles ~4 MB of JSONL quickly', () => {
    const lines: string[] = [];
    let bytes = 0;
    for (let i = 0; bytes < 4 * 1024 * 1024; i++) {
      const batch = [
        L.assistant([L.tool(`t${i}`, 'Bash', { command: `npm run build -- --step ${i}` })], { at: T0 + i }),
        L.result(`t${i}`, `output ${i}\n`.repeat(200), { at: T0 + i }),
        L.assistant([L.text(`Step ${i} ready. ${'text '.repeat(50)}`)], { at: T0 + i }),
      ];
      for (const l of batch) {
        lines.push(l);
        bytes += l.length + 1;
      }
    }
    const start = performance.now();
    const e = run(lines);
    const ms = performance.now() - start;
    expect(e.length).toBe(lines.length);
    expect(ms).toBeLessThan(3_000);
  });
});
