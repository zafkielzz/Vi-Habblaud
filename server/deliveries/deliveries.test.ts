import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTerminalParser } from '../sources/terminal';
import { tempDir } from '../test/fixtures';
import { DeliveryIndex, headlineOf, linkedFiles, parseTurns, summaryOf } from './deliveries';

const ts = (s: number) => new Date(Date.UTC(2026, 9, 12, 12, 0, s)).toISOString();
const user = (id: string, s: number, text: string) => ({ type: 'user', uuid: id, timestamp: ts(s), message: { role: 'user', content: text } });
const tool = (id: string, s: number, name: string, input: object) => ({
  type: 'assistant',
  uuid: id,
  timestamp: ts(s),
  message: { id: `m-${id}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t-${id}`, name, input }] },
});
const shot = (id: string, s: number, data: string) => ({
  type: 'user',
  uuid: id,
  timestamp: ts(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-x', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
});
const say = (id: string, s: number, text: string, stop = 'end_turn') => ({
  type: 'assistant',
  uuid: id,
  timestamp: ts(s),
  message: { id: `m-${id}`, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text }] },
});

const REPLY = `**The report is ready** and has been sent. See [the PDF](/Users/ana/proj/report.pdf) and ./screens/before.png.

| a | b |
|---|---|

In short: the sales report now shows the correct last day, and the PDF is in the project folder for the BA to review.`;

function transcript(): string[] {
  return [
    user('u1', 0, 'Fix the sales report'),
    tool('a1', 1, 'Edit', { file_path: '/Users/ana/proj/src/x.ts', old_string: 'a', new_string: 'b' }),
    say('a2', 2, 'Still working, back shortly.', 'tool_use'),
    shot('r1', 3, 'AAAA'),
    shot('r2', 4, 'BBBB'),
    shot('r3', 5, 'CCCC'),
    tool('a3', 6, 'SendUserFile', { files: ['/Users/ana/proj/print.png', '/Users/ana/.ssh/id_rsa'], caption: 'The new screen' }),
    say('a4', 7, REPLY),
    user('u2', 8, 'Thanks'),
    say('a5', 9, "You're welcome!"),
    user('u3', 10, 'Now run the tests'),
    tool('a6', 11, 'Bash', { command: 'npm test' }),
    say('a7', 12, 'Running tests… integration part still pending, back shortly.', 'tool_use'),
  ].map((l) => JSON.stringify(l));
}

describe('deliveries: text', () => {
  it('headline = first sentence without markdown; summary = last prose paragraph', () => {
    expect(headlineOf(REPLY)).toBe('The report is ready and has been sent.');
    expect(summaryOf(REPLY, headlineOf(REPLY))).toMatch(/^In short: the sales report now shows/);
    expect(summaryOf('A single sentence, without any summary inside.', 'x')).toBeUndefined();
    expect(headlineOf('# Title\n\n' + 'word '.repeat(60))).toMatch(/…$/);
  });

  it('links to viewable files: absolute, project-relative; nothing protected', () => {
    expect(linkedFiles(REPLY, '/Users/ana/proj')).toEqual(['/Users/ana/proj/report.pdf']);
    expect(linkedFiles('see [a](screens/a.png) and [b](https://x.com/b.png) and /Users/ana/.ssh/k.png', '/Users/ana/proj')).toEqual(['/Users/ana/proj/screens/a.png']);
    expect(linkedFiles('[c](relative.png)')).toEqual([]);
  });
});

describe('deliveries: transcript requests', () => {
  it('only turn-ending text counts; attachments, captures (last 2), and count', () => {
    const { turns, last } = parseTurns(transcript(), createTerminalParser());
    expect(turns.map((t) => t.start.text)).toEqual(['Fix the sales report', 'Thanks']);
    const t = turns[0];
    expect([t.tools, t.edited.size, t.ended, t.text.startsWith('**The report')]).toEqual([2, 1, true, true]);
    expect(t.files.map((f) => f.path)).toEqual(['/Users/ana/proj/print.png', '/Users/ana/.ssh/id_rsa']);
    expect(t.captures.map((c) => c.data)).toEqual(['BBBB', 'CCCC']);
    expect(last?.start.text).toBe('Now run the tests');
    expect(last?.ended).toBe(false);
  });

  it('DeliveryIndex: builds deliveries, opaque IDs, and no protected files', async () => {
    const dir = tempDir().dir;
    const path = join(dir, 's.jsonl');
    writeFileSync(path, transcript().join('\n') + '\n');
    let busy = true;
    const idx = new DeliveryIndex({
      sessions: async () => [{ account: '.claude', sessionId: 's1', projectDir: 'p', project: '/Users/ana/proj', lastAt: 1, size: 1, open: true, agentId: 'ag' }],
      resolve: () => ({ path, createParser: createTerminalParser }),
      isBusy: () => busy,
      agentName: () => 'Estela',
    });
    const list = await idx.list();
    expect(list).toHaveLength(1);
    const d = list[0];
    expect(d).toMatchObject({ agentName: 'Estela', request: 'Fix the sales report', headline: 'The report is ready and has been sent.', tools: 2, edited: 1 });
    expect(d.attachments.map((a) => [a.name, a.kind, a.caption ?? '', !!a.capture])).toEqual([
      ['print.png', 'image', 'The new screen', false],
      ['report.pdf', 'pdf', '', false],
      ['tela-1.png', 'image', 'Screenshot taken by the agent', true],
      ['tela-2.png', 'image', 'Screenshot taken by the agent', true],
    ]);
    expect(JSON.stringify(list)).not.toContain('/Users/ana/proj/print.png');
    expect(JSON.stringify(list)).not.toContain('.ssh');
    expect(idx.attachment(d.attachments[0].id)).toMatchObject({ kind: 'file', path: '/Users/ana/proj/print.png', type: 'image/png' });
    expect(idx.attachment(d.attachments[2].id)).toMatchObject({ kind: 'capture', type: 'image/png' });
    expect(idx.attachment('does-not-exist')).toBeUndefined();
    // "You're welcome!" without tools is not a delivery; last request only counts when agent stops.
    busy = false;
    expect((await idx.list()).map((x) => x.request)).toEqual(['Fix the sales report']);
  });
});
