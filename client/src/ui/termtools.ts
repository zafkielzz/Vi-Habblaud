// Terminal tools: conversation search (case and accent-insensitive matching,
// navigation with "3/17" counter), "All / Prompts only / No tools" filter and copied text for each entry.
// Model functions are pure and tested in ui/termtools.test.ts. Result highlighting replaces text nodes
// with spans created via createElement/textContent: no transcript text passes through innerHTML.
import type { TerminalEntry } from '../../../shared/types';
import type { TerminalItem } from './terminal';
import { tr } from '../../../shared/i18n';

// ---------------------------------------------------------------- filter

export type TerminalFilter = 'all' | 'prompts' | 'noTools';

export const TERMINAL_FILTERS: readonly [TerminalFilter, string, string][] = [
  ['all', tr('All'), tr('The whole conversation')],
  ['prompts', tr('Prompts only'), tr("Only your prompts and the agent's final replies")],
  ['noTools', tr('No tools'), tr('Hides tools and their results')],
];

/**
 * Final replies for each turn: agent text with no tools after it until the next prompt
 * (or the end of conversation). Intermediate texts ("Let me read the file.") are omitted.
 */
export function finalAnswerKeys(items: Iterable<TerminalItem>): Set<string> {
  const finals = new Set<string>();
  let pending: string[] = [];
  for (const item of items) {
    if (item.type !== 'entry') {
      // Tool (or standalone result) after text: it was only an intermediate step.
      pending = [];
      continue;
    }
    const kind = item.entry.kind;
    if (kind === 'assistant') pending.push(item.key);
    else if (kind === 'user') {
      for (const k of pending) finals.add(k);
      pending = [];
    }
  }
  for (const k of pending) finals.add(k);
  return finals;
}

/** Is the item visible under the filter? (`finals` = finalAnswerKeys, used only by "Prompts only".) */
export function itemVisible(item: TerminalItem, filter: TerminalFilter, finals: ReadonlySet<string>): boolean {
  if (filter === 'all') return true;
  if (item.type !== 'entry') return false;
  if (filter === 'noTools') return true;
  return item.entry.kind === 'user' || (item.entry.kind === 'assistant' && finals.has(item.key));
}

// ---------------------------------------------------------------- search

/** "Folded" text for search (lowercase, without accents) and, for each character, where it originated in the source. */
export interface FoldedText {
  text: string;
  /** Start and end (in original) of the character that generated each position of `text`; absent = identity (ASCII). */
  starts?: number[];
  ends?: number[];
}

const ASCII = /^[\x00-\x7f]*$/;
const COMBINING = /[̀-ͯ]/g;

/** Lowercase and without accents ("Action" -> "action"), saving original positions for highlighting. */
export function foldText(s: string): FoldedText {
  if (ASCII.test(s)) return { text: s.toLowerCase() };
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(COMBINING, '').toLowerCase();
    // Combining accent (e + U+0301): omitted from folded text, but previous character highlight includes it.
    if (!f && ends.length) ends[ends.length - 1] = i + ch.length;
    for (let k = 0; k < f.length; k++) {
      starts.push(i);
      ends.push(i + ch.length);
    }
    text += f;
    i += ch.length;
  }
  return { text, starts, ends };
}

/** Folded text only, without position map (to quickly discard strings not matching the query). */
function foldPlain(s: string): string {
  return ASCII.test(s) ? s.toLowerCase() : s.normalize('NFD').replace(COMBINING, '').toLowerCase();
}

/** Search query already folded; whitespace only = no search (''). */
export function foldQuery(query: string): string {
  return query.trim() ? foldText(query).text : '';
}

/** Slices [start, end) of original matching the query (already folded by foldQuery), non-overlapping. */
export function findMatches(text: string, folded: string): [number, number][] {
  if (!folded || !text) return [];
  const f = foldText(text);
  const out: [number, number][] = [];
  for (let i = f.text.indexOf(folded); i !== -1; i = f.text.indexOf(folded, i + folded.length)) {
    const end = i + folded.length;
    out.push(f.starts ? [f.starts[i], f.ends![end - 1]] : [i, end]);
  }
  return out;
}

/** Next (dir = 1) or previous (-1) match, wrapping around; with no current match (-1), starts from first or last. */
export function stepMatch(current: number, total: number, dir: 1 | -1): number {
  if (total <= 0) return -1;
  if (current < 0 || current >= total) return dir === 1 ? 0 : total - 1;
  return (current + dir + total) % total;
}

/** Position of current match in a list of [row key, count of matches] (in display order); -1 if not found. */
export function globalIndex(counts: readonly (readonly [string, number])[], ref: { key: string; index: number } | null): number {
  if (!ref) return -1;
  let base = 0;
  for (const [key, n] of counts) {
    if (key === ref.key) return ref.index < n ? base + ref.index : -1;
    base += n;
  }
  return -1;
}

/** Match at `index` (0 = first) in the same list. */
export function refAt(counts: readonly (readonly [string, number])[], index: number): { key: string; index: number } | null {
  if (index < 0) return null;
  let rest = index;
  for (const [key, n] of counts) {
    if (rest < n) return { key, index: rest };
    rest -= n;
  }
  return null;
}

/** Search counter: "3/17"; with no current match, "0/17". */
export function searchCounter(index: number, total: number): string {
  return `${index >= 0 && index < total ? index + 1 : 0}/${total}`;
}

// ---------------------------------------------------------------- copy

/** What the copy button on an entry puts in the clipboard (the command, in case of a tool). */
export function copyTextOf(e: TerminalEntry): string {
  switch (e.kind) {
    case 'tool':
      return e.input?.trim() ? e.input.replace(/\s+$/, '') : e.title;
    case 'thinking':
      return e.text ?? '';
    case 'system':
      return e.detail?.trim() ? `${e.text}\n${e.detail.replace(/\s+$/, '')}` : e.text;
    default:
      return e.text.replace(/\s+$/, '');
  }
}

// ---------------------------------------------------------------- highlight (DOM)

export const HIT_CLASS = 'ui-term__hit';

/** Elements that are not part of the conversation: buttons, decorative marks and tags (e.g.: "Thinking…", "$", "⎿"). */
function isChrome(el: Element): boolean {
  return el.tagName === 'BUTTON' || el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('data-chrome') || el.classList.contains('ui-md__lang');
}

/** Clears highlights (`hits`) from a row, rejoining text nodes. */
export function clearHits(hits: readonly HTMLElement[]): void {
  const parents = new Set<Node>();
  for (const span of hits) {
    const parent = span.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(span.textContent ?? ''), span);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * Highlights matches with the query (already folded) in `root` and returns spans in document order. Only inspects
 * conversation text nodes (including collapsed blocks hidden in DOM); matches spanning across two elements
 * (e.g. **bo**ld) do not match.
 */
export function highlightHits(root: HTMLElement, folded: string): HTMLElement[] {
  if (!folded || !foldPlain(root.textContent ?? '').includes(folded)) return [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : isChrome(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP),
  });
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  const out: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.data;
    const ranges = findMatches(text, folded);
    if (!ranges.length) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const [a, b] of ranges) {
      if (a > last) frag.append(text.slice(last, a));
      const span = document.createElement('span');
      span.className = HIT_CLASS;
      span.textContent = text.slice(a, b);
      frag.append(span);
      out.push(span);
      last = b;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  return out;
}
