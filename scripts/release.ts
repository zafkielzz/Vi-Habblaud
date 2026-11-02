// Publishes the package.json version to GitHub: checks that CHANGELOG.md has its section, creates tag vX.Y.Z and
// the release with that section's text as notes (what Habblaud opens in Settings › About › See what changed).
//   npm run release                -> publishes (requires authenticated gh)
//   npm run release -- --dry-run   -> checks only and displays release notes
// Before: bump the version in package.json (npm version minor --no-git-tag-version), write the section in CHANGELOG.md,
// and merge into main.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface ReleaseArgs {
  dryRun: boolean;
  help: boolean;
}

export function parseReleaseArgs(argv: string[]): ReleaseArgs {
  const args: ReleaseArgs = { dryRun: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`opção desconhecida: ${a}`);
  }
  return args;
}

/**
 * Text of the `## [version]` section of the CHANGELOG (without heading and trailing links), or undefined if
 * section is missing or empty.
 */
export function changelogSection(changelog: string, version: string): string | undefined {
  const lines = changelog.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^## \\[?v?${escaped}\\]?(?:\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)) break;
    body.push(line);
  }
  const text = body.join('\n').trim();
  return text || undefined;
}

/**
 * Joins lines wrapped only to fit 120 columns: in release notes GitHub preserves line breaks, causing sentences
 * to break mid-line. Headings, new items, blockquotes, tables and code blocks remain intact.
 */
export function unwrapMarkdown(text: string): string {
  const out: string[] = [];
  let fence = false;
  let joinable = false;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (/^(```|~~~)/.test(t)) {
      fence = !fence;
      out.push(line);
      joinable = false;
      continue;
    }
    const startsBlock = !t || fence || /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(t);
    if (joinable && !startsBlock) out[out.length - 1] += ` ${t}`;
    else out.push(line);
    joinable = !fence && !!t && !/^(#{1,6}\s|\|)/.test(t);
  }
  return out.join('\n');
}

function run(cmd: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: opts.quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'] }).trim();
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function main(argv: string[]): void {
  let args: ReleaseArgs;
  try {
    args = parseReleaseArgs(argv);
  } catch (err) {
    fail((err as Error).message);
  }
  if (args.help) {
    console.log('Usage: npm run release [-- --dry-run]\nPublishes the package.json version to GitHub with release notes from CHANGELOG.md.');
    return;
  }

  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  const tag = `v${version}`;
  const section = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
  if (!section) fail(`CHANGELOG.md has no "## [${version}]" section (or it is empty): write what is in this version.`);

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`publish from main (you are on ${branch}).`);
  if (run('git', ['status', '--porcelain'])) fail('uncommitted changes exist.');
  run('git', ['fetch', '--quiet', '--tags', 'origin']);
  if (run('git', ['rev-parse', 'HEAD']) !== run('git', ['rev-parse', 'origin/main'])) fail('local main does not match origin/main (run git pull or git push).');
  let tagExists = true;
  try {
    run('git', ['rev-parse', '--quiet', '--verify', `refs/tags/${tag}`], { quiet: true });
  } catch {
    tagExists = false;
  }
  if (tagExists) fail(`tag ${tag} already exists: bump the version in package.json first.`);
  const notes = unwrapMarkdown(section);

  console.log(`Habblaud ${tag}\n\n${notes}\n`);
  if (args.dryRun) {
    console.log('(--dry-run: nothing was published)');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'habblaud-release-'));
  try {
    const file = join(dir, 'notas.md');
    writeFileSync(file, `${notes}\n`);
    run('git', ['tag', '-a', tag, '-m', `Habblaud ${tag}`]);
    run('git', ['push', 'origin', tag]);
    const url = run('gh', ['release', 'create', tag, '--verify-tag', '--title', `Habblaud ${tag}`, '--notes-file', file]);
    console.log(`✓ Release published: ${url}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
