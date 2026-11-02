// scripts/release.ts (pure functions) and the rule that every version has its section in CHANGELOG.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogSection, parseReleaseArgs, unwrapMarkdown } from '../../scripts/release';

const ROOT = join(import.meta.dirname, '..', '..');

const SAMPLE = `# Changelog

## [Unreleased]

## [0.3.0] - 2026-11-01

### Added

- New stuff.

## [0.2.0] - 2026-10-08

- First.

## [0.1.0]

[Unreleased]: https://github.com/a/b/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/a/b/releases/tag/v0.3.0
`;

describe('changelogSection', () => {
  it('extracts only the text of the requested version', () => {
    expect(changelogSection(SAMPLE, '0.3.0')).toBe('### Added\n\n- New stuff.');
    expect(changelogSection(SAMPLE, '0.2.0')).toBe('- First.');
  });

  it('missing section or empty section: undefined', () => {
    expect(changelogSection(SAMPLE, '0.4.0')).toBeUndefined();
    expect(changelogSection(SAMPLE, '0.1.0')).toBeUndefined();
    // "0.2.0" does not match "0.2.01", and dot does not become a wildcard.
    expect(changelogSection('## [0.2.01]\n\n- no', '0.2.0')).toBeUndefined();
    expect(changelogSection('## [0x2y0]\n\n- no', '0.2.0')).toBeUndefined();
  });
});

describe('unwrapMarkdown', () => {
  it('joins lines within the same item or paragraph', () => {
    const md = ['First version', 'published.', '', '### Added', '', '- **A:** a sentence', '  that continues.', '- B', '  1. sub', '     continues'].join('\n');
    expect(unwrapMarkdown(md)).toBe(['First version published.', '', '### Added', '', '- **A:** a sentence that continues.', '- B', '  1. sub continues'].join('\n'));
  });

  it('does not touch headings, tables, blockquotes, and code blocks', () => {
    const md = ['## Heading', 'text', '| a | b |', '| - | - |', '> quote', '```bash', 'git pull', 'npm install', '```', 'end'].join('\n');
    expect(unwrapMarkdown(md)).toBe(['## Heading', 'text', '| a | b |', '| - | - |', '> quote', '```bash', 'git pull', 'npm install', '```', 'end'].join('\n'));
  });
});

describe('parseReleaseArgs', () => {
  it('reads options', () => {
    expect(parseReleaseArgs([])).toEqual({ dryRun: false, help: false });
    expect(parseReleaseArgs(['--dry-run'])).toEqual({ dryRun: true, help: false });
    expect(() => parseReleaseArgs(['--force'])).toThrow(/opção desconhecida/);
  });
});

describe('CHANGELOG.md', () => {
  it('contains the section for the package.json version (every version must document what was added)', () => {
    const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const notes = changelogSection(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), version);
    expect(notes, `write the "## [${version}]" section in CHANGELOG.md`).toBeTruthy();
  });
});
