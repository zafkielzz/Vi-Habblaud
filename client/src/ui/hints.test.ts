import { describe, expect, it } from 'vitest';
import { hintText, overlaps, placeNote } from './hints';

const el = (o: { hint?: string; tag?: string; title?: string; label?: string; tool?: boolean }) =>
  ({ dataset: { hint: o.hint }, tagName: o.tag ?? 'BUTTON', title: o.title ?? '', getAttribute: () => o.label ?? null, matches: () => o.tool ?? true }) as unknown as HTMLElement;

describe('hold-Alt notes', () => {
  it('text: data-hint first, else the tooltip or accessible name of a tool button; long tooltips are cut', () => {
    expect(hintText(el({ hint: ' Ends it ', title: 'x' }))).toBe('Ends it');
    expect(hintText(el({ title: 'Settings' }))).toBe('Settings');
    expect(hintText(el({ label: 'Close' }))).toBe('Close');
    expect(hintText(el({ tag: 'DIV', title: 'not a button' }))).toBe('');
    // a list row or a chip: its tooltip only repeats what it shows
    expect(hintText(el({ title: 'Thiago, main agent, Working', tool: false }))).toBe('');
    const long = hintText(el({ title: 'a'.repeat(300) }));
    expect(long.length).toBe(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('a button note goes below, then above, right, left; none free = dropped', () => {
    const view = { w: 1000, h: 800 };
    const t = { rect: { x: 100, y: 100, w: 40, h: 30 }, region: false };
    const below = placeNote(t, 80, 20, [], view)!;
    expect(below).toEqual({ x: 80, y: 136, w: 80, h: 20 });
    const above = placeNote(t, 80, 20, [below], view)!;
    expect(above.y).toBe(74);
    const right = placeNote(t, 80, 20, [below, above], view)!;
    expect(right.x).toBe(146);
    const left = placeNote(t, 80, 20, [below, above, right], view)!;
    expect(left.x).toBe(14);
    expect(placeNote(t, 80, 20, [below, above, right, left], view)).toBeNull();
  });

  it('notes stay inside the viewport; a region gets its note inside, in the middle (else at the top)', () => {
    const view = { w: 500, h: 400 };
    expect(placeNote({ rect: { x: 480, y: 380, w: 20, h: 20 }, region: false }, 100, 20, [], view)).toMatchObject({ x: 396, y: 354 });
    const region = { rect: { x: 0, y: 60, w: 300, h: 300 }, region: true };
    const middle = placeNote(region, 100, 20, [], view)!;
    expect(middle).toEqual({ x: 100, y: 200, w: 100, h: 20 });
    expect(placeNote(region, 100, 20, [middle], view)).toEqual({ x: 100, y: 68, w: 100, h: 20 });
  });

  it('overlap counts a small gap', () => {
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 0, w: 10, h: 10 })).toBe(true);
    expect(overlaps({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(false);
  });
});
