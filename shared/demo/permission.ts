// Fictional permission requests (and questions) for demo mode (answering from office without real sessions),
// for Claude Code and Codex (approval only, no "always allow").
// Pure: used by simulator on server (HABBLAUD_DEMO=1) and in browser (?mock=1).
import type { PermissionRequestInfo } from '../types';
import { describeTool } from '../activity';
import { tr } from '../i18n';

export interface DemoPermissionSource {
  /** Fictional project files (relative to root). */
  files: readonly string[];
  /** Fictional project terminal commands. */
  commands: readonly string[];
}

/** How long the fictional "hook" waits before falling back to the terminal. */
export const DEMO_PERMISSION_MS = 5 * 60_000;

/** Lines of a fictional diff, in terminal format ("- old" / "+ new"). */
const DEMO_DIFFS: readonly string[][] = [
  ['- const total = items.reduce((s, i) => s + i.price, 0);', '+ const total = items.reduce((s, i) => s + i.price * i.qty, 0);', '+ if (total < 0) throw new Error("total inválido");'],
  ['- export const TIMEOUT = 5_000;', '+ export const TIMEOUT = 15_000;'],
  ['- <button onClick={save}>Salvar</button>', '+ <button onClick={save} disabled={saving}>', '+   {saving ? "Salvando…" : "Salvar"}', '+ </button>'],
];

interface DemoQuestion {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** Fictional AskUserQuestion questions: one single-choice and one multi-select. */
const DEMO_QUESTIONS: readonly DemoQuestion[][] = [
  [
    {
      header: 'Cache',
      question: tr('Where should I store the login session cache?'),
      options: [
        { label: 'Redis', description: tr("Fast, and already runs in the project's docker-compose") },
        { label: 'PostgreSQL', description: tr('One more table in the existing database') },
        { label: tr('Memory'), description: tr('Simpler, but lost when the server restarts') },
      ],
    },
    {
      header: tr('Tests'),
      question: tr('Which tests should I run before committing?'),
      multiSelect: true,
      options: [
        { label: tr('Unit'), description: tr('npm test, about 40 s') },
        { label: tr('Integration'), description: tr('Spins up a test database in Docker') },
        { label: 'E2E', description: tr('Playwright in the browser, about 5 min') },
      ],
    },
  ],
  [
    {
      header: tr('Network error'),
      question: tr('How should I handle network failures at checkout?'),
      options: [
        { label: tr('Try again'), description: tr('Up to 3 attempts, with increasing delays') },
        { label: tr('Notify the customer'), description: tr('Message with a button to try again') },
        { label: tr('Save and send later'), description: tr('Local queue until the connection is back') },
      ],
    },
    {
      header: tr('Screens'),
      question: tr('Which screens should I apply the change to?'),
      multiSelect: true,
      options: [{ label: tr('Cart') }, { label: tr('Payment') }, { label: tr('Order confirmation') }],
    },
  ],
];

/** Question text, as terminal displays AskUserQuestion arguments. */
function questionsText(qs: readonly DemoQuestion[]): string {
  return qs.map((q) => [q.question, ...q.options.map((o) => `  - ${o.label}${o.description ? `: ${o.description}` : ''}`)].join('\n')).join('\n\n');
}

/** Fictional request type: permission (command, edit, page) or AskUserQuestion question. */
export type DemoPermissionKind = 'permission' | 'question';

/**
 * A fictional request (terminal command, file edit, web page read, or AskUserQuestion question),
 * with the "always allow" suggestion that Claude Code usually offers for commands. `kind` forces type
 * (tests and screenshots); without it, randomly picked.
 */
export function demoPermission(id: string, src: DemoPermissionSource, rng: () => number, now: number, kind?: DemoPermissionKind): PermissionRequestInfo {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = kind === 'question' ? 1 : kind === 'permission' ? rng() * 0.9 : rng();
  const base = { id, createdAt: now, expiresAt: now + DEMO_PERMISSION_MS };
  if (roll >= 0.9) {
    const qs = pick(DEMO_QUESTIONS);
    const d = describeTool('AskUserQuestion', { questions: qs });
    return { ...base, tool: 'AskUserQuestion', title: `AskUserQuestion(${qs[0].question})`, text: d.text, icon: d.icon, input: questionsText(qs), inputKind: 'text', questions: d.questions };
  }
  if (roll < 0.55 && src.commands.length) {
    const command = pick(src.commands);
    const d = describeTool('Bash', { command });
    const prefix = command.split(/\s+/).slice(0, 2).join(' ');
    return {
      ...base,
      tool: 'Bash',
      title: `Bash(${command})`,
      text: d.text,
      icon: d.icon,
      input: command,
      inputKind: 'command',
      suggestions: [{ index: 0, rules: [`Bash(${prefix}:*)`], destination: 'localSettings' }],
    };
  }
  if (roll < 0.8 && src.files.length) {
    const file = pick(src.files);
    const d = describeTool('Edit', { file_path: file });
    return { ...base, tool: 'Edit', title: `Edit(${file})`, text: d.text, icon: d.icon, input: pick(DEMO_DIFFS).join('\n'), inputKind: 'diff' };
  }
  const url = 'https://developer.mozilla.org/pt-BR/docs/Web/API/Fetch_API';
  const d = describeTool('WebFetch', { url });
  return {
    ...base,
    tool: 'WebFetch',
    title: `WebFetch(${url})`,
    text: d.text,
    icon: d.icon,
    input: tr('Summarize how to handle network errors with fetch'),
    inputKind: 'text',
    suggestions: [{ index: 0, rules: ['WebFetch(domain:developer.mozilla.org)'], destination: 'localSettings' }],
  };
}

/**
 * How long Codex "hook" waits for office decision (HABBLAUD_CODEX_PERMISSION_TIMEOUT, default 25 s). After
 * that, Codex resumes normal flow and approval appears in the terminal.
 */
export const DEMO_CODEX_PERMISSION_MS = 25_000;

/**
 * Fictional network destinations (Codex requests network access as a Bash with
 * description "network-access <target>").
 */
const DEMO_NETWORK: ReadonlyArray<[host: string, command: string]> = [
  ['registry.npmjs.org', 'npm install'],
  ['pypi.org', 'pip install -r requirements.txt'],
  ['api.github.com', 'gh pr view --json title'],
];

/** Diff for apply_patch in Codex format (Begin/End Patch, "-old" and "+new" lines). */
export function demoPatchText(file: string, lines: readonly string[], add = false): string {
  const body = lines.map((l) => (l.startsWith('- ') ? `-${l.slice(2)}` : l.startsWith('+ ') ? `+${l.slice(2)}` : add ? `+${l}` : ` ${l}`));
  return ['*** Begin Patch', `*** ${add ? 'Add' : 'Update'} File: ${file}`, ...(add ? [] : ['@@']), ...body, '*** End Patch'].join('\n');
}

/**
 * A fictional Codex approval request (PermissionRequest hook): terminal command, apply_patch, or network
 * access. No "always allow" suggestions (Codex rejects them via hook) and never a question; short timeout.
 */
export function demoCodexPermission(id: string, src: DemoPermissionSource, rng: () => number, now: number): PermissionRequestInfo {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = rng();
  const base = { id, provider: 'codex' as const, createdAt: now, expiresAt: now + DEMO_CODEX_PERMISSION_MS };
  if (roll < 0.3 && src.files.length) {
    const file = pick(src.files);
    const d = describeTool('Edit', { file_path: file });
    return { ...base, tool: 'apply_patch', title: `apply_patch(${file})`, text: d.text, icon: d.icon, input: demoPatchText(file, pick(DEMO_DIFFS)), inputKind: 'diff' };
  }
  if (roll < 0.45) {
    const [host, command] = pick(DEMO_NETWORK);
    return { ...base, tool: 'Bash', title: `Bash(${command})`, text: tr('Network access: {0}', [host]), icon: '🌐', input: command, inputKind: 'command' };
  }
  const command = src.commands.length ? pick(src.commands) : 'npm test';
  const d = describeTool('Bash', { command });
  return { ...base, tool: 'Bash', title: `Bash(${command})`, text: d.text, icon: d.icon, input: command, inputKind: 'command' };
}
