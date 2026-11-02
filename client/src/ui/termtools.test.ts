import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { TerminalLog, type TerminalItem } from './terminal';
import {
  copyTextOf,
  finalAnswerKeys,
  findMatches,
  foldQuery,
  foldText,
  globalIndex,
  itemVisible,
  refAt,
  searchCounter,
  stepMatch,
  type TerminalFilter,
} from './termtools';

const user = (id: string, text = 'oi'): TerminalEntry => ({ kind: 'user', id, at: 1, text });
const say = (id: string, text = 'feito'): TerminalEntry => ({ kind: 'assistant', id, at: 2, text });
const tool = (id: string, extra: Partial<Extract<TerminalEntry, { kind: 'tool' }>> = {}): TerminalEntry => ({ kind: 'tool', id, at: 3, tool: 'Bash', title: 'Bash(npm test)', ...extra });
const result = (id: string, toolUseId: string, text = 'ok'): TerminalEntry => ({ kind: 'result', id, at: 4, toolUseId, text });
const think = (id: string): TerminalEntry => ({ kind: 'thinking', id, at: 5, text: 'hmm' });
const sys = (id: string): TerminalEntry => ({ kind: 'system', id, at: 6, text: 'Contexto compactado', detail: 'resumo' });

// Items in display order, as panel sees them (tools already with result).
function items(...entries: TerminalEntry[]): TerminalItem[] {
  const log = new TerminalLog();
  log.push(entries);
  return [...log.values()];
}

// Text matched by a slice [a, b) from original.
const cut = (text: string, query: string) => findMatches(text, foldQuery(query)).map(([a, b]) => text.slice(a, b));

describe('search: matches', () => {
  it('case- and accent-insensitive in both directions', () => {
    expect(cut('Ação e ACAO e acao', 'ação')).toEqual(['Ação', 'ACAO', 'acao']);
    expect(cut('Configuração do São João', 'sao joao')).toEqual(['São João']);
    expect(cut('npm test && NPM TEST', 'npm test')).toEqual(['npm test', 'NPM TEST']);
  });

  it('positions in original even with accents and emojis before match', () => {
    const text = '🙂 é preciso rodar os TESTES';
    const [[a, b]] = findMatches(text, foldQuery('testes'));
    expect(text.slice(a, b)).toBe('TESTES');
    // Decomposed accent (e + U+0301) also matches and is highlighted as a whole.
    expect(cut('café pronto', 'café')).toEqual(['café']);
  });

  it('no overlap, empty term or spaces only does not search', () => {
    expect(cut('aaaa', 'aa')).toEqual(['aa', 'aa']);
    expect(findMatches('qualquer coisa', foldQuery('   '))).toEqual([]);
    expect(findMatches('', foldQuery('x'))).toEqual([]);
    expect(foldQuery('  Olá ')).toBe('  ola ');
  });

  it('foldText: ASCII without map; with accents, position map', () => {
    expect(foldText('ABC')).toEqual({ text: 'abc' });
    const f = foldText('Ãb');
    expect(f.text).toBe('ab');
    expect(f.starts).toEqual([0, 1]);
    expect(f.ends).toEqual([1, 2]);
  });
});

describe('search: navigation', () => {
  const counts: [string, number][] = [
    ['user:u1', 2],
    ['assistant:a1', 0],
    ['tool:t1', 3],
  ];

  it('stepMatch wraps around and starts from first (or last, backwards)', () => {
    expect(stepMatch(-1, 5, 1)).toBe(0);
    expect(stepMatch(-1, 5, -1)).toBe(4);
    expect(stepMatch(4, 5, 1)).toBe(0);
    expect(stepMatch(0, 5, -1)).toBe(4);
    expect(stepMatch(2, 5, 1)).toBe(3);
    expect(stepMatch(7, 5, 1)).toBe(0);
    expect(stepMatch(0, 0, 1)).toBe(-1);
  });

  it('globalIndex and refAt convert between "3/17" and (line, highlight)', () => {
    expect(globalIndex(counts, { key: 'user:u1', index: 1 })).toBe(1);
    expect(globalIndex(counts, { key: 'tool:t1', index: 0 })).toBe(2);
    expect(globalIndex(counts, { key: 'tool:t1', index: 5 })).toBe(-1);
    expect(globalIndex(counts, { key: 'sumiu', index: 0 })).toBe(-1);
    expect(globalIndex(counts, null)).toBe(-1);
    expect(refAt(counts, 0)).toEqual({ key: 'user:u1', index: 0 });
    expect(refAt(counts, 4)).toEqual({ key: 'tool:t1', index: 2 });
    expect(refAt(counts, 5)).toBeNull();
    expect(refAt(counts, -1)).toBeNull();
    // Round-trip: next from last wraps to first.
    const total = 5;
    expect(refAt(counts, stepMatch(globalIndex(counts, { key: 'tool:t1', index: 2 }), total, 1))).toEqual({ key: 'user:u1', index: 0 });
  });

  it('counter "3/17" (without current: "0/17")', () => {
    expect(searchCounter(2, 17)).toBe('3/17');
    expect(searchCounter(-1, 17)).toBe('0/17');
    expect(searchCounter(0, 0)).toBe('0/0');
  });
});

describe('filter', () => {
  it('final answers: text without tool after it until next prompt (or end)', () => {
    const list = items(user('u1'), say('a1', 'Vou ler.'), tool('t1'), result('r1', 't1'), say('a2', 'Pronto.'), sys('s1'), user('u2'), say('a3', 'Olhando…'), tool('t2'), say('a4', 'Fim.'));
    expect([...finalAnswerKeys(list)]).toEqual(['assistant:a2', 'assistant:a4']);
    // Still working: last text can stop being final when a tool arrives.
    expect([...finalAnswerKeys(items(user('u1'), say('a1')))]).toEqual(['assistant:a1']);
    expect([...finalAnswerKeys(items(user('u1'), say('a1'), tool('t1')))]).toEqual([]);
  });

  it('All / Only prompts / No tools', () => {
    const list = items(user('u1'), think('th1'), say('a1', 'Vou rodar.'), tool('t1'), result('r1', 't1'), result('r9', 'outra'), say('a2', 'Passou.'), sys('s1'));
    const finals = finalAnswerKeys(list);
    const visible = (f: TerminalFilter) => list.filter((i) => itemVisible(i, f, finals)).map((i) => i.key);
    expect(visible('all')).toEqual(list.map((i) => i.key));
    expect(visible('prompts')).toEqual(['user:u1', 'assistant:a2']);
    expect(visible('noTools')).toEqual(['user:u1', 'thinking:th1', 'assistant:a1', 'assistant:a2', 'system:s1']);
  });
});

describe('copy', () => {
  it('prompt, reply, command (or title without arguments), result, and events', () => {
    expect(copyTextOf(user('u1', 'Arruma o carrinho\n\n'))).toBe('Arruma o carrinho');
    expect(copyTextOf(say('a1', '**Pronto**: feito.'))).toBe('**Pronto**: feito.');
    expect(copyTextOf(tool('t1', { input: 'npm run build && npm test\n', inputKind: 'command' }))).toBe('npm run build && npm test');
    expect(copyTextOf(tool('t2', { title: 'Read(server/index.ts)', input: '  ' }))).toBe('Read(server/index.ts)');
    expect(copyTextOf(result('r1', 't1', 'linha 1\nlinha 2\n'))).toBe('linha 1\nlinha 2');
    expect(copyTextOf(sys('s1'))).toBe('Contexto compactado\nresumo');
    expect(copyTextOf({ kind: 'thinking', id: 'x', at: 0 })).toBe('');
  });
});
