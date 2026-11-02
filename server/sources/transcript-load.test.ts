// What the "Boss overloaded" warning reads from a transcript: the context in use and the compactions.
import { describe, expect, it } from 'vitest';
import { L } from '../test/fixtures';
import { createTranscriptState, parseLine } from './transcript';

const T0 = Date.parse('2026-10-27T10:00:00Z');

describe('session load from the transcript', () => {
  it('context = input side of the latest message (not a sum); each compact_boundary counts', () => {
    const s = createTranscriptState();
    const feed = (lines: string[]) => lines.forEach((l) => parseLine(s, l, { idPrefix: 'acc:1', now: T0 }));
    feed([
      L.assistant([L.text('a')], { msgId: 'm1', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 5_000 } }),
      L.assistant([L.text('b')], { msgId: 'm2', usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 120_000, cache_creation_input_tokens: 1_000 } }),
    ]);
    expect(s.stats.contextTokens).toBe(121_020);
    expect(s.stats.compacts).toBeUndefined();
    feed([
      L.system('compact_boundary', { compactMetadata: {} }),
      L.assistant([L.text('c')], { msgId: 'm3', usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 15_000 } }),
    ]);
    expect(s.stats).toMatchObject({ contextTokens: 15_005, compacts: 1 });
  });
});
