// The project's handoff file (HANDOFF*.md in the room folder, the note one session leaves for the next): its "next
// steps" section becomes the plan in the Board's Tasks tab, next to the boss's todo list. Read only when the file
// changes (mtime), no tokens.
//
// Section: the first heading whose text says "next" (EN), "tiếp theo" (VI) or "próximos" (PT), or "todo"; its items
// are the top-level list entries (`-`, `*`, `1.`, with their wrapped lines) until the next heading of the same or
// higher level. Sub-items (and what follows them) are left out; a checkbox (`- [x]`) or a struck-through item marks it
// done. The Board edits that list in place (editHandoff): tick, add, remove, or start one.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HandoffPlan } from '../../shared/types';

const FILE = /^HANDOFF.*\.md$/i;
const NEXT = /\b(next|todo|to do)\b|tiếp theo|próxim/i;
/** A long list stays readable on the Board (the file keeps everything). */
const MAX_ITEMS = 60;
const MAX_TEXT = 200;

/** Markdown inline marks out (bold, italics, code, links): the dialog shows plain text. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s: string): string {
  return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT - 1).trimEnd()}…`;
}

/** A top-level item of the section: its lines [first, last] in the file, and whether it is done. */
export interface PlanLine {
  first: number;
  last: number;
  text: string;
  done: boolean;
}

/** Where the "next steps" section is: its heading line, level, and top-level items; undefined when there is none. */
export function planSection(lines: readonly string[]): { headingLine: number; level: number; heading: string; end: number; items: PlanLine[] } | undefined {
  let start = -1;
  let level = 0;
  let heading = '';
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
    if (m && NEXT.test(m[2])) {
      start = i + 1;
      level = m[1].length;
      heading = plain(m[2].replace(/\s*\(.*\)\s*$/, ''));
      break;
    }
  }
  if (start < 0) return undefined;
  const items: PlanLine[] = [];
  let open = false;
  let fence = false;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || /^\s*```/.test(line)) {
      open = false;
      continue;
    }
    const h = /^(#{1,6})\s/.exec(line);
    if (h && h[1].length <= level) {
      end = i;
      break;
    }
    const m = ITEM.exec(line);
    if (m) {
      items.push({ first: i, last: i, text: m[3], done: isDone(m[2], m[3]) });
      open = true;
      continue;
    }
    // sub-items and wrapped lines belong to the item above (only wrapped lines add to its text)
    const cur = items[items.length - 1];
    if (cur && line.trim() && !h) {
      cur.last = i;
      if (open && !/^\s*(?:[-*+]|\d+[.)])\s/.test(line)) cur.text += ` ${line.trim()}`;
      else open = false;
    } else if (!line.trim()) open = false;
  }
  return { headingLine: start - 1, level, heading, end, items };
}

/** A top-level list line: marker, optional checkbox, text. */
const ITEM = /^((?:[-*+]|\d+[.)])\s+)(?:\[([ xX])\]\s+)?(.*)$/;

/** Done: a ticked checkbox, or the whole item struck through ("~~…~~", how older notes mark it). */
function isDone(box: string | undefined, text: string): boolean {
  return (!!box && box !== ' ') || /^~~.+?~~/.test(text.trim());
}

/** The "next steps" section of a handoff file; undefined when there is none or it has no list. */
export function parseHandoff(md: string): Omit<HandoffPlan, 'file' | 'mtime'> | undefined {
  const sec = planSection(md.split(/\r?\n/));
  if (!sec) return undefined;
  const items: HandoffPlan['items'] = [];
  for (const r of sec.items) {
    const text = clip(plain(r.text.replace(/~~/g, '')).replace(/:$/, ''));
    if (text && items.length < MAX_ITEMS) items.push(r.done ? { text, done: true } : { text });
  }
  return { heading: sec.heading, items };
}

/** An edit of the to-do list from the Board: tick or untick, add, remove (by item index), or start the list. */
export type PlanEdit = { op: 'toggle'; index: number; done: boolean } | { op: 'add'; text: string } | { op: 'remove'; index: number } | { op: 'create'; heading: string; text?: string };

/**
 * Applies an edit to the file's text, touching only the section's lines: ticking turns "- x" into "- [x] x" (and
 * unticking removes the box and a strike-through), adding appends "- [ ] text" (numbered when the list is), removing
 * drops the item with its sub-items. Undefined when the edit does not apply (no section, index out of range).
 */
export function editHandoff(md: string, edit: PlanEdit): string | undefined {
  const nl = md.includes('\r\n') ? '\r\n' : '\n';
  const lines = md.split(/\r?\n/);
  const sec = planSection(lines);
  const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim();
  if (edit.op === 'create') {
    if (sec) return undefined;
    const body = [`## ${oneLine(edit.heading)}`, '', ...(edit.text ? [`- [ ] ${oneLine(edit.text)}`] : [])];
    const head = lines.length === 1 && !lines[0] ? [] : [...lines.slice(0, lines.at(-1) === '' ? -1 : undefined), ''];
    return [...head, ...body, ''].join(nl);
  }
  if (!sec) return undefined;
  if (edit.op === 'add') {
    const text = oneLine(edit.text);
    if (!text) return undefined;
    const last = sec.items.at(-1);
    const marker = last ? ITEM.exec(lines[last.first])![1] : '- ';
    const numbered = /^(\d+)([.)])(\s+)$/.exec(marker);
    const mark = numbered ? `${Number(numbered[1]) + 1}${numbered[2]}${numbered[3]}` : marker;
    const at = last ? last.last + 1 : sec.headingLine + 1;
    const add = last ? [`${mark}[ ] ${text}`] : ['', `- [ ] ${text}`];
    return [...lines.slice(0, at), ...add, ...lines.slice(at)].join(nl);
  }
  const item = sec.items[edit.index];
  if (!item) return undefined;
  if (edit.op === 'remove') return [...lines.slice(0, item.first), ...lines.slice(item.last + 1)].join(nl);
  const m = ITEM.exec(lines[item.first])!;
  let text = m[3];
  if (!edit.done) text = text.replace(/^~~(.+?)~~/, '$1');
  lines[item.first] = `${m[1]}[${edit.done ? 'x' : ' '}] ${text}`;
  return lines.join(nl);
}

/** Newest HANDOFF*.md at the top of `dir` (path and mtime); undefined when there is none. */
export function findHandoff(dir: string): { path: string; mtime: number } | undefined {
  let best: { path: string; mtime: number } | undefined;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (!FILE.test(name)) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { path: join(dir, name), mtime: st.mtimeMs };
    } catch {
      // gone in the meantime
    }
  }
  return best;
}

/** Plans per folder, re-read only when the newest handoff file (or its mtime) changes. */
export class HandoffReader {
  private readonly cache = new Map<string, { path: string; mtime: number; plan?: HandoffPlan }>();

  read(dir: string): HandoffPlan | undefined {
    const found = findHandoff(dir);
    if (!found) {
      this.cache.delete(dir);
      return undefined;
    }
    const hit = this.cache.get(dir);
    if (hit && hit.path === found.path && hit.mtime === found.mtime) return hit.plan;
    let plan: HandoffPlan | undefined;
    try {
      const parsed = parseHandoff(readFileSync(found.path, 'utf8'));
      if (parsed) plan = { file: found.path.slice(dir.length).replace(/^[\\/]/, ''), mtime: found.mtime, ...parsed };
    } catch {
      // unreadable: no plan
    }
    this.cache.set(dir, { ...found, plan });
    return plan;
  }
}
