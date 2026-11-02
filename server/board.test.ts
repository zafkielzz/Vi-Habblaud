// Board › Tasks and News per room: handoff plans and today's commits, published to the Office.
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BoardService } from './board';
import type { Office } from './model/office';
import type { HandoffPlan, NewsItem } from '../shared/types';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

const NOW = new Date(2026, 9, 27, 15, 0).getTime();

describe('BoardService', () => {
  it("reads each room's handoff plan and today's commits; publishes the feed only when it changed", async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-'));
    writeFileSync(join(dir, 'HANDOFF.md'), '## Next steps\n- Ship the board\n');
    const plans = new Map<string, HandoffPlan | undefined>();
    const published: NewsItem[][] = [];
    const office = {
      roomList: () => [
        { id: 'r1', path: dir, name: 'proj' },
        { id: 'r2', path: join(dir, 'missing'), name: 'gone' },
      ],
      setPlan: (id: string, p: HandoffPlan | undefined) => plans.set(id, p),
      setNews: (items: NewsItem[]) => published.push(items),
    } as unknown as Office;
    const commits = async (path: string) => (path === dir ? [{ hash: 'abcdef1234', at: NOW - 60_000, author: 'Nam', subject: 'Board tabs' }] : []);
    const board = new BoardService({ office, now: () => NOW, commits });
    await board.poll();
    expect(plans.get('r1')?.items).toEqual([{ text: 'Ship the board' }]);
    expect(plans.get('r2')).toBeUndefined();
    expect(published).toEqual([[{ id: 'commit:abcdef1234', at: NOW - 60_000, kind: 'commit', icon: '📝', text: 'Board tabs', detail: 'proj · Nam · abcdef1', roomId: 'r1' }]]);
    await board.poll();
    expect(published).toHaveLength(1);
  });

  it('edits the to-do list in the HANDOFF file; refuses (and reloads) when the file changed meanwhile; starts one', () => {
    dir = mkdtempSync(join(tmpdir(), 'board-'));
    const file = join(dir, 'HANDOFF.md');
    writeFileSync(file, '# H\n\n## Next steps\n- One\n- Two\n');
    const plans = new Map<string, HandoffPlan | undefined>();
    const office = { roomPath: (id: string) => (id === 'r1' ? dir : undefined), setPlan: (id: string, p: HandoffPlan | undefined) => plans.set(id, p) } as unknown as Office;
    const board = new BoardService({ office });
    const mtime = statSync(file).mtimeMs;
    expect(board.editPlan('r1', mtime, { op: 'toggle', index: 1, done: true })).toMatchObject({ ok: true, plan: { items: [{ text: 'One' }, { text: 'Two', done: true }] } });
    expect(readFileSync(file, 'utf8')).toBe('# H\n\n## Next steps\n- One\n- [x] Two\n');
    // the boss edited the file after the page read it
    utimesSync(file, 1, 1);
    expect(board.editPlan('r1', mtime, { op: 'remove', index: 0 })).toMatchObject({ ok: false, status: 409 });
    expect(plans.get('r1')?.items).toHaveLength(2);
    expect(board.editPlan('r1', statSync(file).mtimeMs, { op: 'add', text: 'Three' })).toMatchObject({ ok: true });
    expect(board.editPlan('nope', undefined, { op: 'add', text: 'x' })).toMatchObject({ ok: false, status: 404 });
    // a folder without a HANDOFF file: "create" writes HANDOFF.md with the section
    rmSync(file);
    expect(board.editPlan('r1', undefined, { op: 'add', text: 'x' })).toMatchObject({ ok: false, status: 404 });
    expect(board.editPlan('r1', undefined, { op: 'create', heading: 'Việc tiếp theo', text: 'Đầu tiên' })).toMatchObject({ ok: true, plan: { heading: 'Việc tiếp theo', items: [{ text: 'Đầu tiên' }] } });
    expect(readFileSync(file, 'utf8')).toBe('## Việc tiếp theo\n\n- [ ] Đầu tiên\n');
  });

  it("reads and edits the HANDOFF list of each office folder, even with no room there", async () => {
    dir = mkdtempSync(join(tmpdir(), 'board-'));
    writeFileSync(join(dir, 'HANDOFF.md'), '## Next steps\n- One\n');
    let folders = [dir, '', join(dir, 'missing')];
    const office = { roomList: () => [], setPlan: () => undefined, setNews: () => undefined } as unknown as Office;
    const board = new BoardService({ office, now: () => NOW, commits: async () => [], folders: () => folders });
    await board.poll();
    expect(board.folderPlan(dir)?.items).toEqual([{ text: 'One' }]);
    expect(board.folderPlan(join(dir, 'missing'))).toBeUndefined();
    const mtime = board.folderPlan(dir)?.mtime;
    expect(board.editFolderPlan(dir, mtime, { op: 'add', text: 'Two' })).toMatchObject({ ok: true, plan: { items: [{ text: 'One' }, { text: 'Two' }] } });
    expect(board.folderPlan(dir)?.items).toHaveLength(2);
    expect(readFileSync(join(dir, 'HANDOFF.md'), 'utf8')).toContain('Two');
    // a folder no office uses anymore is forgotten
    folders = [];
    await board.poll();
    expect(board.folderPlan(dir)).toBeUndefined();
  });
});
