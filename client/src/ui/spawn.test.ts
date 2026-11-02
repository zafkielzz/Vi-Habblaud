import { describe, expect, it } from 'vitest';
import { shortPath, spawnFolders } from './spawn';
import { insertDictation, pickMimeType } from './dictation';

describe('spawnFolders', () => {
  it('room folders, most recent first, excluding demo and relative paths', () => {
    const rooms = [
      { id: 'r1', path: '/Users/a/antigo' },
      { id: 'r2', path: '/Users/a/novo' },
      { id: 'demo:x', path: '/demo/x' },
      { id: 'r3', path: 'relativo' },
      { id: 'r4', path: 'C:\\code\\win' },
    ];
    const agents = [
      { roomId: 'r1', lastEventAt: 10 },
      { roomId: 'r2', lastEventAt: 50 },
      { roomId: 'r4', lastEventAt: 20 },
    ];
    expect(spawnFolders({ rooms, agents } as never)).toEqual(['/Users/a/novo', 'C:\\code\\win', '/Users/a/antigo']);
    expect(spawnFolders(null)).toEqual([]);
  });
});

describe('shortPath', () => {
  it('short path with ~', () => {
    expect(shortPath('/Users/ana/Coding/proj')).toBe('~/Coding/proj');
    expect(shortPath('/home/ana/proj')).toBe('~/proj');
    expect(shortPath('/opt/x')).toBe('/opt/x');
    expect(shortPath('C:\\Users\\ana\\proj')).toBe('~\\proj');
  });
});

describe('dictation in input', () => {
  it('inserts at cursor with correct spacing on both sides', () => {
    expect(insertDictation('', 0, 0, ' Create an agent ')).toEqual({ value: 'Create an agent', caret: 15 });
    expect(insertDictation('Review', 6, 6, 'the report')).toEqual({ value: 'Review the report', caret: 17 });
    expect(insertDictation('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 3 });
    expect(insertDictation('replace THIS here', 8, 12, 'this')).toEqual({ value: 'replace this here', caret: 12 });
    expect(insertDictation('equal', 5, 5, '   ')).toEqual({ value: 'equal', caret: 5 });
  });
  it('picks the format the browser records (mp4 on iPhone, webm on Chrome)', () => {
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus');
    expect(pickMimeType(() => false)).toBeUndefined();
    expect(pickMimeType(() => { throw new Error('x'); })).toBeUndefined();
  });
});
