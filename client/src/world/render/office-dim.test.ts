// Office focus dimming: what is outside the office shown fades in gently, and back out when it is in again.
import { describe, expect, it } from 'vitest';
import { DIM_FADE_S, FocusDim } from './office-dim';

const focus = { roomIds: new Set(['r1']), agentIds: new Set(['a1']) };

describe('office focus dim', () => {
  it('no focus: nothing is dimmed', () => {
    const d = new FocusDim();
    d.frame(null, 1);
    expect(d.room('r2')).toBe(0);
    expect(d.char('a2')).toBe(0);
  });

  it('outside the focus eases to fully dimmed; inside stays normal', () => {
    const d = new FocusDim();
    d.frame(focus, DIM_FADE_S / 2);
    expect(d.room('r1')).toBe(0);
    expect(d.room('r2')).toBeCloseTo(0.5);
    expect(d.char('a1')).toBe(0);
    expect(d.char('a2')).toBeCloseTo(0.5);
    expect(d.charLevel('a2')).toBeCloseTo(0.5);
    d.frame(focus, DIM_FADE_S);
    expect(d.room('r2')).toBe(1);
    d.frame(focus, DIM_FADE_S);
    expect(d.room('r2')).toBe(1);
  });

  it('eases back when the focus goes away or changes', () => {
    const d = new FocusDim();
    d.frame(focus, DIM_FADE_S);
    expect(d.char('a2')).toBe(1);
    d.frame({ roomIds: new Set(), agentIds: new Set(['a2']) }, DIM_FADE_S / 4);
    expect(d.char('a2')).toBeCloseTo(0.75);
    d.frame(null, DIM_FADE_S);
    expect(d.char('a2')).toBe(0);
    expect(d.charLevel('a2')).toBe(0);
  });
});
