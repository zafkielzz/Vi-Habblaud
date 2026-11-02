// Translation of Claude Code tool calls into readable activities (EN).
// Pure code, used by the server (real transcripts) and the demo simulator.
import type { ActivityKind, AskQuestion } from './types';
import { getLocale, tr } from './i18n';

export interface ActivityDescription {
  kind: ActivityKind;
  icon: string;
  text: string;
  detail?: string;
  questions?: AskQuestion[];
}

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;

/** Questions from an AskUserQuestion to display in the office (masked and truncated like the rest). */
function askQuestions(raw: unknown): AskQuestion[] {
  const clean = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? truncate(maskSecrets(v.slice(0, n * 4)), n) : '');
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';
  // Positions match the original (including invalid entries): office answers are indexed by them.
  const qs = Array.isArray(raw) ? raw.slice(0, MAX_QUESTIONS) : [];
  return qs.flatMap((q, index) => {
    if (!obj(q)) return [];
    const question = clean(q.question, 300);
    if (!question) return [];
    const opts = Array.isArray(q.options) ? q.options.slice(0, MAX_OPTIONS) : [];
    const options = opts.flatMap((o, index) => {
      if (!obj(o)) return [];
      const label = clean(o.label, 80);
      if (!label) return [];
      const description = clean(o.description, 200);
      return [{ index, label, ...(description ? { description } : {}) }];
    });
    const header = clean(q.header, 30);
    return [{ index, question, ...(header ? { header } : {}), ...(q.multiSelect === true ? { multiSelect: true } : {}), options }];
  });
}

const MAX_TEXT = 46;
const MAX_DETAIL = 300;

/** Collapses spaces/newlines and truncates with ellipsis. */
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, Math.max(1, n - 1)).trimEnd()}…` : one;
}

export function basename(p: string): string {
  const clean = p.replace(/[\\/]+$/, '');
  const i = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  return i >= 0 ? clean.slice(i + 1) : clean;
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return truncate(url, 30);
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function make(kind: ActivityKind, icon: string, text: string, detail?: string): ActivityDescription {
  // Masks before truncating (a secret cut in half would leak its beginning); pre-slicing only
  // avoids running regexes on huge heredocs.
  return {
    kind,
    icon,
    text: truncate(maskSecrets(text.slice(0, MAX_TEXT * 8)), MAX_TEXT),
    ...(detail ? { detail: truncate(maskSecrets(detail.slice(0, MAX_DETAIL * 4)), MAX_DETAIL) } : {}),
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|heic)$/i;

// ------------------------------------------------------------------ secrets

/**
 * Patterns of secrets masked in texts and details (commands, prompts, replies, errors).
 * Details go to browser and feed: a token pasted into `curl` must not appear there.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Private key blocks (PEM).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, tr('[private key]')],
  // Headers with credentials: Authorization, Cookie, X-Api-Key...
  [/\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|private-token)(\s*:\s*)[^'"\n]+/gi, '$1$2***'],
  // Loose Bearer/Basic/Token <value>.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, '$1 ***'],
  // URL with user:password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/'"]+:)[^\s@/'"]+@/gi, '$1***@'],
  // Webhook: keep host, strip path with secret.
  [/(\bhttps?:\/\/hooks\.slack\.com\/services\/)T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/gi, '$1***'],
  [/(\bhttps?:\/\/(?:discordapp|discord)\.com\/api\/webhooks\/)\d+\/[A-Za-z0-9_-]+/gi, '$1***'],
  [/(\bhttps?:\/\/api\.telegram\.org\/bot)\d+:[A-Za-z0-9_-]+/gi, '$1***'],
  // curl -u user:password / --user user:password.
  [/((?:^|\s)(?:-u|--user)\s+['"]?[^\s:'"]+:)[^\s'"]+/g, '$1***'],
  // --token X, --password=X, --api-key X...
  [/((?:^|\s)--?(?:token|password|passwd|pass|secret|api-key|apikey|access-token|auth-token)(?:\s+|=))(['"]?)[^\s'"]+\2/gi, '$1$2***$2'],
  // SENSITIVE_NAME=value / "password": "value" (GITHUB_TOKEN, DB_PASSWORD, client_secret, api_key...).
  [
    /\b([A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|_key|credentials?))(["']?\s*[=:]\s*)(["']?)([^\s"'&;|,}]+)\3/gi,
    '$1$2$3***$3',
  ],
  // Keys with known prefix.
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}/g, 'sk-***'],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, 'github_pat_***'],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, 'glpat-***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{8,}/g, 'xox*-***'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g, 'sk_***'],
  // Loose npm and Hugging Face tokens (real token length; "npm test" and "hf" remain).
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_***'],
  [/\bhf_[A-Za-z0-9]{30,}/g, 'hf_***'],
  // JWT.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***'],
];

/** Masks common secrets (tokens, passwords, keys) in freeform text. */
export function maskSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

// ------------------------------------------------------------------ shell

/**
 * Splits into words like shell (quotes and backslashes), without expanding anything. Substitutions
 * `$(...)` and `` `...` `` stay intact inside word (e.g. `NOW=$(date +%s)` is a single word).
 */
export function shellWords(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  let depth = 0;
  let tick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
      continue;
    }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (c === '`') {
      tick = !tick;
      cur += c;
      has = true;
    } else if (c === '$' && s[i + 1] === '(') {
      depth++;
      cur += '$(';
      i++;
      has = true;
    } else if (depth && c === '(') {
      depth++;
      cur += c;
    } else if (depth && c === ')') {
      depth--;
      cur += c;
    } else if (/\s/.test(c) && !depth && !tick) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** Splits a line on top-level operators (`|`, `||`, `&&`, `;`, `&`), outside quotes and subshells. */
export function splitShell(line: string): string[] {
  const segs: string[] = [];
  let start = 0;
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q !== "'") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      q = c;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth) continue;
    let len = 0;
    if ((c === '&' && line[i + 1] === '&') || (c === '|' && line[i + 1] === '|')) len = 2;
    else if (c === '|' || c === ';') len = 1;
    else if (c === '&' && line[i - 1] !== '>' && line[i - 1] !== '<' && line[i + 1] !== '>') len = 1;
    if (!len) continue;
    segs.push(line.slice(start, i));
    i += len - 1;
    start = i + 1;
  }
  segs.push(line.slice(start));
  return segs.map((s) => s.trim()).filter(Boolean);
}

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
/**
 * Prefixes that only modify how command runs (real command follows), along with flags for each
 * that take a separate argument (e.g. `nice -n 10`, `npx -p pkg`, `sudo -u user`).
 */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-p', '-C', '-h', '-U']),
  time: new Set(),
  nohup: new Set(),
  exec: new Set(['-a']),
  builtin: new Set(),
  nice: new Set(['-n']),
  caffeinate: new Set(['-t', '-w']),
  stdbuf: new Set(),
  unbuffer: new Set(),
  command: new Set(),
  npx: new Set(['-p', '--package', '-c', '--call']),
  bunx: new Set(['-p', '--package']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir']),
};

/** Strips assignments (`X=1`), wrappers (`nohup`, `npx -y`, `timeout 30`...) and returns real command. */
function stripWrappers(words: string[]): string[] {
  let w = words.slice();
  for (let guard = 0; guard < 12 && w.length; guard++) {
    const head = w[0];
    if (ASSIGN.test(head)) {
      w = w.slice(1);
      continue;
    }
    if (head === '(' || head === '{' || head === '!') {
      w = w.slice(1);
      continue;
    }
    if (head === 'command' && (w[1] === '-v' || w[1] === '-V')) break;
    if (head === 'timeout' || head === 'gtimeout') {
      let i = 1;
      while (i < w.length && w[i].startsWith('-')) i += w[i] === '-s' || w[i] === '-k' ? 2 : 1;
      w = w.slice(i + 1);
      continue;
    }
    if ((head === 'pnpm' || head === 'yarn') && (w[1] === 'dlx' || w[1] === 'exec')) {
      w = w.slice(2);
      continue;
    }
    if (head === 'npm' && w[1] === 'exec') {
      w = w.slice(2);
      continue;
    }
    const valued = Object.hasOwn(WRAPPERS, head) ? WRAPPERS[head] : undefined;
    // Wrapper alone (`env`, `time`) is the command itself.
    if (!valued || w.length === 1) break;
    let i = 1;
    while (i < w.length && w[i].startsWith('-') && w[i] !== '--') i += valued.has(w[i]) ? 2 : 1;
    if (w[i] === '--') i++;
    w = w.slice(i);
  }
  while (w.length && /^[)}]$/.test(w[w.length - 1])) w = w.slice(0, -1);
  return w;
}

/** File receiving stdout (`> file`, `>>file`, `1> file`), if any. */
function stdoutTarget(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const m = /^1?(>>?)(.*)$/.exec(args[i]);
    if (m) return m[2] || args[i + 1];
  }
  return undefined;
}

/** Segment that does not describe what agent is doing (setup): `cd`, `X=1`, `set -e`, `sleep 2`, `echo`... */
function isNoise(words: string[]): boolean {
  if (!words.length) return true;
  const [head] = words;
  if (words.every((x) => ASSIGN.test(x))) return true;
  if (head === 'export' || head === 'unset' || head === 'local' || head === 'readonly') return words.slice(1).every((x) => ASSIGN.test(x) || /^[A-Za-z_]\w*$/.test(x) || x.startsWith('-'));
  if ((head === 'echo' || head === 'printf') && stdoutTarget(words.slice(1))) return false;
  return /^(cd|pushd|popd|set|shopt|source|\.|true|false|:|trap|ulimit|umask|clear|sleep|echo|printf|do|done|then|fi|else|esac)$/.test(head);
}

/** Words representing redirections (and their target, when separated) are stripped from argument list. */
function withoutRedirects(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\d*(?:>>?|<<?<?|>&|&>)$/.test(a)) {
      i++;
      continue;
    }
    if (/^\d*(?:>>?|<<?<?|>&|&>)/.test(a)) continue;
    out.push(a);
  }
  return out;
}

/** Positional arguments, skipping flags (and value of flags listed in `valued`). */
function positionals(args: string[], valued: ReadonlySet<string> = new Set()): string[] {
  const out: string[] = [];
  const clean = withoutRedirects(args);
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i];
    if (a === '--') {
      out.push(...clean.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valued.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const looksLikeFile = (t: string) => !!t && !t.includes('$') && !/^\d+$/.test(t) && t !== '-';

/** "a.ts", "a.ts and b.ts", "a.ts and 3 more" (or undefined if no readable file). */
function filesLabel(files: string[]): string | undefined {
  const names = files.filter(looksLikeFile).map((f) => basename(f) || f);
  if (!names.length) return undefined;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} e ${names[1]}`;
  return tr('{0} and {1} more', [names[0], names.length - 1]);
}

const GREP_VALUED = new Set(['-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '--regexp', '--file', '--max-count', '--context', '--include', '--exclude', '--exclude-dir', '-g', '-t', '-T', '--glob', '--type', '--type-not', '-j', '--threads', '-M', '--max-columns']);
const CURL_VALUED = new Set([
  '-H', '-d', '-X', '-o', '-u', '-A', '-e', '-b', '-c', '-F', '-T', '-w', '-m', '-x', '-K', '-r', '-E', '-U', '-Y', '-y', '-z', '-P', '-Q',
  '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--json', '--request', '--output', '--user', '--user-agent',
  '--referer', '--cookie', '--cookie-jar', '--form', '--upload-file', '--write-out', '--max-time', '--connect-timeout', '--proxy',
  '--retry', '--retry-delay', '--cacert', '--cert', '--key', '--resolve', '--interface', '--limit-rate', '--range', '--config',
  // wget
  '-O', '-P', '-t', '-T', '--output-document', '--directory-prefix', '--tries', '--timeout', '--password', '--http-user', '--http-password',
]);

/** "Testing the local API (:4763/api/snapshot)" or "Calling api.github.com". */
function describeHttp(args: string[]): string {
  let target: string | undefined;
  const clean = withoutRedirects(args);
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i];
    if (a === '--url') {
      target = clean[i + 1];
      break;
    }
    if (a.startsWith('-')) {
      if (CURL_VALUED.has(a)) i++;
      continue;
    }
    if (/^(?:https?:\/\/)?(?:localhost|\[[0-9a-f:]+\]|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]\S*)?$/i.test(a)) {
      target = a;
      break;
    }
  }
  if (!target) return tr('Making an HTTP request');
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
  } catch {
    return tr('Making an HTTP request');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || /^127\./.test(host)) {
    const path = `${url.port ? `:${url.port}` : ''}${url.pathname === '/' && !url.port ? '/' : url.pathname}`;
    return `${url.pathname.startsWith('/api') ? tr('Testing the local API') : tr('Testing the local server')} (${truncate(path, 22)})`;
  }
  return tr('Calling {0}', [host.replace(/^www\./, '')]);
}

/** Vietnamese text: has letters only Vietnamese uses (đ, ơ, ư, ă and the stacked tone marks). */
export function looksVietnamese(s: string): boolean {
  return /[đơưăạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹỵ]/i.test(s);
}

/** The Bash `description` becomes the activity text only when it is in the server language. */
export function inServerLanguage(s: string): boolean {
  return getLocale() === 'vi' ? looksVietnamese(s) : !looksVietnamese(s);
}

const LANG: Record<string, string> = { node: 'Node', python: 'Python', python3: 'Python', ruby: 'Ruby', php: 'PHP', deno: 'Deno', bun: 'Bun', tsx: 'TypeScript', 'ts-node': 'TypeScript', perl: 'Perl' };

const GIT_TEXT: Record<string, [string, string]> = {
  commit: ['📦', tr('Committing')],
  push: ['🚀', tr('Pushing commits (git push)')],
  pull: ['⬇️', tr('Pulling from remote (git pull)')],
  fetch: ['⬇️', tr('Fetching from remote (git fetch)')],
  checkout: ['🌿', tr('Switching branches')],
  switch: ['🌿', tr('Switching branches')],
  merge: ['🔀', tr('Merging')],
  rebase: ['🔀', tr('Rebasing')],
  status: ['🌿', tr('Checking git status')],
  diff: ['🌿', tr('Reviewing changes (diff)')],
  show: ['🌿', tr('Looking at a commit (git show)')],
  log: ['🌿', tr('Reading git history')],
  add: ['🌿', tr('Staging files (git add)')],
  stash: ['🌿', tr('Stashing changes (stash)')],
  clone: ['⬇️', tr('Cloning a repository')],
  branch: ['🌿', tr('Checking branches')],
  worktree: ['🌿', tr('Working with worktrees')],
  reset: ['🌿', tr('Undoing changes (git reset)')],
  restore: ['🌿', tr('Restoring files (git restore)')],
  tag: ['🏷️', tr('Working with tags')],
  blame: ['🌿', tr('Seeing who changed each line')],
  'cherry-pick': ['🍒', tr('Picking a commit (cherry-pick)')],
};

const READER_VALUED: Record<string, ReadonlySet<string>> = {
  head: new Set(['-n', '-c', '--lines', '--bytes']),
  tail: new Set(['-n', '-c', '-s', '--lines', '--bytes']),
  sed: new Set(['-e', '-f', '-l']),
  gsed: new Set(['-e', '-f', '-l']),
  awk: new Set(['-F', '-v', '-f']),
  gawk: new Set(['-F', '-v', '-f']),
  jq: new Set(['-f', '--indent', '--tab']),
  sort: new Set(['-k', '-t', '-o', '-S', '-T']),
  cut: new Set(['-d', '-f', '-c', '-b']),
  column: new Set(['-s', '-c', '-o']),
  bat: new Set(['-l', '--language', '-r', '--line-range', '-H', '--highlight-line', '--style']),
  less: new Set(['-p', '-x', '-y', '-z']),
};

/** Describes command without wrappers. undefined = unrecognized. */
function describeWords(w: string[], depth: number): ActivityDescription | undefined {
  if (!w.length) return undefined;
  const prog = basename(w[0]);
  const args = w.slice(1);
  const text = w.join(' ');
  const mk = (kind: ActivityKind, icon: string, t: string) => make(kind, icon, t);

  if (/\b(vitest|jest|pytest|phpunit|mocha|ava|rspec)\b|\b(go|cargo|deno|bun)\s+test\b|playwright\s+test|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|-m\s+(pytest|unittest)\b/.test(text)) {
    return mk('test', '🧪', tr('Running tests'));
  }
  if (prog === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += args[i] === '-C' || args[i] === '-c' ? 2 : 1;
    const sub = args[i] ?? '';
    const [icon, t] = GIT_TEXT[sub] ?? ['🌿', sub ? `git ${sub}` : tr('Using git')];
    return mk('git', icon, t);
  }
  if (prog === 'gh') return mk('git', '🐙', tr('GitHub CLI: gh {0}', [args.slice(0, 2).join(' ')]).trim());
  if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcomposer\s+(install|require)\b|\bpoetry\s+(add|install)\b|\bcargo\s+add\b|\bgo\s+get\b|\buv\s+(add|sync|pip\s+install)\b/.test(text)) {
    return mk('run', '📦', tr('Installing dependencies'));
  }
  if ((prog === 'tsc' && args.includes('--noEmit')) || /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(typecheck|type-check|check-types)\b/.test(text)) {
    return mk('run', '🔍', tr('Checking types (TypeScript)'));
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bvite\s+build\b|^tsc\b|\bwebpack\b|\bcargo\s+build\b|\bgo\s+build\b|^make\b|\bgradle\b|\bmvn\b|\besbuild\b|\brollup\b/.test(text)) {
    return mk('run', '🏗️', tr('Building the project'));
  }
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview)\b|^vite(\s|$)(?!build)|^(next|nuxt|astro)\s+dev\b|^expo\s+start\b|^nodemon\b|^tsx\s+watch\b/.test(text)) {
    return mk('run', '▶️', /\bpreview\b/.test(text) ? tr('Starting the build preview') : tr('Starting the dev server'));
  }
  if (/\b(eslint|prettier|ruff|black|biome|rubocop|phpcs|stylelint|oxlint)\b|\b(npm|pnpm|yarn)\s+(run\s+)?(lint|format)\b/.test(text)) {
    return mk('run', '🧹', tr('Running the linter'));
  }
  if (/^(npm|pnpm|yarn|bun)$/.test(prog) && args[0] === 'run' && args[1]) return mk('run', '▶️', tr('Running script {0}', [args[1]]));
  if (prog === 'docker' || prog === 'docker-compose') return mk('run', '🐳', tr('Docker: {0}', [args.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ')]).trim());
  if (/^(kubectl|helm|terraform|aws|gcloud|az|flyctl|fly|vercel|wrangler|netlify|railway)$/.test(prog)) return mk('run', '☁️', tr('Working in the cloud ({0})', [prog]));
  if (/^(curl|wget|http|https|xh)$/.test(prog)) return mk('web', '🌐', describeHttp(args));
  if (/^(psql|mysql|sqlite3|redis-cli|mongosh|mongo|duckdb)$/.test(prog)) return mk('run', '🗄️', tr('Querying the database'));
  if (/^(rg|grep|egrep|fgrep|ag|ack|git-grep)$/.test(prog)) {
    const e = args.findIndex((a) => a === '-e' || a === '--regexp');
    const pat = e >= 0 ? args[e + 1] : positionals(args, GREP_VALUED)[0];
    const shown = pat?.replace(/\\\|/g, ' | ').replace(/\\([.()[\]{}+?*^$])/g, '$1');
    return mk('search', '🔎', shown ? tr('Searching for “{0}”', [truncate(shown, 24)]) : tr('Searching the code'));
  }
  if (/^(ls|find|tree|fd|du|df|eza|exa)$/.test(prog)) return mk('read', '📂', tr('Exploring folders'));
  if (prog === 'cd' || prog === 'pushd') return mk('read', '📂', tr('Changing folders'));
  if (prog === 'cat' || prog === 'tee' || prog === 'echo' || prog === 'printf') {
    // `cat > file <<EOF`, `cat <<'EOF' >> file`, `echo x > file`, `tee [-a] file`: writing.
    const written = prog === 'tee' ? positionals(args)[0] : stdoutTarget(args);
    if (written && looksLikeFile(written) && written !== '/dev/null') return mk('write', '📝', tr('Writing {0}', [basename(written)]));
    if (prog === 'tee') return mk('write', '📝', tr('Writing a file'));
    if (prog !== 'cat') return mk('run', '💬', tr('Printing text to the terminal'));
  }
  if (/^(sed|gsed|perl)$/.test(prog) && args.some((a) => /^-i|^--in-place|^-pi/.test(a))) {
    const last = positionals(args, new Set(['-e', '-f'])).pop();
    return mk('edit', '✏️', last && looksLikeFile(last) && /[./]/.test(last) ? tr('Editing {0}', [basename(last)]) : tr('Editing via the terminal'));
  }
  if (/^(cat|head|tail|less|more|bat|nl|sed|gsed|awk|gawk|jq|wc|strings|xxd|od|hexdump|column|sort|uniq|cut)$/.test(prog)) {
    // jq --arg name value: two values.
    const jqArgs = prog === 'jq' ? args.filter((_, i) => !/^--(arg|argjson|slurpfile|rawfile)$/.test(args[i - 1] ?? '') && !/^--(arg|argjson|slurpfile|rawfile)$/.test(args[i - 2] ?? '')) : args;
    let files = positionals(jqArgs, READER_VALUED[prog]);
    // sed/awk/jq: first positional is program/filter, not a file.
    if (/^(sed|gsed|awk|gawk|jq)$/.test(prog) && !args.includes('-e') && !args.includes('-f')) files = files.slice(1);
    const label = filesLabel(files);
    if (prog === 'wc') {
      const n = files.filter(looksLikeFile).length;
      return mk('read', '🔢', n > 2 ? tr('Counting lines in {0} files', [n]) : label ? tr('Counting lines in {0}', [label]) : tr('Counting lines'));
    }
    if (prog === 'tail' && args.some((a) => a === '-f' || a === '-F')) return mk('read', '📜', label ? tr('Following {0}', [label]) : tr('Following a log'));
    if (prog === 'jq' && !label) return mk('read', '🔎', tr('Filtering JSON'));
    if (/^(sort|uniq|cut|column)$/.test(prog) && !label) return undefined;
    return mk('read', '📖', label ? tr('Reading {0}', [label]) : tr('Reading a file'));
  }
  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|rsync|tar|zip|unzip|gzip|gunzip|xattr)$/.test(prog)) return mk('run', '🗂️', tr('Organizing files'));
  if (prog === 'sleep' || prog === 'wait') return mk('wait', '⏳', tr('Waiting a bit'));
  if (prog === 'open' || prog === 'xdg-open') return mk('run', '🖥️', tr('Opening on the computer'));
  if (/^(code|cursor|subl|vim|nvim|nano|emacs)$/.test(prog)) return mk('edit', '✏️', tr('Opening in the editor'));
  if (/^(pkill|kill|killall)$/.test(prog)) return mk('run', '🛑', tr('Stopping a process'));
  if (prog === 'lsof') {
    const port = args.map((a) => /^(?:-i)?(?:tcp)?:(\d{2,5})$/i.exec(a)?.[1]).find(Boolean);
    return mk('run', '🔌', port ? tr("Checking who's using port {0}", [port]) : tr('Checking processes and ports'));
  }
  if (/^(ps|pgrep|top|htop|jobs)$/.test(prog)) return mk('run', '🔍', tr('Checking processes'));
  if (/^(which|whereis|type)$/.test(prog) || (prog === 'command' && /^-[vV]$/.test(args[0] ?? ''))) return mk('search', '🔎', tr('Looking for a program'));
  if (/^(diff|cmp|comm|colordiff|delta)$/.test(prog)) return mk('read', '🔀', tr('Comparing files'));
  if (prog === 'date') return mk('run', '🕒', tr('Checking the date and time'));
  if (prog === 'env' || prog === 'printenv') return mk('run', '🔍', tr('Checking environment variables'));
  if (/^(stat|file|md5|md5sum|shasum|sha256sum|realpath|readlink)$/.test(prog)) return mk('read', '🔍', tr('Checking a file'));
  if (prog === 'claude') return mk('run', '🤖', tr('Running Claude Code'));
  if (/^(pbcopy|pbpaste)$/.test(prog)) return mk('run', '📋', tr('Using the clipboard'));
  if (/^(bash|sh|zsh|fish)$/.test(prog)) {
    const c = args.indexOf('-c');
    if (c >= 0 && args[c + 1] && depth < 3) return describeLine(args[c + 1], depth + 1).desc;
    const script = positionals(args).find(looksLikeFile);
    return mk('run', '▶️', script ? tr('Running {0}', [basename(script)]) : tr('Running a shell script'));
  }
  if (/^(node|python3?|ruby|php|deno|bun|tsx|ts-node|perl|java)$/.test(prog) || (prog === 'go' && args[0] === 'run')) {
    // Ignores flags, redirects/heredocs, and inline code (-e/-c '...').
    const list = withoutRedirects(prog === 'go' ? args.slice(1) : args);
    const script = list.find((t, i) => !t.startsWith('-') && !/^-[ecpr]$|^--(eval|print|import|require|loader)$/.test(list[i - 1] ?? '') && /[./]/.test(t) && !/^\d+(\.\d+)*$/.test(t));
    if (script && !/^(-m|-c)$/.test(list[0] ?? '')) return mk('run', '▶️', tr('Running {0}', [basename(script)]));
    if (list[0] === '-m' && list[1]) return mk('run', '▶️', tr('Running module {0}', [list[1]]));
    return mk('run', '▶️', tr('Running a {0} script', [LANG[prog] ?? prog]));
  }
  if (/^(\.{0,2}\/|~\/)/.test(w[0]) || /\.(sh|bash|zsh|py|rb|mjs|js|ts)$/.test(w[0])) return mk('run', '▶️', tr('Running {0}', [prog]));
  return undefined;
}

interface LineDescription {
  desc?: ActivityDescription;
  /** Main program found (for generic text when no description exists). */
  prog?: string;
}

/** Describes first non-noise line of a shell snippet. */
function describeLine(text: string, depth: number): LineDescription {
  const lines = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.startsWith('#')) continue;
    const segs = splitShell(line);
    let main: string[] | undefined;
    let mainIdx = -1;
    for (let i = 0; i < segs.length; i++) {
      let seg = segs[i];
      // Subshell `( ... )` or entire group `{ ...; }`: inspect inside.
      if (/^\(.*\)$/.test(seg) && depth < 3) {
        const inner = describeLine(seg.slice(1, -1), depth + 1);
        if (inner.desc || inner.prog) return inner;
        continue;
      }
      seg = seg.replace(/^\{\s*/, '');
      const words = stripWrappers(shellWords(seg));
      if (isNoise(words)) continue;
      main = words;
      mainIdx = i;
      break;
    }
    if (!main) {
      // Setup only on this line (e.g. `S=/tmp/x`, `cd folder`): proceed to next — unless
      // it is the last line, then describe whatever is there (e.g. `sleep 5` alone).
      if (lines.slice(li + 1).some((l) => l.trim() && !l.trim().startsWith('#'))) continue;
      const words = stripWrappers(shellWords(segs[0] ?? ''));
      return { desc: describeWords(words, depth), prog: words[0] };
    }
    // Loops and conditionals: what matters is the body (`do ...` / `then ...`), same or next line.
    if (/^(for|while|until|if|select)$/.test(main[0]) && depth < 3) {
      const rest = segs.slice(mainIdx + 1).join('; ');
      const body = /^(?:do|then)\b\s*(.*)$/s.exec(rest.replace(/^.*?;\s*(?=(do|then)\b)/s, ''))?.[1]?.trim();
      const next = [body, ...lines.slice(li + 1)].filter((l) => l && l.trim() && !/^(done|fi|else|esac)\b/.test(l.trim())).join('\n');
      const inner = next ? describeLine(next, depth + 1) : {};
      return inner.desc ? inner : { desc: make('run', '🔁', tr('Repeating a command in batch')) };
    }
    return { desc: describeWords(main, depth), prog: main[0] };
  }
  return {};
}

/**
 * Describes a shell command (Bash tool). The heuristic looks at the first line with a real command
 * (skips `X=1`, `cd`, `set -e`, comments), the first useful segment (before `|`, `&&`, `;`) and the
 * arguments. The Bash `description` only becomes the text when it is in the server language;
 * otherwise it goes to the detail.
 */
export function describeCommand(command: string, description?: string): ActivityDescription {
  const detail = command.trim();
  let found: LineDescription = {};
  try {
    found = describeLine(detail.slice(0, 8_000), 0);
  } catch {
    found = {}; // command too complex for heuristic: falls back to generic text
  }
  if (found.desc) return make(found.desc.kind, found.desc.icon, found.desc.text, detail);
  const desc = description?.trim();
  if (desc && inServerLanguage(desc)) return make('run', '💻', desc, detail);
  const prog = basename(found.prog ?? '');
  const text = /^[A-Za-z][\w.+-]{0,23}$/.test(prog) ? tr('Running {0}', [prog]) : tr('Running a command in the terminal');
  return make('run', '💻', text, desc ? `${desc} — ${detail}` : detail);
}

function humanize(id: string): string {
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function describeMcp(name: string, input: Record<string, unknown>): ActivityDescription {
  const [, server = '', ...rest] = name.split('__');
  const tool = rest.join('__');
  const srv = server.replace(/^claude_ai_/, '');
  if (/playwright|chrome|browser|puppeteer/i.test(srv)) {
    const url = str(input.url);
    if (/navigate/.test(tool)) return make('browser', '🧭', url ? tr('Opening {0}', [domainOf(url)]) : tr('Browsing in the browser'), url);
    if (/screenshot/.test(tool)) return make('browser', '📸', tr('Taking a screenshot of the page'));
    if (/click/.test(tool)) return make('browser', '🖱️', tr('Clicking on the page'));
    if (/type|fill|form/.test(tool)) return make('browser', '⌨️', tr('Filling out a form'));
    if (/snapshot|read|get_page|find/.test(tool)) return make('browser', '🧭', tr('Reading the page'));
    return make('browser', '🧭', tr('Browser: {0}', [humanize(tool)]));
  }
  if (/github/i.test(srv)) return make('mcp', '🐙', `GitHub: ${humanize(tool)}`);
  if (/gmail|mail/i.test(srv)) return make('mcp', '✉️', `E-mail: ${humanize(tool)}`);
  if (/drive|docs|notion|confluence/i.test(srv)) return make('mcp', '📄', `${srv}: ${humanize(tool)}`);
  if (/sql|postgres|mysql|mongo|elastic|redis|db/i.test(srv)) return make('mcp', '🗄️', tr('Database ({0}): {1}', [srv, humanize(tool)]));
  return make('mcp', '🔌', `${srv}: ${humanize(tool)}`);
}

/** Describes a Claude Code tool call. */
export function describeTool(name: string, rawInput: unknown): ActivityDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const file = str(input.file_path) || str(input.notebook_path) || str(input.path);

  switch (name) {
    case 'Read':
      if (IMAGE_EXT.test(file)) return make('read', '🖼️', tr('Looking at {0}', [basename(file)]), file);
      if (/\.pdf$/i.test(file)) return make('read', '📕', tr('Reading {0}', [basename(file)]), file);
      return make('read', '📖', file ? tr('Reading {0}', [basename(file)]) : tr('Reading a file'), file);
    case 'Edit':
    case 'MultiEdit':
      return make('edit', '✏️', file ? tr('Editing {0}', [basename(file)]) : tr('Editing a file'), file);
    case 'Write':
      return make('write', '📝', file ? tr('Writing {0}', [basename(file)]) : tr('Writing a file'), file);
    case 'NotebookEdit':
      return make('edit', '📓', tr('Editing notebook {0}', [basename(file)]), file);
    case 'Glob':
      return make('search', '🔎', tr('Looking for {0}', [truncate(str(input.pattern) || tr('files'), 30)]), str(input.pattern));
    case 'Grep': {
      const pat = str(input.pattern);
      return make('search', '🔎', pat ? tr('Searching for “{0}”', [truncate(pat, 26)]) : tr('Searching the code'), pat);
    }
    case 'LS':
      return make('read', '📂', tr('Listing {0}', [basename(file) || tr('folder')]), file);
    case 'Bash':
      return describeCommand(str(input.command), str(input.description));
    case 'BashOutput':
    case 'TaskOutput':
      return make('run', '📟', tr('Checking terminal output'));
    case 'Monitor':
      return make('run', '📟', tr('Monitoring a process'), str(input.description) || str(input.command));
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return make('run', '🛑', tr('Stopping a process'));
    case 'WebSearch': {
      const q = str(input.query);
      return make('web', '🌐', q ? tr('Searching the web for “{0}”', [truncate(q, 28)]) : tr('Searching the web'), q);
    }
    case 'WebFetch': {
      const url = str(input.url);
      return make('web', '🌐', url ? tr('Reading {0}', [domainOf(url)]) : tr('Reading a page'), url);
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos.filter((t): t is Record<string, unknown> => !!t && typeof t === 'object') : [];
      const done = todos.filter((t) => t.status === 'completed').length;
      return make('plan', '🗒️', tr('Updating the task list'), todos.length ? tr('{0}/{1} done', [done, todos.length]) : undefined);
    }
    case 'TaskCreate':
      return make('plan', '🗒️', tr('New task: {0}', [str(input.subject) || tr('untitled')]), str(input.description));
    case 'TaskUpdate': {
      const st = str(input.status);
      if (st === 'completed') return make('plan', '✅', tr('Completed task #{0}', [str(input.taskId)]));
      if (st === 'in_progress') return make('plan', '🗒️', tr('Started task #{0}', [str(input.taskId)]));
      return make('plan', '🗒️', tr('Updating task #{0}', [str(input.taskId)]));
    }
    case 'TaskList':
    case 'TaskGet':
      return make('plan', '🗒️', tr('Reviewing tasks'));
    case 'EnterPlanMode':
      return make('plan', '🧭', tr('Entering plan mode'));
    case 'ExitPlanMode':
      return make('plan', '🧭', tr('Presenting the plan'));
    case 'Agent':
    case 'Task': {
      const d = str(input.description);
      const type = str(input.subagent_type);
      return make('delegate', '👥', d ? tr('Delegating: {0}', [d]) : tr('Calling a subagent'), [type, str(input.prompt)].filter(Boolean).join(' — '));
    }
    case 'Workflow':
      return make('delegate', '🕸️', tr('Orchestrating a workflow'));
    case 'StructuredOutput':
      return make('communicate', '📤', tr('Delivering the result'));
    case 'ListAgents':
      return make('communicate', '👥', tr('Checking on the team'));
    case 'SendMessage':
      return make('communicate', '💬', tr('Message to {0}', [str(input.to) || tr('another agent')]), str(input.message));
    case 'AskUserQuestion': {
      const qs = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
      const questions = askQuestions(qs);
      return { ...make('ask', '❓', tr('Asking you a question'), qs[0] ? str(qs[0].question) : undefined), ...(questions.length ? { questions } : {}) };
    }
    case 'Skill':
      return make('skill', '🧩', tr('Using the {0} skill', [str(input.skill) || str(input.command)]));
    case 'SlashCommand':
      return make('skill', '⌨️', tr('Running {0}', [str(input.command)]));
    case 'ToolSearch':
      return make('other', '🧰', tr('Looking for tools'));
    case 'ListMcpResourcesTool':
    case 'ReadMcpResourceTool':
      return make('mcp', '🔌', tr('Reading MCP resources'));
    case 'Artifact':
      return make('other', '🖼️', tr('Publishing a page'));
    case 'ArtifactData':
    case 'ArtifactComments':
      return make('other', '🖼️', tr('Updating a published page'));
    case 'CronCreate':
    case 'CronDelete':
    case 'CronList':
    case 'ScheduleWakeup':
    case 'RemoteTrigger':
      return make('plan', '⏰', tr('Scheduling a task'));
    case 'EnterWorktree':
    case 'ExitWorktree':
      return make('git', '🌿', tr('Switching worktrees'));
    case 'PushNotification':
    case 'SendUserFile':
      return make('communicate', '📣', tr('Sending you something'));
    default:
      if (name.startsWith('mcp__')) return describeMcp(name, input);
      return make('other', '🛠️', tr('Using {0}', [name]));
  }
}

/** Activity for a user prompt. */
export function describePrompt(text: string): ActivityDescription {
  return make('prompt', '📨', tr('New task: “{0}”', [truncate(text, 30)]), text);
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}min` : ''}`;
}

// ------------------------------------------------------------------ shells (waiting on commands)

/** Marker (Activity.tool) for background shell completion: celebrates (or laments on `error`). */
export const SHELL_DONE_TOOL = 'ShellDone';
/** Marker (Activity.tool) for "Waiting on shell" bubble, synthesized while status is 'shell'. */
export const SHELL_WAIT_TOOL = 'ShellWait';

/** How a background shell completed. */
export type ShellOutcome = 'ok' | 'failed' | 'killed';

/** Activity with tool marker (can be spread into `Activity` via `...desc`). */
export type MarkedDescription = ActivityDescription & { tool: string; error?: boolean };

/**
 * Label (≤ 46 chars) and command (≤ 300) of a Bash/Monitor agent will wait on, pre-masked.
 * Label is tool `description`; if absent, command summary ("Running tests").
 */
export function describeShellJob(name: string, rawInput: unknown): { label: string; command?: string; kind: 'shell' | 'monitor' } {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  const kind = name === 'Monitor' ? 'monitor' : 'shell';
  const ws = input.ws && typeof input.ws === 'object' ? str((input.ws as Record<string, unknown>).url) : '';
  const command = str(input.command).trim() || ws.trim();
  const description = str(input.description).trim();
  let label: string;
  if (description) label = truncate(maskSecrets(description.slice(0, MAX_TEXT * 8)), MAX_TEXT);
  else if (kind === 'monitor') label = ws ? tr('Listening to {0}', [domainOf(ws)]) : tr('Monitoring a process');
  else label = command ? describeCommand(command).text : tr('Terminal command');
  const out: { label: string; command?: string; kind: 'shell' | 'monitor' } = { label, kind };
  if (command) out.command = truncate(maskSecrets(command.slice(0, MAX_DETAIL * 4)), MAX_DETAIL);
  return out;
}

/** "<prefix><label><suffix>" fitting within MAX_TEXT: only label is truncated (duration preserved). */
function fitLabel(prefix: string, label: string | undefined, suffix = ''): string {
  if (!label) return `${prefix.replace(/:\s*$/, '')}${suffix}`;
  const room = Math.max(8, MAX_TEXT - prefix.length - suffix.length);
  return `${prefix}${truncate(label, room)}${suffix}`;
}

export const SPECIAL = {
  think: (): ActivityDescription => make('think', '💭', tr('Thinking…')),
  respond: (text?: string): ActivityDescription => make('respond', '💬', tr('Writing the reply'), text),
  turnDone: (ms?: number): ActivityDescription => make('done', '✅', ms ? tr('Done in {0}', [formatDuration(ms)]) : tr('Done')),
  error: (tool?: string, detail?: string): ActivityDescription => make('error', '⚠️', tool ? tr('Error in {0}', [tool]) : tr('Something went wrong'), detail),
  interrupted: (): ActivityDescription => make('wait', '✋', tr('Interrupted by you')),
  compact: (): ActivityDescription => make('compact', '🧹', tr('Tidying up memory (compacting)')),
  waiting: (reason?: string): ActivityDescription => make('wait', '✋', reason ? tr('Needs you: {0}', [reason]) : tr('Needs you')),
  backgroundResult: (summary?: string): ActivityDescription => make('other', '📬', tr('Got a background result'), summary),
  apiRetry: (): ActivityDescription => make('wait', '🔁', tr('API hiccup, retrying')),
  rejected: (tool?: string): ActivityDescription => make('wait', '🚫', tool ? tr('You denied: {0}', [tool]) : tr('You denied the action')),
  cleared: (): ActivityDescription => make('compact', '🧽', tr('Started a new conversation (/clear)')),
  supervising: (): ActivityDescription => make('delegate', '👥', tr('Keeping an eye on subagents')),
  answered: (question?: string): ActivityDescription => make('ask', '💬', tr('Got your answer'), question),
  /** Bubble for 'shell' status: "Waiting on shell: <label>" (or "Waiting on 2 shells: ..."). */
  waitingShell: (label?: string, n = 1, detail?: string): MarkedDescription => ({
    ...make('wait', '⏳', fitLabel(n > 1 ? tr('Waiting on {0} shells: ', [n]) : tr('Waiting on shell: '), label), detail),
    tool: SHELL_WAIT_TOOL,
  }),
  /**
   * Background shell completion ('ShellDone' marker): success "Shell finished: <label> (<duration>)",
   * failure "Shell failed: <label>" and killed "Shell interrupted: <label>" (both with `error`).
   */
  shellDone: (label: string | undefined, outcome: ShellOutcome, ms?: number, detail?: string): MarkedDescription => {
    if (outcome === 'failed') return { ...make('run', '❌', fitLabel(tr('Shell failed: '), label), detail), tool: SHELL_DONE_TOOL, error: true };
    if (outcome === 'killed') return { ...make('run', '🛑', fitLabel(tr('Shell interrupted: '), label), detail), tool: SHELL_DONE_TOOL, error: true };
    const took = ms !== undefined && ms >= 1_000 ? ` (${formatDuration(ms)})` : '';
    return { ...make('run', '✅', fitLabel(tr('Shell finished: '), label, took), detail), tool: SHELL_DONE_TOOL };
  },
} as const;

/** Translates `waitingFor` from Claude Code session registry. */
export function describeWaitingFor(raw: string | undefined): string {
  if (!raw) return tr('answer in the terminal');
  const r = raw.toLowerCase();
  if (r === 'input needed') return tr('answer a question');
  if (r === 'worker request') return tr("approve a worker's request");
  if (r === 'sandbox request') return tr('approve sandbox access');
  if (r === 'dialog open') return tr('close an open dialog');
  if (/permission|approve|allow/.test(r)) return tr('approve a permission');
  if (/trust/.test(r)) return tr('trust this folder');
  return truncate(raw, 40);
}
