// The World button: only with `meta.world.scene.available` and on the machine's own page (snapshot also goes to
// mobile, but scene routes do not); in demo mode, without restrictions. And returning to the office when UI
// selects an agent or room while city is open (notice, Reply).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorldMeta, WorldSource } from '../../net/world';
import type { Selection } from '../../world/api';
import type { UiContext } from '../context';
import { citySceneAvailable, SceneSwitch, type CitySceneHost } from './scene-switch';
import type { WorldGate } from './world-model';

const meta = (scene?: { available: boolean }): WorldMeta => ({ enabled: true, configured: true, state: 'approved', ...(scene ? { scene } : {}) });
const src = (m: WorldMeta | undefined, fake = false): WorldSource => ({ client: null, fake, meta: () => m });
const LOCAL: WorldGate = { remote: false, local: true, terminal: true, fake: false };

describe('citySceneAvailable', () => {
  it('with scene available and on the local computer page', () => {
    expect(citySceneAvailable(src(meta({ available: true })), LOCAL)).toBe(true);
    expect(citySceneAvailable(src(meta({ available: false })), LOCAL)).toBe(false);
    expect(citySceneAvailable(src(meta()), LOCAL)).toBe(false);
    expect(citySceneAvailable(src(undefined), LOCAL)).toBe(false);
  });

  it('never on mobile or without terminal gate; in demo mode, without restrictions', () => {
    const on = meta({ available: true });
    expect(citySceneAvailable(src(on), { ...LOCAL, remote: true })).toBe(false);
    expect(citySceneAvailable(src(on), { ...LOCAL, local: false })).toBe(false);
    expect(citySceneAvailable(src(on), { ...LOCAL, terminal: false })).toBe(false);
    expect(citySceneAvailable(src(on, true), { remote: false, local: false, terminal: false, fake: true })).toBe(true);
  });
});

/** Minimal element for World button in Node environment (only what `h()` and `render()` touch). */
class ElementStub {
  className = '';
  textContent = '';
  innerHTML = '';
  title = '';
  hidden = false;
  classList = { toggle: () => {} };
  setAttribute(): void {}
  addEventListener(): void {}
  append(): void {}
}

describe('SceneSwitch.leaveFor', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** The scene (fake host) and UI as in ui/index.ts: `ctx.select` goes through guard before selecting. */
  function setup() {
    vi.stubGlobal('document', { createElement: () => new ElementStub() });
    const host = {
      open: false as boolean,
      show: vi.fn(async () => void (host.open = true)),
      hide: vi.fn(() => void (host.open = false)),
      zoomBy() {},
      recenter() {},
      escape: () => false,
    } satisfies CitySceneHost;
    let selection: Selection = null;
    const selected: Selection[] = [];
    const inCityAtSelect: boolean[] = [];
    let sw!: SceneSwitch;
    const ctx = {
      store: { replaying: false, liveSnapshot: undefined },
      isTimelapseOpen: () => false,
      announce: vi.fn(),
      selection: () => selection,
      select: (sel: Selection) => {
        sw.leaveFor(sel);
        inCityAtSelect.push(host.open);
        selected.push(sel);
        selection = sel;
      },
    } as unknown as UiContext;
    const onChange = vi.fn();
    sw = new SceneSwitch(ctx, src(meta({ available: true }), true), host, onChange);
    return { host, ctx, sw, onChange, selected, inCityAtSelect, setSelection: (s: Selection) => (selection = s) };
  }

  it('with city open, selecting an agent or room returns to office before selecting', () => {
    for (const sel of [{ type: 'agent', id: 'a1' }, { type: 'room', id: 'r1' }] as const) {
      const { host, ctx, sw, onChange, inCityAtSelect } = setup();
      host.open = true;
      ctx.select(sel);
      expect(host.hide).toHaveBeenCalledTimes(1);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(sw.inCity).toBe(false);
      expect(inCityAtSelect).toEqual([false]);
    }
  });

  it('deselecting (null) does not close city, and outside city nothing changes', () => {
    const a = setup();
    a.host.open = true;
    a.ctx.select(null);
    expect(a.host.hide).not.toHaveBeenCalled();
    expect(a.onChange).not.toHaveBeenCalled();
    expect(a.sw.inCity).toBe(true);

    const b = setup();
    b.ctx.select({ type: 'agent', id: 'a1' });
    expect(b.host.hide).not.toHaveBeenCalled();
    expect(b.onChange).not.toHaveBeenCalled();
  });

  it('opening city with an agent selected deselects without returning to office', async () => {
    const { host, sw, selected, setSelection } = setup();
    setSelection({ type: 'agent', id: 'a1' });
    await sw.open();
    expect(selected).toEqual([null]);
    expect(host.show).toHaveBeenCalledTimes(1);
    expect(host.hide).not.toHaveBeenCalled();
    expect(sw.inCity).toBe(true);
  });
});
