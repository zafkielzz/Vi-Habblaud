// Deliveries: completion of each request worked on by an agent, as a BA would receive it. Read from recent
// session transcripts (terminal history): a request starts at your prompt and ends at the next prompt (or end
// of file, if the agent is no longer working). Becomes a delivery when the agent used tools and responded.
// - headline: first sentence of the response; summary: last prose paragraph ("in plain English");
// - attachments: SendUserFile files (with caption) and links to image/PDF/video/page in response, plus
//   last two screenshots in the request (images embedded in the transcript).
// Each transcript is re-read only when it changes (mtime/size). Attachments get opaque ids: browser never sees paths.
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { tr } from '../../shared/i18n';
import type { DeliveryAttachment, DeliveryInfo, Provider, RecentSession, TerminalEntry } from '../../shared/types';
import type { TerminalParser } from '../sources/terminal';
import { FileTail } from '../sources/tail';
import { fileType, pathProblem } from './files';

/** How much of the end of each transcript is read (older requests in long session are omitted). */
export const TAIL_BYTES = 6 * 1024 * 1024;
export const MAX_SESSIONS = 30;
export const MAX_DELIVERIES = 60;
const CAPTURES_PER_DELIVERY = 2;
/** Only recent requests in each conversation keep captured screenshots (base64): rest of memory omitted. */
const TURNS_WITH_CAPTURES = 4;
const HEADLINE_MAX = 180;
const SUMMARY_MAX = 600;
const REQUEST_MAX = 240;
const MIN_TEXT = 30;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
/** Previewable file paths cited in response: markdown links or bare paths. */
const LINK_RE = /\]\(\s*<?([^)\s>]+?\.(?:png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm|html?))(?::\d+)?>?\s*\)/gi;
const BARE_RE = /(?:^|[\s(`"'])(\/[^\s`"'()<>]+?\.(?:png|jpe?g|gif|webp|svg|pdf|mp4|mov|webm|html?))(?=$|[\s`"'),.;:!?])/gim;

export interface SessionSource {
  path: string;
  createParser: () => TerminalParser;
}

export interface DeliveryIndexOptions {
  sessions: () => Promise<RecentSession[]>;
  resolve: (account: string, sessionId: string) => SessionSource | undefined;
  /** Agent is mid-request (the last request is not yet a delivery). */
  isBusy: (agentId: string) => boolean;
  agentName?: (agentId: string) => string | undefined;
}

export type StoredAttachment =
  | { kind: 'capture'; type: string; data: Buffer; name: string }
  | { kind: 'file'; path: string; name: string; type: string };

interface Turn {
  start: TerminalEntry & { kind: 'user' };
  tools: number;
  edited: Set<string>;
  text: string;
  textAt: number;
  files: Array<{ path: string; caption?: string }>;
  captures: Array<{ type: string; data: string }>;
  /** Transcript records stop reason (Claude Code): only turn-ending text counts as delivery (end_turn). */
  marksStop: boolean;
  ended: boolean;
}

interface Parsed {
  mtimeMs: number;
  size: number;
  /** Completed requests (including last, if file ended after it). */
  turns: Turn[];
  /** Last request in the file (may be in progress). */
  last?: Turn;
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

function stripMarkdown(s: string): string {
  return s
    .replace(/`{3}[\s\S]*?`{3}/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\s)[*_](\S[^*_]*?)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max - 1);
  const sp = head.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? head.slice(0, sp) : head).replace(/[\s,;:.-]+$/, '')}…`;
}

function paragraphs(text: string): string[] {
  return text
    .replace(/`{3}[\s\S]*?`{3}/g, '\n\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

const isProse = (p: string) => !/^(\||#|>|[-*+]\s|\d+[.)]\s|`{3})/.test(p) && !/^[A-Z_ ]+:\s/.test(p);

/** First sentence of response (headline), markdown stripped. */
export function headlineOf(text: string): string {
  const first = paragraphs(text).find(isProse) ?? paragraphs(text)[0] ?? '';
  const plain = stripMarkdown(first);
  const m = /^(.+?[.!?])(\s|$)/.exec(plain);
  return cut(m ? m[1] : plain, HEADLINE_MAX);
}

/** Last prose paragraph (plain English summary), if different from headline. */
export function summaryOf(text: string, headline: string): string | undefined {
  const paras = paragraphs(text).filter(isProse);
  const last = paras[paras.length - 1];
  if (!last || paras.length < 2) return undefined;
  const plain = stripMarkdown(last);
  if (plain.length < 60 || plain.startsWith(headline.replace(/…$/, ''))) return undefined;
  return cut(plain, SUMMARY_MAX);
}

/** Previewable file paths cited in response (absolute, or relative to project root). */
export function linkedFiles(text: string, project?: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    let p = raw.trim();
    try {
      p = decodeURIComponent(p);
    } catch {
      // kept as is
    }
    if (p.startsWith('file://')) p = p.slice(7);
    if (/^[a-z]+:/i.test(p)) return;
    if (!isAbsolute(p)) {
      if (!project) return;
      p = join(project, p);
    }
    p = normalize(p);
    if (!pathProblem(p)) out.add(p);
  };
  for (const m of text.matchAll(LINK_RE)) add(m[1]);
  for (const m of text.matchAll(BARE_RE)) add(m[1]);
  return [...out];
}

function newTurn(start: TerminalEntry & { kind: 'user' }): Turn {
  return { start, tools: 0, edited: new Set(), text: '', textAt: start.at, files: [], captures: [], marksStop: false, ended: false };
}

/** Images inside tool results (screenshots), in order. */
function capturesIn(line: string): Array<{ type: string; data: string }> {
  if (!line.includes('"image"')) return [];
  let d: Rec | undefined;
  try {
    d = rec(JSON.parse(line));
  } catch {
    return [];
  }
  const content = rec(d?.message)?.content;
  if (d?.type !== 'user' || !Array.isArray(content)) return [];
  const out: Array<{ type: string; data: string }> = [];
  const take = (b: unknown) => {
    const src = rec(rec(b)?.source);
    if (rec(b)?.type === 'image' && src?.type === 'base64' && typeof src.data === 'string' && typeof src.media_type === 'string' && /^image\/(png|jpeg|webp|gif)$/.test(src.media_type)) {
      out.push({ type: src.media_type, data: src.data });
    }
  };
  for (const b of content) {
    if (rec(b)?.type === 'tool_result' && Array.isArray(rec(b)?.content)) (rec(b)!.content as unknown[]).forEach(take);
  }
  return out;
}

/** Files sent via SendUserFile (path and caption). */
function sentFilesIn(line: string): Array<{ path: string; caption?: string }> {
  if (!line.includes('"SendUserFile"')) return [];
  let d: Rec | undefined;
  try {
    d = rec(JSON.parse(line));
  } catch {
    return [];
  }
  const content = rec(d?.message)?.content;
  if (d?.type !== 'assistant' || !Array.isArray(content)) return [];
  const out: Array<{ path: string; caption?: string }> = [];
  for (const b of content) {
    const r = rec(b);
    if (r?.type !== 'tool_use' || r.name !== 'SendUserFile') continue;
    const input = rec(r.input);
    const caption = typeof input?.caption === 'string' && input.caption.trim() ? input.caption.trim() : undefined;
    for (const f of Array.isArray(input?.files) ? input.files : []) if (typeof f === 'string') out.push({ path: f, caption });
  }
  return out;
}

/** Stop reason for a Claude Code response line ('end_turn', 'tool_use'...), if any. */
function stopReasonOf(line: string): string | null | undefined {
  if (!line.includes('"stop_reason"')) return undefined;
  const m = /"stop_reason"\s*:\s*(null|"([a-z_]+)")/.exec(line);
  return m ? (m[2] ?? null) : undefined;
}

/** Reads end of a transcript and splits requests. */
export function parseTurns(lines: Iterable<string>, parser: TerminalParser): { turns: Turn[]; last?: Turn } {
  const turns: Turn[] = [];
  let cur: Turn | undefined;
  for (const line of lines) {
    for (const e of parser.push(line)) {
      if (e.kind === 'user') {
        if (cur) turns.push(cur);
        cur = newTurn(e);
      } else if (!cur) continue;
      else if (e.kind === 'assistant') {
        cur.text = e.text;
        cur.textAt = e.at;
        const stop = stopReasonOf(line);
        if (stop !== undefined && stop !== null) {
          cur.marksStop = true;
          cur.ended = stop === 'end_turn';
        }
      } else if (e.kind === 'tool') {
        cur.tools++;
        if (EDIT_TOOLS.has(e.tool)) cur.edited.add(e.title);
      }
    }
    if (!cur) continue;
    cur.files.push(...sentFilesIn(line));
    const caps = capturesIn(line);
    if (caps.length) cur.captures = [...cur.captures, ...caps].slice(-CAPTURES_PER_DELIVERY);
  }
  return { turns, last: cur };
}

const shortId = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

export class DeliveryIndex {
  private readonly cache = new Map<string, Parsed>();
  private files = new Map<string, StoredAttachment>();

  constructor(private readonly opts: DeliveryIndexOptions) {}

  /** Attachment by opaque id (only deliveries from the latest listing). */
  attachment(id: string): StoredAttachment | undefined {
    return this.files.get(id);
  }

  async list(): Promise<DeliveryInfo[]> {
    const sessions = (await this.opts.sessions()).slice(0, MAX_SESSIONS);
    const out: DeliveryInfo[] = [];
    const files = new Map<string, StoredAttachment>();
    const seen = new Set<string>();
    for (const s of sessions) {
      const src = this.opts.resolve(s.account, s.sessionId);
      if (!src) continue;
      seen.add(src.path);
      const parsed = this.read(src);
      if (!parsed) continue;
      const busy = !!s.agentId && this.opts.isBusy(s.agentId);
      const turns = parsed.last && !busy ? [...parsed.turns, parsed.last] : parsed.turns;
      for (const t of turns) {
        const d = this.toDelivery(s, t, files);
        if (d) out.push(d);
      }
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    this.files = files;
    return out.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, MAX_DELIVERIES);
  }

  private read(src: SessionSource): Parsed | undefined {
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(src.path);
    } catch {
      return undefined;
    }
    const cached = this.cache.get(src.path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached;
    const tail = new FileTail(src.path);
    try {
      tail.seekTail(TAIL_BYTES);
      const lines: string[] = [];
      for (let i = 0; i < 64; i++) {
        const r = tail.read();
        lines.push(...r.lines);
        if (!r.more) break;
      }
      const { turns, last } = parseTurns(lines, src.createParser());
      for (const t of turns.slice(0, Math.max(0, turns.length - (last ? TURNS_WITH_CAPTURES - 1 : TURNS_WITH_CAPTURES)))) t.captures = [];
      const parsed: Parsed = { mtimeMs: st.mtimeMs, size: st.size, turns, last };
      this.cache.set(src.path, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  private toDelivery(s: RecentSession, t: Turn, files: Map<string, StoredAttachment>): DeliveryInfo | undefined {
    const text = t.text.trim();
    if (!t.tools || text.length < MIN_TEXT || (t.marksStop && !t.ended)) return undefined;
    const id = `${s.account}:${s.sessionId}:${t.start.id}`;
    const attachments: DeliveryAttachment[] = [];
    const paths = new Map<string, string | undefined>();
    for (const f of t.files) if (!pathProblem(f.path) && !paths.has(f.path)) paths.set(f.path, f.caption);
    for (const p of linkedFiles(text, s.project)) if (!paths.has(p)) paths.set(p, undefined);
    for (const [path, caption] of paths) {
      const ft = fileType(path);
      if (!ft) continue;
      const aid = shortId(`${id}|${path}`);
      files.set(aid, { kind: 'file', path, name: baseName(path), type: ft.type });
      attachments.push({ id: aid, name: baseName(path), kind: ft.kind, ...(caption ? { caption } : {}) });
    }
    t.captures.forEach((c, i) => {
      const aid = shortId(`${id}|capture|${i}`);
      const ext = c.type.split('/')[1] === 'jpeg' ? 'jpg' : c.type.split('/')[1];
      const name = `tela-${i + 1}.${ext}`;
      files.set(aid, { kind: 'capture', type: c.type, data: Buffer.from(c.data, 'base64'), name });
      attachments.push({ id: aid, name, kind: 'image', caption: tr('Screenshot taken by the agent'), capture: true });
    });
    const headline = headlineOf(text);
    const summary = summaryOf(text, headline);
    const agentName = s.agentId ? this.opts.agentName?.(s.agentId) : undefined;
    const provider: Provider | undefined = s.provider;
    return {
      id,
      account: s.account,
      ...(provider && provider !== 'claude' ? { provider } : {}),
      sessionId: s.sessionId,
      ...(s.agentId ? { agentId: s.agentId } : {}),
      ...(agentName || s.title ? { agentName: agentName ?? s.title } : {}),
      ...(s.project ? { project: s.project } : {}),
      request: cut(stripMarkdown(t.start.text), REQUEST_MAX),
      headline,
      ...(summary ? { summary } : {}),
      text: text.slice(0, 40_000),
      startedAt: t.start.at,
      finishedAt: t.textAt,
      tools: t.tools,
      edited: t.edited.size,
      attachments,
    };
  }
}
