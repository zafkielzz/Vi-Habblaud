import { describe, expect, it } from 'vitest';
import { tokenizeBlocks, tokenizeInline, type MdBlock } from './markdown';

describe('tokenizeBlocks', () => {
  it('separates paragraphs by blank lines and preserves line breaks within them', () => {
    expect(tokenizeBlocks('First line\nsecond line\n\nAnother paragraph')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'First line\nsecond line' },
      { type: 'paragraph', text: 'Another paragraph' },
    ]);
  });

  it('recognizes code blocks with language, without parsing markdown inside', () => {
    const src = 'See:\n\n```ts\nconst a = **b**;\n# not a heading\n```\nend';
    expect(tokenizeBlocks(src)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'See:' },
      { type: 'code', lang: 'ts', text: 'const a = **b**;\n# not a heading' },
      { type: 'paragraph', text: 'end' },
    ]);
  });

  it('unclosed code block extends to the end (truncated response)', () => {
    expect(tokenizeBlocks('```\nline 1\nline 2')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'line 1\nline 2' }]);
  });

  it('closes only with the matching fence (``` does not close ~~~)', () => {
    expect(tokenizeBlocks('~~~\na\n```\nb\n~~~')).toEqual<MdBlock[]>([{ type: 'code', lang: '', text: 'a\n```\nb' }]);
  });

  it('headings from 1 to 6 levels (and # without space is not a heading)', () => {
    expect(tokenizeBlocks('# One\n### Three ###\n#hashtag')).toEqual<MdBlock[]>([
      { type: 'heading', level: 1, text: 'One' },
      { type: 'heading', level: 3, text: 'Three' },
      { type: 'paragraph', text: '#hashtag' },
    ]);
  });

  it('bulleted, numbered, and nested lists', () => {
    const blocks = tokenizeBlocks('Files:\n- a.ts\n  - b.ts\n- c.ts\n\n1. one\n2. two');
    expect(blocks).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Files:' },
      {
        type: 'list',
        ordered: false,
        items: [
          { depth: 0, marker: '-', ordered: false, text: 'a.ts' },
          { depth: 1, marker: '-', ordered: false, text: 'b.ts' },
          { depth: 0, marker: '-', ordered: false, text: 'c.ts' },
        ],
      },
      {
        type: 'list',
        ordered: true,
        items: [
          { depth: 0, marker: '1.', ordered: true, text: 'one' },
          { depth: 0, marker: '2.', ordered: true, text: 'two' },
        ],
      },
    ]);
  });

  it('loose list (blank lines between items) stays the same list; indented line continues the item', () => {
    const blocks = tokenizeBlocks('- one\n\n- two\n  continuation\n\nend');
    expect(blocks[0]).toEqual({
      type: 'list',
      ordered: false,
      items: [
        { depth: 0, marker: '-', ordered: false, text: 'one' },
        { depth: 0, marker: '-', ordered: false, text: 'two\ncontinuation' },
      ],
    });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: 'end' });
  });

  it('number in the middle of a paragraph does not become a list (only "1." interrupts)', () => {
    expect(tokenizeBlocks('In\n2024. it was like this')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'In\n2024. it was like this' }]);
  });

  it('blockquotes and horizontal rules', () => {
    expect(tokenizeBlocks('> tip\n> continues\n\n---\n\ntext')).toEqual<MdBlock[]>([
      { type: 'quote', text: 'tip\ncontinues' },
      { type: 'rule' },
      { type: 'paragraph', text: 'text' },
    ]);
  });

  it('tables stay as preformatted text (original lines)', () => {
    const table = '| File | Lines |\n|---|---:|\n| a.ts | 10 |';
    expect(tokenizeBlocks(`Summary:\n${table}\n\nend`)).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'Summary:' },
      { type: 'table', text: table },
      { type: 'paragraph', text: 'end' },
    ]);
  });

  it('stray pipe in a paragraph does not become a table', () => {
    expect(tokenizeBlocks('use a | b to filter')).toEqual<MdBlock[]>([{ type: 'paragraph', text: 'use a | b to filter' }]);
  });

  it('normalizes \\r\\n', () => {
    expect(tokenizeBlocks('a\r\nb\r\n\r\nc')).toEqual<MdBlock[]>([
      { type: 'paragraph', text: 'a\nb' },
      { type: 'paragraph', text: 'c' },
    ]);
  });
});

describe('tokenizeInline', () => {
  it('plain text becomes a single token', () => {
    expect(tokenizeInline('hello world')).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('inline code (without parsing contents)', () => {
    expect(tokenizeInline('run `npm **test**` now')).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'code', text: 'npm **test**' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('double-backtick code can contain a backtick', () => {
    expect(tokenizeInline('``a ` b``')).toEqual([{ type: 'code', text: 'a ` b' }]);
  });

  it('unpaired backtick remains as text', () => {
    expect(tokenizeInline('a lone ` backtick')).toEqual([{ type: 'text', text: 'a lone ` backtick' }]);
  });

  it('bold and italic, including nested', () => {
    expect(tokenizeInline('**bold** and *italic*')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'italic' }] },
    ]);
    expect(tokenizeInline('**a *b* c**')).toEqual([
      {
        type: 'strong',
        children: [{ type: 'text', text: 'a ' }, { type: 'em', children: [{ type: 'text', text: 'b' }] }, { type: 'text', text: ' c' }],
      },
    ]);
  });

  it('asterisk with space (math) and underscore inside a word do not format', () => {
    expect(tokenizeInline('2 * 3 * 4')).toEqual([{ type: 'text', text: '2 * 3 * 4' }]);
    expect(tokenizeInline('snake_case_name')).toEqual([{ type: 'text', text: 'snake_case_name' }]);
    expect(tokenizeInline('_emphasis_')).toEqual([{ type: 'em', children: [{ type: 'text', text: 'emphasis' }] }]);
  });

  it('links become text with separate href', () => {
    expect(tokenizeInline('see [the doc](https://exemplo.com/x "title") here')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'link', text: 'the doc', href: 'https://exemplo.com/x' },
      { type: 'text', text: ' here' },
    ]);
    expect(tokenizeInline('[no link] and [x](with space)')).toEqual([{ type: 'text', text: '[no link] and [x](with space)' }]);
  });

  it('backslash escapes', () => {
    expect(tokenizeInline('\\*not\\* italic')).toEqual([{ type: 'text', text: '*not* italic' }]);
  });

  it('HTML in transcript is plain text (renderer uses textContent)', () => {
    expect(tokenizeInline('<img src=x onerror=alert(1)>')).toEqual([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]);
  });
});
