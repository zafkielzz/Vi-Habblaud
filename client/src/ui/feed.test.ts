import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, FeedItem } from '../../../shared/types';
import type { SocialEvent } from '../world/api';
import type { UiContext } from './context';
import { FeedPanel } from './feed';

/** Minimal elements to exercise the panel in Node environment, without canvas or animations. */
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  className = '';
  textContent = '';
  hidden = false;
  title = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  scrollHeight = 1_000;
  scrollTop = 0;
  clientHeight = 100;
  isConnected = false;
  private attrs = new Map<string, string>();
  private handlers = new Map<string, (() => void)[]>();
  classList = {
    contains: (name: string) => this.className.split(' ').includes(name),
    add: (name: string) => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
    remove: (name: string) => { this.className = this.className.split(' ').filter((c) => c !== name).join(' '); },
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name); },
  };
  style = { getPropertyValue: () => '', setProperty: () => {} };

  constructor(readonly tag: string) {}
  get firstChild(): Element | null { return this.children[0] ?? null; }
  get firstElementChild(): Element | null { return this.firstChild; }
  get nextSibling(): Element | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  addEventListener(name: string, cb: () => void): void { this.handlers.set(name, [...(this.handlers.get(name) ?? []), cb]); }
  fire(name: string): void { this.handlers.get(name)?.forEach((cb) => cb()); }
  append(...children: Element[]): void { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child: Element, cursor: Element | null): void {
    child.remove();
    this.children.splice(cursor ? this.children.indexOf(cursor) : this.children.length, 0, child);
    child.parentElement = this;
  }
  remove(): void {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  querySelector(tag: string): Element | null { return this.children.find((c) => c.tag === tag) ?? null; }
  getContext(): null { return null; }
  toDataURL(): string { return 'data:image/png;base64,'; }
}

function agent(id: string, account = '.claude'): AgentInfo {
  return {
    id, account, kind: 'main', roomId: 'r', name: id, look: 'f', role: 'Main agent', sessionId: id,
    status: 'working', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, seed: 1,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
  };
}

function item(id: string, a: AgentInfo): FeedItem {
  return { id, agentId: a.id, agentName: a.name, account: a.account, roomId: a.roomId, roomName: 'Room', activity: { id, kind: 'other', icon: '💬', text: id, at: 0 } };
}

let elements: Element[];
function panel(feed: FeedItem[] = [], agents: AgentInfo[] = []) {
  let receive!: (fresh: FeedItem[]) => void;
  let social!: (e: SocialEvent) => void;
  const snapshot = { agents, rooms: [] };
  const prefs = { hiddenAccounts: [] as string[] };
  let open = true;
  const ctx = {
    store: { feed, snapshot, on: (_event: string, cb: typeof receive) => { receive = cb; } },
    world: { onSocialEvent: (cb: typeof social) => { social = cb; } },
    prefs, agent: (id: string) => snapshot.agents.find((a) => a.id === id), account: () => undefined,
    invalidate: () => {}, togglePanel: () => {}, isPanelOpen: () => open,
  } as unknown as UiContext;
  const view = new FeedPanel(ctx);
  view.render();
  const el = (name: string) => elements.find((e) => e.className === name)!;
  return { view, receive: (fresh: FeedItem[]) => receive(fresh), social: (e: SocialEvent) => social(e), snapshot, prefs, close: () => { open = false; },
    scroller: el('ui-feed__scroll'), list: el('ui-feed__list'), pill: el('ui-feed__new') };
}

beforeEach(() => {
  elements = [];
  vi.stubGlobal('document', { createElement: (tag: string) => { const el = new Element(tag); elements.push(el); return el; } });
  vi.stubGlobal('HTMLElement', Element);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1; });
});
afterEach(() => vi.unstubAllGlobals());

describe('FeedPanel when paused', () => {
  it.each(['SSE', 'social'])('keeps only the 50 newest events from %s, without losing per-account counts', (source) => {
    const shown = agent('visible');
    const hidden = agent('hidden', '.claude-2');
    const old = item('before', shown);
    const p = panel([old], [shown, hidden]);
    p.scroller.scrollTop = 0;
    p.scroller.fire('scroll');
    const fresh = Array.from({ length: 120 }, (_, i) => item(`new-${i}`, i < 70 ? shown : hidden));
    if (source === 'SSE') p.receive(fresh);
    else for (const f of fresh) p.social({ id: f.id, agentId: f.agentId, at: f.activity.at, icon: f.activity.icon, text: f.activity.text, place: f.roomName });
    // Retention is checked only to verify memory ceiling, in addition to panel output.
    const retained = (p.view as unknown as { pending: FeedItem[] }).pending;
    expect(retained).toHaveLength(50);
    expect(retained.map((f) => f.id)).toEqual(fresh.slice(70).map((f) => f.id));
    p.view.render();
    expect(p.list.children.map((e) => e.dataset.key)).toEqual(['before']);
    expect(p.pill.textContent).toBe('99 new');
    p.prefs.hiddenAccounts = ['.claude-2'];
    p.view.render();
    expect(p.pill.hidden).toBe(false);
    expect(p.pill.textContent).toBe('70 new');
    p.prefs.hiddenAccounts = [];
    p.pill.fire('click');
    p.view.render();
    expect(p.list.children.map((e) => e.dataset.key)).toEqual(fresh.slice(70).map((f) => f.id));
    expect(p.pill.hidden).toBe(true);
    p.scroller.scrollTop = 0;
    p.scroller.fire('scroll');
    p.receive([item('after', shown)]);
    p.view.render();
    expect(p.pill.textContent).toBe('1 new');
  });

  it.each(['resume', 'collapse'])('preserves row metadata and pending items, releasing the rest on %s', (action) => {
    const old = agent('old');
    const p = panel([item('before', old)], [old]);
    const meta = (p.view as unknown as { meta: Map<string, Pick<AgentInfo, 'seed' | 'account'>> }).meta;
    p.scroller.scrollTop = 0;
    p.scroller.fire('scroll');
    for (let i = 0; i < 51; i++) {
      const a = agent(`session-${i}`);
      p.snapshot.agents = [a];
      p.receive([item(`new-${i}`, a)]);
      p.view.render();
    }
    const retainedIds = ['old', ...Array.from({ length: 50 }, (_, i) => `session-${i + 1}`)];
    expect([...meta.keys()]).toEqual(retainedIds);
    // Agent departure does not erase appearance/account of retained events; present agents
    // remain even without events (render would recreate them every frame).
    p.snapshot.agents = [agent('no-event')];
    p.view.render();
    expect([...meta.keys()]).toEqual([...retainedIds, 'no-event']);
    expect(meta.get('session-1')).toEqual(expect.objectContaining({ seed: 1, account: '.claude' }));
    if (action === 'resume') p.pill.fire('click');
    else p.close();
    p.view.render();
    expect([...meta.keys()]).toEqual([...retainedIds.slice(1), 'no-event']);
    expect(p.list.children).toHaveLength(50);
    expect(p.list.children[0].firstElementChild!.children[1].dataset.sig).toContain('1|f|main|');
  });
});
