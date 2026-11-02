// Messages from office (POST /api/messages): shared between server, demo, and client page.
// Pure code: no Node or DOM APIs.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';

/** Maximum message length (characters). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` for "Message via Habblaud" activity (not an agent tool: it is incoming user text). */
export const MESSAGE_TOOL = 'HabblaudMessage';
/** Activity detail: start of text, masked and truncated (full text only goes to session). */
const DETAIL_MAX = 300;

/**
 * "Message via Habblaud" activity for a message delivered to session (received or queued: does not mean
 * agent has read it yet).
 */
export function describeMessage(text: string): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  return { kind: 'communicate', icon: '✉️', text: tr('Message via Habblaud'), tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}


/** Choices the drawer offers (`/model <alias>`, `/effort <level>`); `default` = back to the configured model. */
export const SESSION_MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'default'] as const;
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
