// The client app: store (data) -> world (canvas) -> UI (panels). Loaded by main.ts after the active language
// dictionary, because several modules call tr() upon loading.
import { loadAccess } from './net/access';
import { OfficeStore } from './net/store';
import { createWorld, type WorldApi } from './world';
import { createUI } from './ui';
import type { CitySceneHost } from './ui/world/scene-switch';
import type { CityScene } from './world/city';
import { migrateLegacyKeys, safeLocalStorage } from './ui/prefs';
import { getLocale, tr } from '../../shared/i18n';

export function start(): void {
  // First of all: the world (desks) and the UI (preferences) read localStorage when created.
  migrateLegacyKeys(safeLocalStorage());

  // Chosen language (shared/i18n): screen readers and the browser spellchecker follow the lang attribute.
  document.documentElement.lang = getLocale();
  document.querySelector('meta[name="description"]')?.setAttribute(
    'content',
    tr('Pixel-art virtual office that shows, in real time, what your Claude Code agents are doing.'),
  );

  const params = new URLSearchParams(location.search);
  const store = new OfficeStore({ mock: params.has('mock') });
  const worldCanvas = document.getElementById('world') as HTMLCanvasElement;
  // "hold Alt" note (ui/hints.ts)
  worldCanvas.dataset.hint = tr('The office: click a character or room for details, drag to move, wheel to zoom');
  const uiRoot = document.getElementById('ui') as HTMLElement;
  const world = createWorld(worldCanvas, store);
  const city = cityHost({ world, worldCanvas, uiRoot, mock: store.mock, params, version: () => store.liveSnapshot?.meta.version ?? '' });
  createUI(uiRoot, store, world, city);
  // What this page can do (local port or remote with login) arrives before the first snapshot (or times out in a
  // few seconds and keeps the previous rule).
  if (store.mock) store.connect();
  else {
    void loadAccess().finally(() => store.connect());
    // Reconnection (server restarted, phone back from lock): access may have changed, and login may have expired
    // (loadAccess navigates to the login screen).
    let opened = false;
    store.on('connection', (state) => {
      if (state === 'open') {
        if (opened) void loadAccess();
        opened = true;
      } else if (state === 'closed' && opened) void loadAccess();
    });
  }

  // Facilitates debugging via the browser console.
  Object.assign(window, { habblaud: { store, world, city } });
}

/**
 * The city scene for Habblaud World (World button): a second canvas on top of the office, loaded only the
 * first time it opens (those who don't use World won't download the city). With the city on screen, the office stops
 * rendering and keyboard controls go to the city; Esc or the Office button returns.
 */
function cityHost(o: { world: WorldApi; worldCanvas: HTMLCanvasElement; uiRoot: HTMLElement; mock: boolean; params: URLSearchParams; version: () => string }): CitySceneHost & { scene(): CityScene | null } {
  let scene: CityScene | null = null;
  let loading: Promise<CityScene> | null = null;
  let open = false;
  const canvas = document.createElement('canvas');
  canvas.id = 'city';
  canvas.hidden = true;
  o.worldCanvas.after(canvas);
  const load = (): Promise<CityScene> =>
    (loading ??= Promise.all([import('./world/city'), import('./net/world-stream')]).then(([m, ws]) => {
      // Demo mode: mock city (`?perf=N` fills N plots, for benchmarking). Live: the stream from the local server
      // (GET /api/world/stream and POST /api/world/cmd).
      const perf = Number(o.params.get('perf'));
      const buildings = o.mock && Number.isFinite(perf) && perf > 0 ? { buildings: perf } : {};
      // the mock city remembers where I was between one stream and the next on this page (like the server, per account)
      const memory = {};
      scene = m.createCityScene({
        canvas,
        uiRoot: o.uiRoot,
        openStream: () => ws.createWorldStream({ mock: o.mock, ...buildings, memory }),
        options: () => o.world.getOptions(),
        topInset: () => o.uiRoot.querySelector('.ui-topbar')?.getBoundingClientRect().bottom ?? 64,
        version: () => o.version(),
      });
      return scene;
    }));
  return {
    get open() {
      return open;
    },
    async show() {
      const s = await load();
      open = true;
      o.world.setSuspended?.(true);
      o.worldCanvas.hidden = true;
      s.show();
    },
    hide() {
      open = false;
      scene?.hide();
      o.worldCanvas.hidden = false;
      o.world.setSuspended?.(false);
    },
    zoomBy: (f) => scene?.zoomBy(f),
    recenter: () => scene?.recenter(),
    escape: () => scene?.escape() ?? false,
    visitOwn: () => scene?.visitOwn(),
    scene: () => scene,
  };
}
