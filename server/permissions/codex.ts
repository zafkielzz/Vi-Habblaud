// Codex approval requests (PermissionRequest hook in mod/habblaud-codex/hook.mjs): title, summary, and arguments
// by tool names sent by Codex in the hook (0.162):
// - Bash: {command, description?}. Network access also arrives as Bash, with description "network-access <target>";
// - apply_patch: {command: <the patch>} ("*** Begin Patch", "*** Update File: <path>", -/+ lines): sent as diff;
// - request_permissions: {reason, permissions};
// - mcp__<server>__<tool>: MCP tool arguments;
// - write_stdin: {session_id, chars, ...}. Here `session_id` is a PROCESS id (terminal where agent
//   types), not the session id; `chars` might be a password typed into a prompt: title only shows size and text
//   (masked) is kept in details, only returned via GET /api/permissions/:id.
// Everything masked (maskSecrets) and trimmed as in the terminal.
import { basename, describeTool, maskSecrets, truncate } from '../../shared/activity';
import type { TerminalInputKind } from '../../shared/types';
import { TITLE_ARG_MAX, toolView } from '../sources/terminal';
import { tr } from '../../shared/i18n';

/** Codex request summary: what goes into PermissionRequestInfo (title, text, icon, input, inputKind). */
export interface CodexToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

type Rec = Record<string, unknown>;

/** Summary length (same as activities). */
const TEXT_MAX = 46;
/** Bash description prefix for network access requests. */
const NETWORK = /^network-access\s+(\S[\s\S]*)$/;
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** A masked and trimmed line. */
function line(s: string, max: number): string {
  return truncate(maskSecrets(s.slice(0, max * 8)), max);
}

/** Masked and trimmed text as terminal displays arguments (same handling as Bash command). */
function shown(raw: string | undefined, inputKind: TerminalInputKind): Pick<CodexToolView, 'input' | 'inputKind'> {
  const input = raw?.trim() ? toolView('Bash', { command: raw }).input : undefined;
  return input ? { input, inputKind } : {};
}

function relPath(p: string, cwd: string | undefined): string {
  if (!cwd || !p.startsWith('/')) return p;
  const base = cwd.replace(/\/+$/, '');
  return base && p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
}

/** Files in an apply_patch patch, in order. */
export function patchFiles(patch: string | undefined): Array<{ op: 'Add' | 'Update' | 'Delete'; path: string }> {
  if (!patch) return [];
  return [...patch.slice(0, 200_000).matchAll(PATCH_FILE)].map((m) => ({ op: m[1] as 'Add' | 'Update' | 'Delete', path: m[2].trim() }));
}

/** Text from write_stdin with visible control characters ("y\n", "\u0003"). */
function escaped(chars: string): string {
  return JSON.stringify(chars.slice(0, 2_000)).slice(1, -1);
}

/** Title, summary, and arguments of a Codex request. */
export function codexToolView(tool: string, input: Rec, cwd?: string): CodexToolView {
  switch (tool) {
    case 'Bash': {
      const command = str(input.command);
      const target = NETWORK.exec(str(input.description)?.trim() ?? '')?.[1];
      if (target) return { title: tr('Network({0})', [line(target, TITLE_ARG_MAX)]), text: line(tr('Access the network: {0}', [target]), TEXT_MAX), icon: '🌐', ...shown(command, 'command') };
      const view = toolView('Bash', { command: command ?? '' }, cwd);
      const desc = describeTool('Bash', { command: command ?? '', description: str(input.description) });
      return { title: view.title, text: desc.text, icon: desc.icon, ...shown(command, 'command') };
    }
    case 'apply_patch': {
      const patch = str(input.command) ?? str(input.patch) ?? str(input.input);
      const files = patchFiles(patch);
      const first = files[0];
      const more = files.length > 1 ? ` +${files.length - 1}` : '';
      const title = first ? `apply_patch(${line(relPath(first.path, cwd), TITLE_ARG_MAX)}${more})` : 'apply_patch';
      const name = first ? line(basename(first.path), TEXT_MAX) : '';
      const [text, icon] =
        files.length > 1
          ? [tr('Editing {0} files', [files.length]), '✏️']
          : first?.op === 'Add'
            ? [tr('Creating {0}', [name]), '📝']
            : first?.op === 'Delete'
              ? [tr('Deleting {0}', [name]), '🗑️']
              : [first ? tr('Editing {0}', [name]) : tr('Applying a patch'), '✏️'];
      return { title, text: truncate(text, TEXT_MAX), icon, ...shown(patch, 'diff') };
    }
    case 'request_permissions': {
      const view = toolView(tool, input, cwd);
      return { ...view, text: tr('Asking for more permissions'), icon: '🔐' };
    }
    case 'write_stdin': {
      const chars = typeof input.chars === 'string' ? input.chars : '';
      const title = chars ? `write_stdin(${chars.length} caractere${chars.length === 1 ? '' : 's'})` : 'write_stdin';
      return { title, text: tr('Typing into a terminal process'), icon: '⌨️', ...shown(chars ? escaped(chars) : undefined, 'text') };
    }
    default: {
      const view = toolView(tool, input, cwd);
      const desc = describeTool(tool, input);
      return { ...view, text: desc.text, icon: desc.icon };
    }
  }
}
