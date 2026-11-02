// Lightweight, safe Markdown for agent responses in the terminal.
// The tokenizer (blocks and inline spans) is pure and tested in ui/markdown.test.ts; rendering uses only
// createElement/textContent: no transcript text goes through innerHTML.
//
// Coverage (what Claude Code typically writes): ``` blocks with language, `code`, **bold**, *italic*,
// # headings, bulleted and numbered lists (with nesting), > blockquotes, horizontal rules, tables
// (preserved as preformatted text), and links (rendered as text; destination URL in tooltip).

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'link'; text: string; href: string };

export interface MdListItem {
  /** Nesting depth (0 = top level). */
  depth: number;
  /** Original marker: "-", "*", "+", or "1.", "2)"... */
  marker: string;
  ordered: boolean;
  text: string;
}

export type MdBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'list'; ordered: boolean; items: MdListItem[] }
  | { type: 'quote'; text: string }
  | { type: 'table'; text: string }
  | { type: 'rule' };

const MAX_DEPTH = 5;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const RULE_RE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** Table delimiter line: | --- | :---: | (with or without edge pipes). */
const TABLE_SEP_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$|^\s*\|\s*:?-+:?\s*\|\s*$/;

function isFenceClose(line: string, fence: string): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
}

function isTableStart(lines: readonly string[], i: number): boolean {
  const line = lines[i];
  if (!line.includes('|')) return false;
  if (i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) return true;
  // Without delimiter: counts as a table only if at least two consecutive lines start with "|".
  return line.trimStart().startsWith('|') && i + 1 < lines.length && lines[i + 1].trimStart().startsWith('|');
}

/** A line that interrupts a paragraph (starts another block). */
function startsBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i];
  if (FENCE_RE.test(line) || HEADING_RE.test(line) || QUOTE_RE.test(line) || RULE_RE.test(line)) return true;
  const li = LIST_RE.exec(line);
  // As in CommonMark, an ordered list only interrupts a paragraph if it starts with 1.
  if (li && (!/^\d/.test(li[2]) || /^1[.)]$/.test(li[2]))) return true;
  return isTableStart(lines, i);
}

const blank = (line: string) => line.trim() === '';

/** Splits text into blocks. Pure. */
export function tokenizeBlocks(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const indent = line.length - line.trimStart().length;
      const body: string[] = [];
      i++;
      // Unclosed fence (response still being written or truncated): runs to the end.
      while (i < lines.length && !isFenceClose(lines[i], fence[1])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
        i++;
      }
      i++;
      out.push({ type: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push({ type: 'heading', level: heading[1].length, text: (heading[2] ?? '').replace(/\s+#+$/, '') });
      i++;
      continue;
    }

    if (RULE_RE.test(line)) {
      out.push({ type: 'rule' });
      i++;
      continue;
    }

    if (isTableStart(lines, i)) {
      const rows: string[] = [];
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) rows.push(lines[i++]);
      out.push({ type: 'table', text: rows.join('\n') });
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      let m: RegExpExecArray | null;
      while (i < lines.length && (m = QUOTE_RE.exec(lines[i]))) {
        body.push(m[1]);
        i++;
      }
      out.push({ type: 'quote', text: body.join('\n') });
      continue;
    }

    if (LIST_RE.test(line)) {
      const items: MdListItem[] = [];
      const indents: number[] = [];
      const indentOf = (m: RegExpExecArray) => m[1].replace(/\t/g, '    ').length;
      // Switching bullet to number (or vice versa) at top level starts a new list.
      const sameList = (m: RegExpExecArray) => !items.length || indentOf(m) > indents[0] || /^\d/.test(m[2]) === items[0].ordered;
      while (i < lines.length) {
        const cur = lines[i];
        const m = LIST_RE.exec(cur);
        if (m && sameList(m)) {
          const indent = indentOf(m);
          while (indents.length && indent < indents[indents.length - 1]) indents.pop();
          if (!indents.length || indent > indents[indents.length - 1]) indents.push(indent);
          const ordered = /^\d/.test(m[2]);
          items.push({ depth: Math.min(MAX_DEPTH, indents.length - 1), marker: m[2], ordered, text: m[3] });
          i++;
          continue;
        }
        if (blank(cur)) {
          // Loose list (items separated by blank line): continues if next item follows immediately.
          let j = i;
          while (j < lines.length && blank(lines[j])) j++;
          const next = j < lines.length ? LIST_RE.exec(lines[j]) : null;
          if (next && sameList(next)) {
            i = j;
            continue;
          }
          break;
        }
        // Continuation of previous item (indented line that isn't another block).
        if (/^\s{2,}\S/.test(cur) && !FENCE_RE.test(cur)) {
          items[items.length - 1].text += `\n${cur.trim()}`;
          i++;
          continue;
        }
        break;
      }
      out.push({ type: 'list', ordered: items[0].ordered, items });
      continue;
    }

    const para: string[] = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push({ type: 'paragraph', text: para.join('\n') });
  }
  return out;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

function pushText(out: MdInline[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

/** End of a single delimiter (* or _) starting from `from`, skipping double (**, __). -1 if none. */
function findSingleClose(src: string, from: number, ch: string): number {
  let j = from;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === '`') {
      // Does not close inside inline code.
      const end = src.indexOf('`', j + 1);
      if (end === -1) return -1;
      j = end + 1;
      continue;
    }
    if (src[j] === ch) {
      if (src[j + 1] === ch) {
        j += 2;
        continue;
      }
      if (!/\s/.test(src[j - 1] ?? ' ') && (ch !== '_' || !WORD.test(src[j + 1] ?? ''))) return j;
    }
    j++;
  }
  return -1;
}

/** Inline spans of a line/paragraph (code, bold, italic, links). Pure. */
export function tokenizeInline(src: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '\\' && i + 1 < src.length && PUNCT.test(src[i + 1])) {
      pushText(out, src[i + 1]);
      i += 2;
      continue;
    }

    if (ch === '`') {
      let run = 1;
      while (src[i + run] === '`') run++;
      const fence = '`'.repeat(run);
      let j = src.indexOf(fence, i + run);
      // The closing delimiter must have the exact same length.
      while (j !== -1 && src[j + run] === '`') {
        let k = j;
        while (src[k] === '`') k++;
        j = src.indexOf(fence, k);
      }
      if (j === -1) {
        pushText(out, fence);
        i += run;
        continue;
      }
      let code = src.slice(i + run, j).replace(/\n/g, ' ');
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      out.push({ type: 'code', text: code });
      i = j + run;
      continue;
    }

    if (ch === '[') {
      const close = src.indexOf(']', i + 1);
      if (close > i + 1 && src[close + 1] === '(') {
        const end = src.indexOf(')', close + 2);
        const href = end === -1 ? '' : src.slice(close + 2, end).trim();
        if (end !== -1 && href && !/\s/.test(href.split(/\s+"/)[0])) {
          out.push({ type: 'link', text: src.slice(i + 1, close), href: href.split(/\s+"/)[0] });
          i = end + 1;
          continue;
        }
      }
    }

    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const prev = src[i - 1] ?? ' ';
      const opensOk = !/\s/.test(src[i + 2] ?? ' ') && (ch === '*' || !WORD.test(prev));
      const close = opensOk ? src.indexOf(ch + ch, i + 2) : -1;
      if (close > i + 2 && !/\s/.test(src[close - 1]) && (ch === '*' || !WORD.test(src[close + 2] ?? ''))) {
        out.push({ type: 'strong', children: tokenizeInline(src.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
      pushText(out, ch + ch);
      i += 2;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const prev = src[i - 1] ?? ' ';
      const opensOk = !/\s/.test(src[i + 1] ?? ' ') && (ch === '*' || !WORD.test(prev));
      const close = opensOk ? findSingleClose(src, i + 1, ch) : -1;
      if (close > i + 1) {
        out.push({ type: 'em', children: tokenizeInline(src.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }

    pushText(out, ch);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------- rendering (DOM)

/** List bullets by nesting level, as in Claude Code. */
const BULLETS = ['•', '◦', '▪', '▫'];

function appendInline(parent: HTMLElement, nodes: readonly MdInline[]): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        parent.append(document.createTextNode(n.text));
        break;
      case 'code': {
        const el = document.createElement('code');
        el.className = 'ui-md__code';
        el.textContent = n.text;
        parent.append(el);
        break;
      }
      case 'strong':
      case 'em': {
        const el = document.createElement(n.type);
        appendInline(el, n.children);
        parent.append(el);
        break;
      }
      case 'link': {
        // Link becomes text (nothing clickable from transcript); address is in the tooltip.
        const el = document.createElement('span');
        el.className = 'ui-md__link';
        el.textContent = n.text || n.href;
        el.title = n.href;
        parent.append(el);
        break;
      }
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  return node;
}

/** Renders markdown as DOM nodes (textContent only: safe for transcript text). */
export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const b of tokenizeBlocks(src)) {
    switch (b.type) {
      case 'paragraph': {
        const p = el('p', 'ui-md__p');
        appendInline(p, tokenizeInline(b.text));
        frag.append(p);
        break;
      }
      case 'heading': {
        const p = el('p', `ui-md__h ui-md__h${Math.min(b.level, 3)}`);
        appendInline(p, tokenizeInline(b.text));
        frag.append(p);
        break;
      }
      case 'code': {
        const box = el('div', 'ui-md__block');
        if (b.lang) {
          const lang = el('span', 'ui-md__lang');
          lang.textContent = b.lang;
          box.append(lang);
        }
        const pre = el('pre', 'ui-md__pre');
        pre.textContent = b.text;
        box.append(pre);
        frag.append(box);
        break;
      }
      case 'list': {
        const list = el(b.ordered ? 'ol' : 'ul', 'ui-md__list');
        for (const it of b.items) {
          const li = el('li', 'ui-md__li');
          li.style.setProperty('--d', String(it.depth));
          const mark = el('span', 'ui-md__mark');
          mark.textContent = it.ordered ? it.marker : BULLETS[it.depth % BULLETS.length];
          mark.setAttribute('aria-hidden', 'true');
          const body = el('span', 'ui-md__item');
          appendInline(body, tokenizeInline(it.text));
          li.append(mark, body);
          list.append(li);
        }
        frag.append(list);
        break;
      }
      case 'quote': {
        const q = el('blockquote', 'ui-md__quote');
        appendInline(q, tokenizeInline(b.text));
        frag.append(q);
        break;
      }
      case 'table': {
        const pre = el('pre', 'ui-md__table');
        pre.textContent = b.text;
        frag.append(pre);
        break;
      }
      case 'rule':
        frag.append(el('hr', 'ui-md__rule'));
        break;
    }
  }
  return frag;
}
