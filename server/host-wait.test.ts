import { describe, expect, it } from 'vitest';
import { HostWait, pollWithWait } from './host-wait';

describe('host helper long-polling', () => {
  it('waits when idle; wake releases immediately and round takes arrivals', async () => {
    const wait = new HostWait(10_000);
    const queue: string[] = [];
    const take = () => queue.splice(0);
    const round = pollWithWait(wait, take, 60_000);
    expect(wait.present()).toBe(true);
    queue.push('a');
    wait.wake();
    await expect(round).resolves.toEqual(['a']);
  });

  it('with queued work, responds immediately; with zero wait (0 ms), also responds immediately', async () => {
    const wait = new HostWait(10_000);
    await expect(pollWithWait(wait, () => ['x'], 60_000)).resolves.toEqual(['x']);
    await expect(pollWithWait(wait, () => [], 0)).resolves.toEqual([]);
  });

  it('aborted connection mid-wait: returns empty without dequeuing work', async () => {
    const wait = new HostWait(10_000);
    const ac = new AbortController();
    let taken = 0;
    const round = pollWithWait(wait, () => (taken++, []), 60_000, ac.signal);
    ac.abort();
    await expect(round).resolves.toEqual([]);
    expect(taken).toBe(1);
  });

  it('presence: waiting counts; after that, only up to presenceMs from last round', async () => {
    let now = 0;
    const wait = new HostWait(1_000, () => now);
    expect(wait.present()).toBe(false);
    wait.seen();
    now = 900;
    expect(wait.present()).toBe(true);
    now = 2_000;
    expect(wait.present()).toBe(false);
    const round = wait.wait(60_000);
    expect(wait.present()).toBe(true);
    wait.wake();
    await round;
    expect(wait.present()).toBe(true);
  });
});
