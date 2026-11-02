// Screen of each interactive terminal on the server (@xterm/headless + @xterm/addon-serialize, optional dependencies
// like node-pty). Anyone connecting later, reconnecting, or switching tabs receives the current screen already
// rendered, with modes enabled by Claude Code at startup (bracketed paste, application keys, mouse, alternate screen).
// Without them, replaying raw output would lose these modes: pasting multiple lines would become multiple prompts.
import { errMsg } from '../log';
import type { PtyScreen, ScreenFactory } from './manager';
import { tr } from '../../shared/i18n';

/** Scrollback lines retained per terminal. */
const SCROLLBACK = 5_000;

interface HeadlessTerminal {
  write(data: string, cb?: () => void): void;
  resize(cols: number, rows: number): void;
  loadAddon(addon: unknown): void;
  dispose(): void;
}

interface SerializeAddon {
  serialize(opts?: { scrollback?: number }): string;
}

/** Loads @xterm/headless and serialize addon. Returns null + reason if unavailable. */
export async function loadHeadlessScreen(): Promise<{ create: ScreenFactory | null; reason?: string }> {
  try {
    const headless = (await import('@xterm/headless')) as unknown as { Terminal?: unknown; default?: { Terminal?: unknown } };
    const serialize = (await import('@xterm/addon-serialize')) as unknown as { SerializeAddon?: unknown; default?: { SerializeAddon?: unknown } };
    const Terminal = (headless.Terminal ?? headless.default?.Terminal) as (new (o: Record<string, unknown>) => HeadlessTerminal) | undefined;
    const Serialize = (serialize.SerializeAddon ?? serialize.default?.SerializeAddon) as (new () => SerializeAddon) | undefined;
    if (!Terminal || !Serialize) return { create: null, reason: tr('@xterm/headless has no Terminal or SerializeAddon') };
    return {
      create: (cols, rows): PtyScreen => {
        const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
        const ser = new Serialize();
        term.loadAddon(ser);
        return {
          write: (data, done) => term.write(data, done),
          resize: (c, r) => term.resize(c, r),
          serialize: () => ser.serialize({ scrollback: SCROLLBACK }),
          dispose: () => term.dispose(),
        };
      },
    };
  } catch (err) {
    return { create: null, reason: tr('@xterm/headless not installed ({0})', [errMsg(err)]) };
  }
}
