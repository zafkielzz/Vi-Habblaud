// Screenshots of the Habblaud World section in demo mode (?mock=1&world=approved: only fake data from
// FakeWorldApi, nothing from the real office): the "Your building" card (docs/screenshots/world-predio.png), the
// "See what was sent" window (docs/screenshots/world-enviado.png), the mock city (&scene=city: only fake buildings
// and players from FakeWorldStream in client/src/net/world-stream.ts) at dusk (world-cidade.png),
// a building card (world-cartao.png), and visiting a neighbor's building (sample interior from
// shared/world/visit-sample.ts): the office inside (world-visita.png) and the panel with an agent card
// (world-visita-painel.png). During a visit, no /api requests leave the page (demo mode has no
// server; live, the scene only talks to /api/world/*). Lightweight social (Phase 5): greeting wheel with bubbles
// (world-social.png) and the town square at night with the goal thermometer and fireworks (world-praca.png, via
// &fireworks=1 test button). Starts Vite automatically (or uses --url of a running Habblaud) and captures via
// Playwright's headless Chromium without touching the user's browser.
//
// Usage: npm run shots:world [-- --url http://localhost:4747] [--out docs/screenshots] [--chromium /path/to/chrome]
// Without headless Chromium from project playwright-core version: npx playwright-core install chromium-headless-shell,
// or --chromium (or HABBLAUD_CHROMIUM) with the path to another executable.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(root, opt('out') ?? 'docs/screenshots');
const executablePath = opt('chromium') ?? process.env.HABBLAUD_CHROMIUM;

let base = opt('url');
let vite;
if (!base) {
  const { createServer } = await import('vite');
  vite = await createServer({ configFile: join(root, 'vite.config.ts'), server: { port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen();
  base = vite.resolvedUrls.local[0].replace(/\/$/, '');
}

const problems = [];
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2, locale: 'pt-BR' });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  // Portuguese (source language), even with the browser in another language.
  await page.addInitScript(() => localStorage.setItem('habblaud:locale', 'pt-BR'));
  await page.goto(`${base}/?mock=1&world=approved`, { waitUntil: 'load', timeout: 60_000 });

  // The "in the world" top bar chip opens Settings › Habblaud World.
  await page.locator('.ui-world-chip').click({ timeout: 20_000 });
  const card = page.locator('.ui-world__building.is-connected');
  await card.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(600);
  mkdirSync(out, { recursive: true });
  await page.locator('#ui-world').screenshot({ path: join(out, 'world-predio.png'), animations: 'disabled' });
  console.log('saved:', join(out, 'world-predio.png'));

  await card.getByRole('button', { name: 'See what was sent' }).click();
  await page.locator('.ui-world-sent__json').waitFor({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await page.locator('.ui-world-sent').screenshot({ path: join(out, 'world-enviado.png'), animations: 'disabled' });
  console.log('saved:', join(out, 'world-enviado.png'));

  // The city (World button): fixed time, still camera between square and my building, without office notices.
  const city = async (hora, extra = '') => {
    await page.goto(`${base}/?mock=1&world=approved&scene=city&hora=${hora}${extra}`, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => window.habblaud?.city?.scene()?.me(), null, { timeout: 20_000 });
    await page.addStyleTag({ content: '.ui-toasts { display: none !important; }' });
    await page.mouse.move(2, 400);
  };
  await city('19:10');
  await page.evaluate(() => window.habblaud.city.scene().lookAt(47, 20.5, 1.5));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(out, 'world-cidade.png') });
  console.log('saved:', join(out, 'world-cidade.png'));

  // Neighbor building card on hover (lot 4,1: front facade, door on south sidewalk).
  await city('14');
  await page.evaluate(() => window.habblaud.city.scene().lookAt(70, 17, 2));
  await page.waitForTimeout(900);
  const lot = await page.evaluate(() => {
    const s = window.habblaud.city.scene();
    return { a: s.toScreen(65.5, 12), b: s.toScreen(78.5, 25), c: s.toScreen(72, 17) };
  });
  await page.mouse.move(lot.c.x, lot.c.y);
  const hover = page.locator('.ui-city-card');
  await hover.waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
  const box = await hover.boundingBox();
  const x0 = Math.max(0, Math.min(lot.a.x, box.x) - 16);
  const y0 = Math.max(0, Math.min(lot.a.y, box.y) - 16);
  const x1 = Math.min(1400, Math.max(lot.b.x, box.x + box.width) + 16);
  const y1 = Math.min(900, Math.max(lot.b.y, box.y + box.height) + 16);
  await page.screenshot({ path: join(out, 'world-cartao.png'), clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  console.log('saved:', join(out, 'world-cartao.png'));

  // The visit (Phase 4): walk to neighbor door (lot 4,1, lit) and press E.
  await city('14');
  const neighbor = await page.evaluate(() => {
    const s = window.habblaud.city.scene();
    const b = [...s.state.buildings.values()].find((x) => x.lot.x === 4 && x.lot.y === 1);
    return b ? { id: b.id, door: s.doorOf(b.id) } : null;
  });
  if (!neighbor?.door) throw new Error('neighbor building missing on lot (4,1)');
  await page.evaluate((d) => window.habblaud.city.scene().walkTo(d.x, d.y + 0.3), neighbor.door);
  await page.waitForFunction((d) => {
    const m = window.habblaud.city.scene().me();
    return m && !m.moving && Math.hypot(m.x - d.x, m.y - d.y) < 1.2;
  }, neighbor.door, { timeout: 20_000 });
  const apiDuringVisit = [];
  const onRequest = (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/')) apiDuringVisit.push(r.url());
  };
  page.on('request', onRequest);
  await page.keyboard.press('e');
  await page.waitForFunction(() => !!window.habblaud.city.scene().visit(), null, { timeout: 10_000 });
  // indoor social (Phase 5): stamp at reception (goes to reception board), without notice in screenshot
  await page.addStyleTag({ content: '.ui-city-toast { display: none !important; }' });
  await page.locator('.ui-visit-social__stamp').click();
  await page.locator('.ui-visit-social__choice[data-stamp="rocket"]').click();
  await page.mouse.move(700, 880);
  await page.waitForTimeout(2600);
  await page.screenshot({ path: join(out, 'world-visita.png') });
  console.log('saved:', join(out, 'world-visita.png'));
  // the panel: card of the agent waiting for owner
  await page.locator('.ui-visit-agent', { hasText: 'Beatriz' }).click();
  await page.waitForTimeout(900);
  await page.locator('.ui-visit-panel').screenshot({ path: join(out, 'world-visita-painel.png') });
  console.log('saved:', join(out, 'world-visita-painel.png'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.habblaud.city.scene().visit(), null, { timeout: 10_000 });
  page.off('request', onRequest);
  const outside = apiDuringVisit.filter((u) => !new URL(u).pathname.startsWith('/api/world/'));
  if (outside.length) problems.push(`[visit] routes outside /api/world/: ${outside.join(', ')}`);

  // Greeting wheel (G) when a bot passes near my door, with greeting bubbles.
  await city('15:30');
  await page.waitForFunction(
    () => {
      const s = window.habblaud.city.scene();
      const me = s.me();
      return [...s.state.players.values()].some((p) => Math.abs(p.info.pos.y - me.y) < 2 && Math.abs(p.info.pos.x - me.x - 5) < 1.5);
    },
    null,
    { timeout: 60_000, polling: 50 },
  );
  await page.keyboard.press('g');
  await page.locator('.ui-city-wheel').waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForTimeout(700);
  const wheel = await page.evaluate(() => {
    const el = document.querySelector('.ui-city-wheel');
    return { x: parseFloat(el.style.getPropertyValue('--cx')), y: parseFloat(el.style.getPropertyValue('--cy')) };
  });
  await page.screenshot({ path: join(out, 'world-social.png'), clip: { x: Math.max(0, wheel.x - 380), y: Math.max(0, wheel.y - 230), width: 760, height: 420 } });
  console.log('saved:', join(out, 'world-social.png'));

  // Town square at night: week goal thermometer (full, during fireworks), city hall, bunting, and fireworks.
  await city('20:40', '&fireworks=1');
  await page.evaluate(() => window.habblaud.city.scene().lookAt(21, 6, 2));
  await page.locator('.ui-city-testfw').click();
  await page.addStyleTag({ content: '.ui-city-testfw, .ui-city-toast { display: none !important; }' });
  await page.waitForTimeout(1250);
  await page.screenshot({ path: join(out, 'world-praca.png'), clip: { x: 260, y: 130, width: 880, height: 640 } });
  console.log('saved:', join(out, 'world-praca.png'));
} finally {
  await browser.close();
  await vite?.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
