// Pure rules for world text overlay layer (bubbles and framing).
import { describe, expect, it } from 'vitest';
import { overviewFrame } from '../camera';
import { ghostText, headIconLift, outOfQuota, quotaSleepText, rationBubbles, waitBubbleText } from './overlay';

describe('ghost', () => {
  it('says what is wrong and for how long', () => {
    expect(ghostText({ reason: 'stalled', since: 0 }, 12 * 60_000)).toBe('No progress for 12min');
    expect(ghostText({ reason: 'no-job', since: 0 }, 12 * 60_000)).toBe('Alive with no job, silent for 12min');
  });
});

describe('quota sleep', () => {
  const empty = { left: 0, level: 0, asleep: true } as const;

  it('only with nothing to do: a job or a question keeps the character up', () => {
    expect(outOfQuota({ mode: 'idle', energy: empty })).toBe(true);
    expect(outOfQuota({ mode: 'work', energy: empty })).toBe(false);
    expect(outOfQuota({ mode: 'wait', energy: empty })).toBe(false);
    expect(outOfQuota({ mode: 'idle', energy: null })).toBe(false);
    expect(outOfQuota({ mode: 'idle', energy: { left: 5, level: 1, asleep: false } })).toBe(false);
  });

  it('its 💤 lifts the labels and bubbles above the head', () => {
    expect(headIconLift({ mode: 'idle', icon: null, energy: empty })).toBe(13);
    expect(headIconLift({ mode: 'idle', icon: null })).toBe(0);
  });

  it('says when it is back, if known', () => {
    expect(quotaSleepText(2_000 + 90 * 60_000, 2_000)).toBe('Out of quota, back in 1h 30min');
    expect(quotaSleepText(undefined, 2_000)).toBe('Out of quota');
    expect(quotaSleepText(1_000, 2_000)).toBe('Out of quota');
  });
});

describe('bubbles', () => {
  it('waiting: reason only, without redundant prefix', () => {
    expect(waitBubbleText('approve a permission')).toBe('Approve a permission');
    expect(waitBubbleText('Needs you: choose an option')).toBe('Choose an option');
    expect(waitBubbleText(undefined)).toBe('Answer in terminal');
    expect(waitBubbleText('   ')).toBe('Answer in terminal');
  });

  it('overview: at most 1 text bubble per area and 4 on screen (most recent first)', () => {
    const items = [
      { room: 'a', prio: 50, changedAt: 10 },
      { room: 'a', prio: 50, changedAt: 30 },
      { room: 'a', prio: 50, changedAt: 20 },
      { room: 'b', prio: 30, changedAt: 99 },
      { room: 'c', prio: 50, changedAt: 1 },
      { room: 'd', prio: 50, changedAt: 2 },
      { room: 'e', prio: 50, changedAt: 3 },
    ];
    const keep = rationBubbles(items, 1, 4);
    expect(keep.size).toBe(4);
    expect(keep.has(1)).toBe(true); // most recent in area "a"
    expect(keep.has(0) || keep.has(2)).toBe(false);
    expect(keep.has(3)).toBe(false); // lower priority yields to other areas
  });
});

describe('overview', () => {
  const building = { x: 0, y: 0, w: 4 * 16 * 16, h: 29 * 16 };

  it('frames building in available area (outside panels), with clearance for signs above', () => {
    const free = overviewFrame(building, 1440, 900, { top: 0, right: 0, bottom: 0, left: 0 });
    const ui = overviewFrame(building, 1440, 900, { top: 64, right: 0, bottom: 200, left: 320 });
    expect(ui.zoom).toBeLessThan(free.zoom);
    // framed height (signs + building + curb) fits between top and bottom bars
    const h = (building.h + 3.5 * 16) * ui.zoom;
    expect(h).toBeLessThanOrEqual(900 - 64 - 200 - 30);
    // starts above north wall (signs) and ends below south facade
    expect(ui.cy).toBeGreaterThan(building.h / 2);
    expect(ui.dy).toBeGreaterThan(0);
  });
});
