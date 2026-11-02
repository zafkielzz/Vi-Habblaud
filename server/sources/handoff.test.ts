// The "next steps" section of a project's HANDOFF*.md (the plan in the Board's Tasks tab).
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editHandoff, findHandoff, HandoffReader, parseHandoff } from './handoff';

const MD = `# Handoff

## Done
- old thing

## Next steps (in order)
1. **Finish the wave** (section
   above):
   - sub-item, left out
   continuation of the sub-item, left out
2. Board with \`3 tabs\` and a [link](x.md).
- [x] Already done
- [ ] Still open

### Detail under the section
- still in the section

## Known limits
- not a task
`;

describe('parseHandoff', () => {
  it('top-level items of the "next" section, plain text, up to the next heading of the same level', () => {
    expect(parseHandoff(MD)).toEqual({
      heading: 'Next steps',
      items: [
        { text: 'Finish the wave (section above)' },
        { text: 'Board with 3 tabs and a link.' },
        { text: 'Already done', done: true },
        { text: 'Still open' },
        { text: 'still in the section' },
      ],
    });
  });

  it('Vietnamese and Portuguese headings; code fences are skipped', () => {
    expect(parseHandoff('## Việc tiếp theo\n- một\n```\n- not this\n```\n- hai')?.items).toEqual([{ text: 'một' }, { text: 'hai' }]);
    expect(parseHandoff('### Próximos passos\n* um')?.items).toEqual([{ text: 'um' }]);
  });

  it('no section: undefined; a section without a list: an empty list (the Board can add to it)', () => {
    expect(parseHandoff('# Notes\n- a')).toBeUndefined();
    expect(parseHandoff('## Next\nJust prose.')).toEqual({ heading: 'Next', items: [] });
  });

  it('a struck-through item is done (older notes); its marks are left out', () => {
    expect(parseHandoff('## Việc tiếp theo\n0. ~~Cửa sổ context~~ **XONG 28/10**: ok\n1. Bảng')!.items).toEqual([{ text: 'Cửa sổ context XONG 28/10: ok', done: true }, { text: 'Bảng' }]);
  });

  it('long items are clipped', () => {
    const text = parseHandoff(`## Next\n- ${'x'.repeat(500)}`)!.items[0].text;
    expect(text.length).toBe(200);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('findHandoff / HandoffReader', () => {
  let dir = '';
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('newest HANDOFF*.md wins; re-read only when it changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'handoff-'));
    expect(findHandoff(dir)).toBeUndefined();
    writeFileSync(join(dir, 'HANDOFF_OLD.md'), '## Next\n- old');
    writeFileSync(join(dir, 'handoff-new.md'), '## Next\n- new');
    writeFileSync(join(dir, 'notes.md'), '## Next\n- no');
    utimesSync(join(dir, 'HANDOFF_OLD.md'), 1_000, 1_000);
    expect(findHandoff(dir)?.path).toBe(join(dir, 'handoff-new.md'));

    const reader = new HandoffReader();
    const first = reader.read(dir);
    expect(first).toMatchObject({ file: 'handoff-new.md', items: [{ text: 'new' }] });
    expect(reader.read(dir)).toBe(first);
    writeFileSync(join(dir, 'handoff-new.md'), '## Next\n- newer');
    utimesSync(join(dir, 'handoff-new.md'), 5_000_000, 5_000_000);
    expect(reader.read(dir)?.items).toEqual([{ text: 'newer' }]);
    expect(reader.read(join(dir, 'missing'))).toBeUndefined();
  });
});

describe('editHandoff', () => {
  const md = ['# Handoff', 'Intro.', '', '## Next steps', '- First', '  - sub', '- [x] Second', '', '## Notes', '- not a task', ''].join('\n');

  it('ticks and unticks an item in place (the rest of the file untouched)', () => {
    const on = editHandoff(md, { op: 'toggle', index: 0, done: true })!;
    expect(on.split('\n')[4]).toBe('- [x] First');
    expect(on.replace('- [x] First', '- First')).toBe(md);
    expect(editHandoff(md, { op: 'toggle', index: 1, done: false })!.split('\n')[6]).toBe('- [ ] Second');
    expect(editHandoff('## Next\n1. ~~Old~~ done', { op: 'toggle', index: 0, done: false })).toBe('## Next\n1. [ ] Old done');
  });

  it('adds after the last item (numbered when the list is), removes an item with its sub-items', () => {
    expect(editHandoff(md, { op: 'add', text: ' Third\nline ' })!.split('\n').slice(4, 8)).toEqual(['- First', '  - sub', '- [x] Second', '- [ ] Third line']);
    expect(editHandoff('## Next\n1. a\n2. b\n', { op: 'add', text: 'c' })).toBe('## Next\n1. a\n2. b\n3. [ ] c\n');
    expect(editHandoff(md, { op: 'remove', index: 0 })!.split('\n').slice(3, 6)).toEqual(['## Next steps', '- [x] Second', '']);
    expect(editHandoff(md, { op: 'remove', index: 5 })).toBeUndefined();
  });

  it('starts a list in a file without one (and keeps Windows line ends)', () => {
    expect(editHandoff('# Notes\n', { op: 'create', heading: 'Next steps', text: 'Do x' })).toBe('# Notes\n\n## Next steps\n\n- [ ] Do x\n');
    expect(editHandoff('', { op: 'create', heading: 'Next steps' })).toBe('## Next steps\n\n');
    expect(editHandoff(md, { op: 'create', heading: 'Next steps' })).toBeUndefined();
    expect(editHandoff('## Next\r\n- a\r\n', { op: 'add', text: 'b' })).toBe('## Next\r\n- a\r\n- [ ] b\r\n');
  });
});
