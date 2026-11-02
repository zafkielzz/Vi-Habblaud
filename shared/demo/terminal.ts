// Demo agent terminal: a fictional, deterministic conversation built
// from simulated agent title and activities (no real data). Pure code.
//
// Each activity turns into one or more entries with ids derived from activity id: when server
// recalculates list with new activities, old ones keep same ids (and only new ones are sent).
// Generated content (thoughts, command outputs, code snippets) comes from an id hash and only
// depends on the activity itself and agent fixed data: history slides (retains only recent
// activities) without altering what was already shown.
//
// Codex agents get conversation in Codex style: shell commands (including for read/search: sed, rg),
// edits via apply_patch (full patch, with "Success. Updated the following files"), update_plan,
// web_search, and spawn_agent.
import type { Activity, AgentInfo, TerminalEntry } from '../types';
import { SHELL_DONE_TOOL, SHELL_WAIT_TOOL } from '../activity';
import { hash32 } from '../hash';
import { MESSAGE_TOOL } from '../messages';
import { demoPatchText } from './permission';
import { tr } from '../i18n';

/**
 * Activity text comes from describeTool in active locale: compares by start of PT text or
 * translation (whatever precedes first placeholder), so demo works in any locale.
 */
function startsWithText(text: string, key: string): boolean {
  return text.startsWith(key.split('{0}')[0]) || text.startsWith(tr(key, ['\u0000']).split('\u0000')[0]);
}

type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;

interface Ctx {
  agent: AgentInfo;
  history: Activity[];
  /** Project directory (for relative paths), taken from room id. */
  root: string;
  project: string;
  /** Generic project files (searches, git status), in language suggested by project name. */
  pool: readonly string[];
  /** Codex agent: tools and outputs in its style. */
  codex: boolean;
}

const POOLS: Record<'ts' | 'py' | 'astro', readonly string[]> = {
  ts: ['src/app.ts', 'src/utils/format.ts', 'src/components/Item.tsx', 'tests/app.test.ts'],
  py: ['pipelines/ingest.py', 'pipelines/transform.py', 'tests/test_transform.py', 'requirements.txt'],
  astro: ['src/pages/index.astro', 'src/components/Hero.astro', 'src/content/blog/lancamento.md', 'astro.config.mjs'],
};

function poolFor(project: string): readonly string[] {
  if (/pipeline|data|etl|python/i.test(project)) return POOLS.py;
  if (/site|blog|institucional|landing/i.test(project)) return POOLS.astro;
  return POOLS.ts;
}

/** `n` distinct files from the set, picked by hash. */
function pickFiles(pool: readonly string[], seed: number, n: number): string[] {
  return Array.from({ length: Math.min(n, pool.length) }, (_, k) => pool[(seed + k) % pool.length]);
}

const pick = <T>(arr: readonly T[], seed: number): T => arr[seed % arr.length];
const num = (seed: number, min: number, max: number) => min + (seed % (max - min + 1));
const hex = (seed: number) => seed.toString(16).padStart(8, '0').slice(0, 7);

function rel(path: string, ctx: Ctx): string {
  return ctx.root && path.startsWith(`${ctx.root}/`) ? path.slice(ctx.root.length + 1) : path;
}

const extOf = (file: string) => /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? 'txt';
const baseName = (file: string) => file.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
const pascal = (s: string) => s.replace(/(^|[-_.\s])(\w)/g, (_, __, c: string) => c.toUpperCase());

// ------------------------------------------------------------------ generated content

const THOUGHTS = [
  tr("Before touching anything, it's worth understanding how this flow is built today."),
  tr('The safest move is to cover it with a test first and then adjust the code.'),
  tr("I think the problem is in the calculation; I'll check who calls this function."),
  tr('This can be fixed with a small change, without breaking the existing API.'),
  tr('I need to check whether other places depend on this behavior.'),
];

const SUMMARIES = [
  tr('Done! I adjusted what was needed and the tests passed.'),
  tr('Done. The change is small and covered by tests.'),
  tr('Task complete; the build and the tests are all green.'),
  tr('Finished. If you want, I can open a PR with these changes.'),
];

/** Plausible code snippet by extension (for Read and Write). */
function snippet(file: string): string[] {
  const name = pascal(baseName(file));
  switch (extOf(file)) {
    case 'tsx':
      return [
        `import { useMemo } from 'react';`,
        '',
        `export function ${name}({ items }: ${name}Props) {`,
        '  const total = useMemo(() => items.reduce((soma, item) => soma + item.preco * item.qtd, 0), [items]);',
        '  return <Resumo total={total} itens={items.length} />;',
        '}',
      ];
    case 'ts':
    case 'js':
    case 'mjs':
      return [
        `import { db } from './db';`,
        '',
        `export async function ${name.charAt(0).toLowerCase()}${name.slice(1)}(id: string) {`,
        `  const registro = await db.find(id);`,
        `  if (!registro) throw new Error('não encontrado');`,
        '  return registro;',
        '}',
      ];
    case 'py':
      return ['import pandas as pd', '', 'def transformar(df: pd.DataFrame) -> pd.DataFrame:', '    df = df.drop_duplicates(subset=["evento_id"])', '    df["criado_em"] = pd.to_datetime(df["criado_em"], utc=True)', '    return df'];
    case 'sql':
      return ['CREATE TABLE refunds (', '  id UUID PRIMARY KEY,', '  payment_id UUID NOT NULL REFERENCES payments(id),', '  amount NUMERIC(12, 2) NOT NULL,', '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()', ');'];
    case 'css':
      return [':root {', '  --cor-primaria: #1f5fa8;', '  --raio: 8px;', '}', '', '.botao { border-radius: var(--raio); }'];
    case 'json':
      return ['{', `  "name": "projeto-demo",`, '  "version": "1.5.0",', '  "scripts": { "test": "vitest run", "build": "vite build" }', '}'];
    case 'md':
      return ['---', tr('titulo: Launch'), '---', '', '# Novidades', '', tr('The site now loads faster.')];
    case 'yml':
    case 'yaml':
      return ['services:', '  db:', '    image: postgres:17', '    ports:', '      - "5432:5432"'];
    case 'astro':
      return ['---', `import Layout from '../layouts/Layout.astro';`, '---', '', '<Layout titulo="Início">', '  <h1>Bem-vindo</h1>', '</Layout>'];
    default:
      return ['User-agent: *', 'Allow: /', '', 'Sitemap: https://www.example.com/sitemap.xml'];
  }
}

/** Plausible old → new pair by extension (for Edit). */
function editPair(file: string, seed: number): [string, string] {
  const pairs: Record<string, Array<[string, string]>> = {
    tsx: [
      ['  const total = items.reduce((soma, item) => soma + item.preco, 0);', '  const total = items.reduce((soma, item) => soma + item.preco * item.qtd, 0);'],
      ['  return <Resumo total={total} />;', '  return <Resumo total={total} itens={items.length} />;'],
    ],
    ts: [
      ["  if (!registro) return null;", "  if (!registro) throw new Error('não encontrado');"],
      ['const LIMITE = 10;', 'const LIMITE = 50;'],
    ],
    py: [['    df["criado_em"] = pd.to_datetime(df["criado_em"])', '    df["criado_em"] = pd.to_datetime(df["criado_em"], utc=True)']],
    sql: [['  amount NUMERIC(10, 2),', '  amount NUMERIC(12, 2) NOT NULL,']],
    css: [['  --cor-primaria: #2b6cb0;', '  --cor-primaria: #1f5fa8;']],
    json: [['  "version": "1.4.0",', '  "version": "1.5.0",']],
    md: [['# Novidades', tr("# What's new in version 1.5")]],
    yml: [['    image: postgres:16', '    image: postgres:17']],
    astro: [['  <h1>Bem-vindo</h1>', '  <h1>Bem-vindo à nossa loja</h1>']],
  };
  const ext = extOf(file);
  const key = ext === 'js' || ext === 'mjs' ? 'ts' : ext === 'yaml' ? 'yml' : ext;
  return pick(pairs[key] ?? [['Allow: /', 'Allow: /\nDisallow: /admin']], seed);
}

/** Mock (and coherent) output of a shell command. */
function commandOutput(command: string, seed: number, ctx: Ctx): string {
  const branch = ctx.agent.gitBranch ?? 'main';
  const [f1, f2] = pickFiles(ctx.pool, seed, 2);
  const n = (min: number, max: number) => num(seed, min, max);
  const secs = `${n(1, 9)}.${n(10, 99)}`;
  if (/playwright\s+test/.test(command)) return `Running ${n(8, 30)} tests using 4 workers\n\n  ✓ ${n(8, 30)} passed (${secs}s)`;
  if (/pytest/.test(command)) return `${'.'.repeat(n(12, 40))}\n${n(12, 40)} passed in ${secs}s`;
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?test\b|vitest|jest/.test(command)) {
    return tr('✓ {0} tests passed ({1} files)\nDuration: {2}s', [n(20, 140), n(3, 12), secs]);
  }
  if (/^git status/.test(command)) return `On branch ${branch}\nChanges not staged for commit:\n\tmodified:   ${f1}\n\tmodified:   ${f2}\n\nno changes added to commit`;
  if (/^git diff/.test(command)) {
    const [a, b] = editPair(f1, seed);
    return `diff --git a/${f1} b/${f1}\n--- a/${f1}\n+++ b/${f1}\n@@ -${n(5, 80)},1 +${n(5, 80)},1 @@\n-${a}\n+${b}`;
  }
  if (/^git commit/.test(command)) {
    const msg = /-m\s+["']([^"']+)["']/.exec(command)?.[1] ?? 'ajustes';
    return `[${branch} ${hex(seed)}] ${msg}\n ${n(1, 6)} files changed, ${n(10, 160)} insertions(+), ${n(1, 40)} deletions(-)`;
  }
  if (/^git push/.test(command)) return `To git.example.com:empresa/${ctx.project}.git\n   ${hex(seed)}..${hex(hash32(String(seed)))}  ${branch} -> ${branch}`;
  if (/^git pull/.test(command)) return 'Already up to date.';
  if (/\bdb:migrate\b/.test(command)) return tr('Migration 004_refunds applied\nSeed complete ({0} records)', [n(10, 90)]);
  if (/\b(npm|pnpm|yarn)\s+(run\s+)?build\b|vite\s+build/.test(command)) return `vite v6.3.5 building for production...\n✓ ${n(80, 900)} modules transformed.\n✓ built in ${secs}s`;
  if (/\blint\b/.test(command)) return tr('✓ No problems found ({0} files)', [n(20, 200)]);
  if (/\bnpm\s+(ci|install|i)\b/.test(command)) return `added ${n(120, 900)} packages, and audited ${n(900, 1200)} packages in ${n(3, 20)}s\n\nfound 0 vulnerabilities`;
  if (/\bpip3?\s+install\b/.test(command)) return 'Successfully installed pandas-2.2.3 numpy-2.1.3 python-dateutil-2.9.0';
  if (/docker\s+pull/.test(command)) return '17: Pulling from library/postgres\nDigest: sha256:3f1a…\nStatus: Downloaded newer image for postgres:17';
  if (/docker\s+compose\s+up/.test(command)) return `[+] Running 2/2\n ✔ Container ${ctx.project}-db-1   Started\n ✔ Container ${ctx.project}-api-1  Started`;
  if (/^psql\b/.test(command)) return ` count\n-------\n  ${n(100, 9000)}\n(1 row)`;
  if (/^curl\b/.test(command)) return `{"status":"ok","uptime":${n(100, 99_999)}}`;
  if (/lighthouse/.test(command)) return tr('Performance: {0}\nAccessibility: {1}\nBest practices: 100\nSEO: 100', [n(85, 99), n(90, 100)]);
  if (/\b(expo\s+start|npm\s+run\s+dev)\b/.test(command)) return tr('Development server running at http://localhost:5173');
  if (/^python3?\s/.test(command)) return tr('Processed {0} records in {1}s', [n(500, 20_000), secs]);
  return tr('✓ Command complete');
}

// ------------------------------------------------------------------ activities → entries

/** Tool call followed by result. */
function call(out: TerminalEntry[], a: Activity, tool: string, title: string, result: string, input?: Pick<ToolEntry, 'input' | 'inputKind'>): void {
  const id = `${a.id}:t`;
  const entry: ToolEntry = { kind: 'tool', id, at: a.at, tool, title };
  if (input?.input) Object.assign(entry, input);
  out.push(entry, { kind: 'result', id: `${a.id}:r`, at: a.at, toolUseId: id, text: result });
}

/** Activity text after prefix ("Shell finished: x" → "x"). */
const afterColon = (s: string) => s.replace(/^[^:]*:\s*/, '');
const quoted = (s: string) => /“(.+)”/.exec(s)?.[1];

/** Command launched in background: same batch (same timestamp) brings "Waiting on shell" bubble. */
function isBackground(i: number, ctx: Ctx): boolean {
  const at = ctx.history[i].at;
  for (let k = i + 1; k < ctx.history.length && ctx.history[k].at === at; k++) {
    if (ctx.history[k].tool === SHELL_WAIT_TOOL) return true;
  }
  return false;
}

function shellCall(out: TerminalEntry[], a: Activity, i: number, command: string, seed: number, ctx: Ctx, output?: string): void {
  const bg = isBackground(i, ctx);
  const result = bg
    ? ctx.codex
      ? tr('Command running in the background (session {0}).', [num(seed, 1000, 9999)])
      : tr("Command running in the background (id b{0}). You'll be notified when it finishes.", [hex(seed)])
    : (output ?? commandOutput(command, seed, ctx));
  const firstLine = command.split('\n')[0];
  const tool = ctx.codex ? 'Shell' : 'Bash';
  call(out, a, tool, `${tool}(${firstLine}${command.includes('\n') ? ' …' : ''})`, result, { input: command, inputKind: 'command' });
}

/** Codex: apply_patch edit (the patch is what gets approved) and its response. */
function patchCall(out: TerminalEntry[], a: Activity, file: string, lines: readonly string[], add: boolean): void {
  const result = `Success. Updated the following files:\n${add ? 'A' : 'M'} ${file}`;
  call(out, a, 'apply_patch', `apply_patch(${file})`, result, { input: demoPatchText(file, lines, add), inputKind: 'diff' });
}

function entriesFor(a: Activity, i: number, ctx: Ctx, out: TerminalEntry[]): void {
  const seed = hash32(a.id);
  const detail = a.detail?.trim();
  if (a.tool === SHELL_DONE_TOOL) {
    // Activity label comes truncated (≤ 46 chars): command (detail) provides more.
    const took = /\(([^)]+)\)$/.exec(a.text)?.[1];
    const label = detail ? `${detail.split('\n')[0]}${took ? ` (${took})` : ''}` : afterColon(a.text);
    const failed = a.error === true;
    out.push({
      kind: 'system',
      id: `${a.id}:s`,
      at: a.at,
      text: failed ? tr('Background task failed: {0}', [label]) : tr('Background task completed: {0}', [label]),
      level: failed ? 'warn' : 'info',
      detail: failed ? 'exit code 1' : 'exit code 0',
    });
    return;
  }
  if (a.tool === SHELL_WAIT_TOOL) {
    const what = detail ? `\`${detail.split('\n')[0]}\`` : `**${afterColon(a.text)}**`;
    out.push({ kind: 'assistant', id: `${a.id}:a`, at: a.at, text: tr("Left it running in the background: {0}. I'll be back as soon as it finishes.", [what]) });
    return;
  }
  // Message sent from office: enters conversation as a prompt from you.
  if (a.tool === MESSAGE_TOOL) {
    out.push({ kind: 'user', id: `${a.id}:u`, at: a.at, text: detail ?? a.text });
    return;
  }
  switch (a.kind) {
    case 'prompt':
      out.push({ kind: 'user', id: `${a.id}:u`, at: a.at, text: detail ?? quoted(a.text) ?? a.text });
      return;
    case 'think': {
      const text = startsWithText(a.text, tr('Thinking')) ? (seed % 3 === 0 ? undefined : pick(THOUGHTS, seed >>> 3)) : tr("The subagents are done; I'll gather what each one found.");
      out.push(text ? { kind: 'thinking', id: `${a.id}:k`, at: a.at, text } : { kind: 'thinking', id: `${a.id}:k`, at: a.at });
      return;
    }
    case 'respond':
      out.push({ kind: 'assistant', id: `${a.id}:a`, at: a.at, text: detail ?? tr('Found the source of the problem; fixing it now.') });
      return;
    case 'read': {
      if (!detail?.startsWith('/')) break;
      const file = rel(detail, ctx);
      const lines = snippet(file);
      if (ctx.codex) shellCall(out, a, i, `sed -n '1,${lines.length + 40}p' ${file}`, seed, ctx, lines.join('\n'));
      else call(out, a, 'Read', `Read(${file})`, lines.map((l, n) => `${String(n + 1).padStart(6)}\t${l}`).join('\n'));
      return;
    }
    case 'edit': {
      if (!detail?.startsWith('/')) break;
      const file = rel(detail, ctx);
      const [before, after] = editPair(file, seed);
      const lines = [...before.split('\n').map((l) => `- ${l}`), ...after.split('\n').map((l) => `+ ${l}`)];
      if (ctx.codex) patchCall(out, a, file, lines, false);
      else call(out, a, 'Edit', `Edit(${file})`, tr('File updated: {0}', [file]), { input: lines.join('\n'), inputKind: 'diff' });
      return;
    }
    case 'write': {
      if (!detail?.startsWith('/')) break;
      const file = rel(detail, ctx);
      const lines = snippet(file);
      if (ctx.codex) return patchCall(out, a, file, lines, true);
      call(out, a, 'Write', `Write(${file})`, tr('File created: {0} ({1} lines)', [file, lines.length]), { input: lines.map((l) => `+ ${l}`).join('\n'), inputKind: 'diff' });
      return;
    }
    case 'search': {
      const pattern = detail ?? quoted(a.text);
      if (!pattern) break;
      if (startsWithText(a.text, 'Looking for {0}')) {
        const ext = /\*\.(\w+)$/.exec(pattern)?.[1];
        const known = ctx.pool.filter((f) => !ext || f.endsWith(`.${ext}`));
        const found = known.length ? known : [`src/index.${ext}`, `src/app.${ext}`];
        if (ctx.codex) shellCall(out, a, i, `rg --files -g '${pattern}'`, seed, ctx, found.join('\n'));
        else call(out, a, 'Glob', `Glob(${pattern})`, found.join('\n'));
        return;
      }
      const files = pickFiles(ctx.pool, seed, 1 + (seed % 3));
      const matches = files.map((f, k) => `${f}:${num(hash32(`${a.id}:${k}`), 3, 180)}:  ${/^\w+$/.test(pattern) ? `const resultado = ${pattern}(dados);` : pattern}`);
      if (ctx.codex) shellCall(out, a, i, `rg -n ${JSON.stringify(pattern)}`, seed, ctx, matches.join('\n'));
      else call(out, a, 'Grep', `Grep(${pattern})`, matches.join('\n'), { input: '{\n  "output_mode": "content"\n}', inputKind: 'json' });
      return;
    }
    case 'run':
    case 'test':
    case 'git':
      if (!detail) break;
      shellCall(out, a, i, detail.includes(' — ') ? detail.slice(detail.lastIndexOf(' — ') + 3) : detail, seed, ctx);
      return;
    case 'web': {
      if (!detail) break;
      if (startsWithText(a.text, 'Searching the web for “{0}”')) {
        const slug = detail
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        const results = [tr('{0} — complete guide', [detail]), tr('Official documentation: {0}', [detail]), tr('Forum discussion: {0}', [detail])];
        const urls = [`https://blog.example.com/${slug}`, `https://docs.example.com/${slug}`, `https://forum.example.com/t/${slug}`];
        const tool = ctx.codex ? 'web_search' : 'WebSearch';
        call(out, a, tool, `${tool}(${detail})`, results.map((r, k) => `${k + 1}. ${r}\n   ${urls[k]}`).join('\n'));
        return;
      }
      if (/^https?:\/\//.test(detail) && ctx.codex) {
        shellCall(out, a, i, `curl -sL ${detail} | head -n 40`, seed, ctx, '<!doctype html>\n<title>Fetch API</title>\n…');
        return;
      }
      if (/^https?:\/\//.test(detail)) {
        call(out, a, 'WebFetch', `WebFetch(${detail})`, tr('The page explains the API with examples; the relevant part confirms the expected format.'), {
          input: tr('Summarize what matters for our implementation'),
          inputKind: 'text',
        });
        return;
      }
      shellCall(out, a, i, detail, seed, ctx);
      return;
    }
    case 'plan': {
      const [done = 0, total = ctx.agent.tasks.length] = (/(\d+)\/(\d+)/.exec(detail ?? '') ?? []).slice(1).map(Number);
      const list = ctx.agent.tasks.slice(0, total || undefined).map((t, k) => `${k < done ? '☒' : k === done ? '◐' : '☐'} ${t.title}`);
      const tool = ctx.codex ? 'update_plan' : 'TodoWrite';
      call(out, a, tool, total ? tr('{0}({1}/{2} done)', [tool, done, total]) : tool, ctx.codex ? 'Plan updated' : tr('Task list updated'), list.length ? { input: list.join('\n'), inputKind: 'text' } : undefined);
      return;
    }
    case 'delegate': {
      const desc = afterColon(a.text);
      const type = ctx.codex ? 'worker' : detail?.split(' — ')[0];
      const tool = ctx.codex ? 'spawn_agent' : 'Agent';
      call(out, a, tool, `${tool}(${type ? `${type}: ` : ''}${desc})`, tr('Subagents working in parallel; results arrive when they finish.'), {
        input: tr('{0}. Look into the {1} code and return a short summary with the files involved.', [desc, ctx.project]),
        inputKind: 'text',
      });
      return;
    }
    case 'wait':
      out.push({
        kind: 'system',
        id: `${a.id}:s`,
        at: a.at,
        text: startsWithText(a.text, tr('Needs you'))
          ? tr('Waiting on you: {0}', [a.text.includes(':') ? afterColon(a.text) : tr('answer in the terminal')])
          : startsWithText(a.text, tr('Interrupted by you'))
            ? tr('Interrupted by user')
            : a.text,
        level: 'warn',
      });
      return;
    case 'done': {
      const text = ctx.agent.kind === 'sub' && ctx.agent.title ? tr('Delivered: {0}. Summary sent to the main agent.', [ctx.agent.title]) : pick(SUMMARIES, seed);
      out.push({ kind: 'assistant', id: `${a.id}:a`, at: a.at, text });
      const took = /Done in (.+)$/.exec(a.text)?.[1];
      if (took) out.push({ kind: 'system', id: `${a.id}:s`, at: a.at, text: tr('Turn completed in {0}', [took]), level: 'info' });
      return;
    }
    case 'error':
      out.push({ kind: 'system', id: `${a.id}:s`, at: a.at, text: a.text, level: 'error', ...(detail ? { detail } : {}) });
      return;
    case 'compact':
      out.push({ kind: 'system', id: `${a.id}:s`, at: a.at, text: tr('Conversation compacted automatically'), level: 'info' });
      return;
    default:
      break;
  }
  // Anything else: a generic tool with detail as argument.
  const tool = a.tool ?? TOOL_BY_KIND[a.kind] ?? tr('Tool');
  call(out, a, tool, detail ? `${tool}(${detail.split('\n')[0]})` : tool, tr('✓ Done'));
}

const TOOL_BY_KIND: Partial<Record<Activity['kind'], string>> = {
  communicate: 'SendMessage',
  ask: 'AskUserQuestion',
  skill: 'Skill',
  browser: 'playwright - browser_navigate (MCP)',
  mcp: 'MCP',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  search: 'Grep',
  run: 'Bash',
  test: 'Bash',
  git: 'Bash',
  web: 'WebFetch',
};

/** Fictional demo agent conversation (from oldest to newest). */
export function demoTerminalEntries(agent: AgentInfo, history: Activity[]): TerminalEntry[] {
  const slash = agent.roomId.indexOf('/');
  const root = slash >= 0 ? agent.roomId.slice(slash).replace(/\/+$/, '') : '';
  const project = root.replace(/^.*\//, '') || 'projeto';
  const ctx: Ctx = { agent, history, root, project, pool: poolFor(project), codex: agent.provider === 'codex' };
  const out: TerminalEntry[] = [];
  // Without any activity yet, title (the task) opens conversation. After that, prompts come from
  // activities themselves: an id tied to history would change when it slides and reappear at the end.
  if (!history.length && agent.title) out.push({ kind: 'user', id: `${agent.id}:titulo:${hash32(agent.title).toString(36)}`, at: agent.startedAt, text: agent.title });
  history.forEach((a, i) => entriesFor(a, i, ctx, out));
  return out;
}
