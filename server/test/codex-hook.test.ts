// Codex hook (mod/habblaud-codex/hook.mjs) run as real process against test server (real
// routes and fake Codex source): observation events (no output), account via CODEX_HOME, via
// transcript_path or ~/.codex, config in ~/.habblaud/codex-hook.json, and PermissionRequest (allow, deny,
// terminal, timed out, Habblaud down). HOME and CODEX_HOME always in temp folders; synthetic stdin.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { CODEX_MAIN, CODEX_THREAD, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-codex/hook.mjs');

/** Functions exported by hook (plain JavaScript, untyped). */
interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; waitMs: number };
  codexHomeOf(env: NodeJS.ProcessEnv, input: unknown): string;
  accountOf(codexHome: string): string;
  eventBody(input: Record<string, unknown>, account: string, codexHome: string): Record<string, unknown>;
  permissionBody(input: Record<string, unknown>, account: string, codexHome: string, timeoutMs: number): Record<string, unknown>;
  decisionOutput(result: unknown): unknown;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

/** Fake Codex source: stores received events. */
class FakeLive {
  calls: Array<{ account: string | undefined; input: Record<string, unknown> }> = [];
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    this.calls.push({ account, input });
    return true;
  }
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let codexHome: string;
let srv: PermissionServer | undefined;
let live: FakeLive;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  codexHome = join(home, '.codex-trabalho');
  mkdirSync(codexHome, { recursive: true });
  live = new FakeLive();
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  tmp.cleanup();
});

/** ~/.habblaud/codex-hook.json in fake HOME. */
function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'codex-hook.json'), JSON.stringify(cfg));
}

function runHook(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** Synthetic JSON for a Codex hook event. */
function codexEvent(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: CODEX_THREAD,
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: '/p/loja',
    hook_event_name: event,
    model: 'gpt-teste',
    permission_mode: 'default',
    ...over,
  };
}

const permission = (over: Record<string, unknown> = {}) => codexEvent('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' }, ...over });

async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(CODEX_MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('hook did not register request');
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe('Codex hook.mjs (process)', () => {
  it('observation event: goes to /api/codex/events with account and CODEX_HOME; nothing on stdout', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const input = codexEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'ls' } });
    const r = await runHook(JSON.stringify(input), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(live.calls).toEqual([{ account: '.codex-trabalho', input }]);
    expect(srv.registry!.size).toBe(0);
  });

  it('account comes from transcript_path when CODEX_HOME is absent (hook env is daemon env); otherwise ~/.codex', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const transcript = join(codexHome, 'sessions', '2026', '10', '09', `rollout-2026-10-09T09-00-00-${CODEX_THREAD}.jsonl`);
    await runHook(JSON.stringify(codexEvent('Stop', { transcript_path: transcript, last_assistant_message: 'done' })));
    await runHook(JSON.stringify(codexEvent('SessionEnd', { reason: 'other' })));
    expect(live.calls.map((c) => c.account)).toEqual(['.codex-trabalho', '.codex']);
  });

  it('huge text (command output in PostToolUse) is trimmed within server limit', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    const big = codexEvent('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'cat x' }, tool_response: { output: 'x'.repeat(600_000) } });
    const r = await runHook(JSON.stringify(big), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(live.calls).toHaveLength(1);
    expect((live.calls[0].input.tool_response as { output: string }).output.length).toBe(8_000);
  });

  it('PermissionRequest approved in Habblaud: sends event, registers and prints allow (only that)', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port, permissionTimeoutS: 30 });
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    const id = await pendingId(srv);
    expect(live.calls.map((c) => c.input.hook_event_name)).toEqual(['PermissionRequest']);
    const info = srv.registry!.detail(id)!;
    expect(info).toMatchObject({ provider: 'codex', tool: 'Bash', title: 'Bash(npm test)' });
    // File wait (30 s) becomes request timeout in office.
    expect(info.expiresAt - info.createdAt).toBeGreaterThan(25_000);
    expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30_000);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n');
  });

  it('recusado com motivo: deny com a mensagem (sem interrupt); "responder no terminal": nada no stdout', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    let run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    let r = await run;
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no Habblaud: use pnpm' } } });
    run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('HABBLAUD_PORT acts as fallback when file does not have port', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome, HABBLAUD_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow' });
    expect(JSON.parse((await run).stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('Habblaud down, no page open or unknown session: exits fast without decision', async () => {
    writeConfig({ port: await deadPort() });
    let r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    srv = await servePermissions({ codex: true, codexLive: live, viewers: 0 });
    writeConfig({ port: srv.port });
    r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    r = await runHook(JSON.stringify(permission({ session_id: '0199ffff-0000-7000-8000-000000000000' })), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('timed out (permissionTimeoutS: 5): gives up and exits without decision (Codex proceeds with normal approval)', async () => {
    srv = await servePermissions({ codex: true, codexLive: live, registry: { orphanMs: 300 } });
    writeConfig({ port: srv.port, permissionTimeoutS: 5 });
    const r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(10_000);
  }, 20_000);

  it('invalid stdin or event unused by Habblaud: nothing is sent', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    writeConfig({ port: srv.port });
    for (const stdin of ['', 'not json', '[]', JSON.stringify({ hook_event_name: 'Stop' }), JSON.stringify(codexEvent('PreCompact', { trigger: 'auto' }))]) {
      const r = await runHook(stdin, { CODEX_HOME: codexHome });
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(live.calls).toHaveLength(0);
  });
});

describe('Codex hook.mjs (functions)', () => {
  it('readConfig: file, HABBLAUD_PORT fallback, defaults and wait limits', () => {
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4851, waitMs: 25_000 });
    writeConfig({ port: 4900, permissionTimeoutS: 60 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4900, waitMs: 60_000 });
    writeConfig({ port: 'x', permissionTimeoutS: 1 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 5_000 });
    writeConfig({ permissionTimeoutS: 999 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 120_000 });
    writeFileSync(join(home, '.habblaud', 'codex-hook.json'), '{ broken');
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
  });

  it('codexHomeOf/accountOf: CODEX_HOME (with ~), transcript_path (sessions/ or archived_sessions/) and ~/.codex', () => {
    // resolve/join like hook: on Windows, with drive letter and `\`.
    expect(hook.codexHomeOf({ HOME: '/u', CODEX_HOME: '~/.codex-b/' }, {})).toBe(resolve('/u/.codex-b'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-c/sessions/2026/10/09/rollout-a-${CODEX_THREAD}.jsonl` })).toBe(resolve('/x/.codex-c'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-d/archived_sessions/rollout-a.jsonl` })).toBe(resolve('/x/.codex-d'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: 'relativo/sessions/2026/10/09/r.jsonl' })).toBe(join('/u', '.codex'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: null })).toBe(join('/u', '.codex'));
    expect(hook.accountOf('/u/.codex')).toBe('.codex');
  });

  it('permissionBody: codex provider, account and only what Habblaud uses', () => {
    const body = hook.permissionBody(permission({ agent_id: 'child', agent_type: 'worker', tool_input: { command: 'y'.repeat(20_000) } }), '.codex', '/u/.codex', 25_000);
    expect(Object.keys(body).sort()).toEqual(['account', 'agent_id', 'agent_type', 'codexHome', 'cwd', 'provider', 'session_id', 'timeout_ms', 'tool_input', 'tool_name', 'turn_id']);
    expect(body).toMatchObject({ provider: 'codex', account: '.codex', codexHome: '/u/.codex', session_id: CODEX_THREAD, tool_name: 'Bash', timeout_ms: 25_000 });
    expect((body.tool_input as { command: string }).command.length).toBe(8_000);
    expect(JSON.stringify(hook.eventBody(codexEvent('Stop'), '.codex', '/u/.codex'))).toContain('"hook_event_name":"Stop"');
  });

  it('decisionOutput: only allow and deny (+message); never updatedInput, updatedPermissions or interrupt', () => {
    const allow = hook.decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 0 });
    expect(allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', interrupt: true })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no Habblaud.' } },
    });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'answer', answers: [] })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'released', reason: 'terminal' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(hook.decisionOutput(undefined)).toBeUndefined();
  });
});
