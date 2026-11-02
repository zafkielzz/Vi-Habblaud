// FileTail with unhelpful stat: Linux without statx (WSL1, older seccomp), where Node returns ctime as
// birthtime, and a filesystem that reuses inodes of deleted files (ext4). node:fs is mocked only
// in this file, to simulate both on any system.
import { appendFileSync, rmSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../test/fixtures';
import { FileTail } from './tail';

const sim = vi.hoisted(() => ({ birthIsCtime: false, sameIno: false }));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const fake = (st: Stats): Stats => {
    if (sim.birthIsCtime) st.birthtimeMs = st.ctimeMs;
    if (sim.sameIno) st.ino = 1;
    return st;
  };
  return { ...fs, fstatSync: (fd: number) => fake(fs.fstatSync(fd)), statSync: (path: string) => fake(fs.statSync(path)) };
});

/** Waits for filesystem clock to advance (ext4 stores timestamps in ticks of a few ms). */
const tick = () => new Promise((ok) => setTimeout(ok, 15));

describe('FileTail with unhelpful stat', () => {
  let tmp: ReturnType<typeof tempDir>;
  let file: string;
  beforeEach(() => {
    tmp = tempDir();
    file = join(tmp.dir, 'a.jsonl');
  });
  afterEach(() => {
    sim.birthIsCtime = false;
    sim.sameIno = false;
    tmp.cleanup();
  });

  it('Linux without statx (birthtime = ctime): appended lines do not count as replacement', async () => {
    sim.birthIsCtime = true;
    writeFileSync(file, '{"a":1}\n');
    const t = new FileTail(file);
    t.seekTail(1024);
    expect(t.read().lines).toEqual(['{"a":1}']);
    for (const n of [2, 3]) {
      await tick();
      appendFileSync(file, `{"a":${n}}\n`);
      expect(t.read()).toMatchObject({ reset: false, lines: [`{"a":${n}}`] });
    }
  });

  it('reused inode: replacement detected via file head, with or without real birthtime', async () => {
    sim.sameIno = true;
    // On NTFS, a file recreated with same name in under 15s inherits deleted file birthtime ("tunneling"):
    // with simulated same inode, FileTail has no way to detect replacement. There, inodes don't repeat (file id changes),
    // so only birthtime = ctime variant applies.
    for (const birthIsCtime of process.platform === 'win32' ? [true] : [false, true]) {
      sim.birthIsCtime = birthIsCtime;
      writeFileSync(file, 'old-1\n');
      const t = new FileTail(file);
      t.read();
      await tick();
      rmSync(file);
      writeFileSync(file, 'new-1\nnew-2\n');
      expect(t.read()).toMatchObject({ reset: true, lines: ['new-1', 'new-2'] });
    }
  });
});
