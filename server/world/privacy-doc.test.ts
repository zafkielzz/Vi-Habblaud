// docs/world/privacidade.md is the list of what leaves the computer: every field in the building payload (schema.json) and in the
// first connection message (`hello`) must be quoted there in backticks. A new field in the payload without the updated
// page fails this test (rule 3 in shared/world/README.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HelloMessage } from '../../shared/world/protocol';
import schemaJson from '../../shared/world/schema.json';
import { schemaKeyPaths } from '../../shared/world/schema-validator';

const DOC = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'world', 'privacidade.md'), 'utf8');
const cited = (field: string) => DOC.includes(`\`${field}\``);

describe('docs/world/privacidade.md', () => {
  it('cites each field of schema.json', () => {
    const paths = [...schemaKeyPaths(schemaJson as unknown as { [k: string]: unknown })];
    const fields = new Set(paths.map((p) => p.split('.').pop()!.replace(/\[\]$/, '')));
    expect(fields.size).toBeGreaterThanOrEqual(30);
    for (const f of fields) expect(cited(f), `field \`${f}\` of schema.json not cited in docs/world/privacidade.md`).toBe(true);
  });

  it('cites each field of hello (and build internally)', () => {
    const hello: Record<keyof Omit<HelloMessage, 't' | 'v'>, true> = { version: true, build: true, locale: true, token: true };
    for (const f of [...Object.keys(hello), 'commit', 'dirty']) expect(cited(f), f).toBe(true);
  });

  it('verification does not pass trivially: an invented field is not there', () => {
    expect(cited('costUSD')).toBe(false);
    expect(cited('gitBranch')).toBe(false);
  });
});
