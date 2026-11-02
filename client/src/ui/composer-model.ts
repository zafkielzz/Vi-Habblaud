// Message composer (ui/composer.ts), pure logic tested in ui/composer-model.test.ts: when composer appears (and
// why not), what Enter does, status line for each send, and delivery polling cadence.
// In Codex, message enters session queue (`codex queue`) and becomes prompt when idle: "Delivered" means
// this; without a delivery bridge (in Docker, host bridge), hint suggests `npm run codex:bridge`.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxStatus, Provider } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Hint for users with feature enabled, but agent session does not have plugin connected. */
export const PLUGIN_HINT = tr('To send messages from here: npm run mod:install (plugin habblaud-mensagens)');
/** Same hint for Codex agent without delivery bridge (in Node mode server delivers itself). */
export const CODEX_BRIDGE_HINT = tr('To send messages to Codex: with Habblaud in Docker, keep npm run codex:bridge running; in Node mode it works on its own');

/**
 * - ready: can send (main agent with plugin connected, feature enabled, local page);
 * - hint: feature enabled and main agent present, but session lacks plugin (`text` explains how to install);
 * - off: cannot send (`text` explains why). Drawer hides composer; terminal displays reason instead.
 */
export type ComposerMode = { kind: 'ready' } | { kind: 'hint'; text: string } | { kind: 'off'; text: string };

export interface ComposerEnv {
  /** Feature enabled on server (OfficeSnapshot.meta.messages; in ?mock=1, always). */
  enabled: boolean;
  /** Page opened from local computer (server only accepts messages this way). */
  local: boolean;
  /** Timelapse: office displayed is from the replayed moment. */
  replaying: boolean;
}

export function composerMode(agent: AgentInfo | undefined, env: ComposerEnv): ComposerMode {
  if (env.replaying) return { kind: 'off', text: tr('No messages in timelapse: the office shown is from another moment') };
  if (agent?.kind === 'sub') return { kind: 'off', text: tr("Subagents don't receive messages: write to the main agent") };
  if (!agent || agent.status === 'offline' || agent.status === 'done') return { kind: 'off', text: tr('Session ended') };
  const codex = agent.provider === 'codex';
  if (!env.enabled) return { kind: 'off', text: codex ? tr('To reply, use Codex') : tr('To reply, use the Claude Code terminal') };
  if (!env.local) return { kind: 'off', text: tr('To send messages from here, open Habblaud at http://localhost (or 127.0.0.1)') };
  if (!agent.canMessage) return { kind: 'hint', text: codex ? CODEX_BRIDGE_HINT : PLUGIN_HINT };
  return { kind: 'ready' };
}

/** Hint under composer (drawer): how message enters the session. */
export function composerTip(provider: Provider = 'claude'): string {
  return provider === 'codex'
    ? tr("Joins the session queue and becomes the next prompt when Codex finishes what it's doing. Enter sends; Shift+Enter adds a new line.")
    : tr('Goes into the session as if you had typed it. Enter sends; Shift+Enter adds a new line.');
}

/** Composer output: typed text without trailing whitespace or blank lines. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, '');
}

export function canSend(raw: string): boolean {
  const text = messageText(raw);
  return text.trim().length > 0 && text.length <= MESSAGE_MAX;
}

/** Enter sends; Shift+Enter (and Alt+Enter) insert newline; Enter during IME composition does not count. */
export function enterSends(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

/**
 * Status of an agent's last send: `sending` (POST pending), `rejected` (server rejected: text remains in
 * composer), or server message status (OutboxStatus).
 */
export type SendPhase = 'sending' | 'rejected' | OutboxStatus;

export interface SendState {
  phase: SendPhase;
  /** Server message id (after 201). */
  id?: string;
  error?: string;
  /** Last change (epoch ms, page clock). */
  at: number;
}

export function isSettled(phase: SendPhase): boolean {
  return phase === 'delivered' || phase === 'failed' || phase === 'rejected';
}

/** "Delivered" dismisses automatically after this delay; errors stay until next send. */
export const DELIVERED_SHOW_MS = 12_000;

/** Status line text ('' = nothing to show). */
export function sendStatusText(s: SendState | undefined, now: number, provider: Provider = 'claude'): string {
  if (!s) return '';
  const codex = provider === 'codex';
  switch (s.phase) {
    case 'sending':
      return tr('Sending…');
    case 'queued':
      return codex ? tr('Queued: delivering to Codex…') : tr('Queued: waiting for the session to pick up the message…');
    case 'sent':
      return tr('Delivering to the session…');
    case 'delivered':
      // Delivered = entered session or its queue (if agent is busy, enters when turn ends). In
      // Codex it is always the queue: session owner polls every ~10 s and consumes only when idle.
      if (now - s.at >= DELIVERED_SHOW_MS) return '';
      return codex
        ? tr("Delivered ✓ to the session queue: goes in when Codex finishes what it's doing (up to ~10 s)")
        : tr('Delivered ✓ (if the agent is busy, it goes in when it finishes)');
    case 'rejected':
      return tr("Couldn't send: {0}", [s.error ?? tr('unknown error')]);
    case 'failed':
      return tr('Not delivered: {0}', [s.error ?? tr('unknown error')]);
  }
}

/** Delivery polling: server takes up to ~90 s to give up (60 s in queue + 30 s unconfirmed). */
export const POLL_LIMIT_MS = 120_000;

/** Delay until next poll: frequent early on (session polls every 2 s), spaced out later. */
export function pollDelay(elapsed: number): number {
  if (elapsed < 10_000) return 700;
  if (elapsed < 40_000) return 1_500;
  return 3_000;
}

export const LOST_ERROR = tr('Habblaud no longer knows this message (did it restart?)');
export const TIMEOUT_ERROR = tr('no word on delivery: check the Claude Code terminal');
export const CODEX_TIMEOUT_ERROR = tr('no word on delivery: check Codex');
export const OFFLINE_ERROR = tr("couldn't reach Habblaud");

/** Polling timeout reached with no word: where to check. */
export function timeoutError(provider: Provider = 'claude'): string {
  return provider === 'codex' ? CODEX_TIMEOUT_ERROR : TIMEOUT_ERROR;
}
