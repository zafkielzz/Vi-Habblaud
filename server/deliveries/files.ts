// Delivery files: what can be displayed in the office. Only files the agent actually delivered (the server
// only requests paths in a delivery) and only viewable types (image, PDF, video, page, text), never
// anything resembling secrets (.ssh, .env, keys, credentials...). Read by server (Node mode, or mounted
// directory in Docker) or host helper (scripts/codex-bridge.ts), which re-checks everything before reading.
// Pure Node with no dependencies: also imported by host helper (via tsx).
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DeliveryAttachmentKind } from '../../shared/types';
import { tr } from '../../shared/i18n';

export const DELIVERY_FILE_MAX_BYTES = 25 * 1024 * 1024;

const TYPES: Readonly<Record<string, { kind: DeliveryAttachmentKind; type: string }>> = {
  png: { kind: 'image', type: 'image/png' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  gif: { kind: 'image', type: 'image/gif' },
  webp: { kind: 'image', type: 'image/webp' },
  svg: { kind: 'image', type: 'image/svg+xml' },
  pdf: { kind: 'pdf', type: 'application/pdf' },
  mp4: { kind: 'video', type: 'video/mp4' },
  mov: { kind: 'video', type: 'video/quicktime' },
  webm: { kind: 'video', type: 'video/webm' },
  html: { kind: 'page', type: 'text/html; charset=utf-8' },
  htm: { kind: 'page', type: 'text/html; charset=utf-8' },
  md: { kind: 'text', type: 'text/plain; charset=utf-8' },
  txt: { kind: 'text', type: 'text/plain; charset=utf-8' },
  csv: { kind: 'text', type: 'text/plain; charset=utf-8' },
  log: { kind: 'text', type: 'text/plain; charset=utf-8' },
  xlsx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  docx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  pptx: { kind: 'file', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  zip: { kind: 'file', type: 'application/zip' },
};

/** Directories and names that never leave, even if an agent "delivers" them (e.g. text injected in transcript). */
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/gh|\.config\/gcloud|Keychains|\.habblaud\/remote-tls)(\/|$)/i;
const SECRET_NAMES = /(^|\/)(\.env[^/]*|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx)|[^/]*(secret|credential|password|senha|token)[^/]*)$/i;

export function extensionOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** View kind and Content-Type, or undefined if file extension is not previewable. */
export function fileType(path: string): { kind: DeliveryAttachmentKind; type: string } | undefined {
  return TYPES[extensionOf(path)];
}

/** Reason NOT to display the path (inspecting text only), or undefined. */
export function pathProblem(path: string): string | undefined {
  if (!path || path.includes('\0') || !path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) return tr('invalid path');
  if (!fileType(path)) return tr("file type that can't be shown here");
  if (SECRET_DIRS.test(path) || SECRET_NAMES.test(path)) return tr('protected file');
  return undefined;
}

/** Checks on disk (resolved links, size, regular file). Returns real path or reason. */
export function checkFile(
  path: string,
  fs: { realpath(p: string): string; stat(p: string): { isFile(): boolean; size: number } } = { realpath: realpathSync, stat: statSync },
): { path: string; size: number } | { error: string } {
  const bad = pathProblem(path);
  if (bad) return { error: bad };
  let real: string;
  let st: { isFile(): boolean; size: number };
  try {
    real = fs.realpath(path);
    st = fs.stat(real);
  } catch {
    return { error: tr('file not found') };
  }
  const realBad = pathProblem(real);
  if (realBad) return { error: realBad };
  if (!st.isFile()) return { error: tr('not a file') };
  if (st.size > DELIVERY_FILE_MAX_BYTES) return { error: tr('file too large to view here') };
  return { path: real, size: st.size };
}

/** Temporary directories where agents save drafts and screenshots (system tmp and common macOS/Linux paths). */
export function tempRoots(): string[] {
  const out = new Set<string>(['/tmp', '/private/tmp', '/var/folders', '/private/var/folders']);
  try {
    out.add(realpathSync(tmpdir()));
  } catch {
    out.add(tmpdir());
  }
  return [...out];
}

/**
 * Real path file is in a directory that host helper can read: a project directory that some Claude Code
 * account knows (it or an ancestor has <account>/projects/<encoded dir>) or one of `roots` (temporary
 * folders, Habblaud attachments). This prevents requests from container reaching rest of computer.
 */
export function insideKnownFolder(
  path: string,
  opts: { accountDirs: readonly string[]; roots: readonly string[]; exists?: (p: string) => boolean },
): boolean {
  if (opts.roots.some((r) => r && path.startsWith(`${r.replace(/\/+$/, '')}/`))) return true;
  const exists = opts.exists ?? existsSync;
  // Same encoding as sources/watcher.ts (encodeCwd): every non-alphanumeric character becomes "-".
  for (let dir = dirname(path); dir.split('/').filter(Boolean).length >= 2; dir = dirname(dir)) {
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    if (opts.accountDirs.some((acc) => exists(join(acc, 'projects', encoded)))) return true;
  }
  return false;
}
