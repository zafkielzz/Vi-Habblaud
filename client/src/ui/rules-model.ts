// What the page shows of an office's rules ("Nội quy", shared/rules.ts), from the snapshot (pure: rules-model.test.ts):
// the count on the 📜 button, today's violations, a one-line scope, and the checks of an edited copy before saving.
import type { OfficeInfo } from '../../../shared/types';
import { RULES_MAX, type OfficeRules, type RuleFor, type RuleViolation } from '../../../shared/rules';
import { isDiskRoot, trimFolder, writeFolderClash } from '../../../shared/folders';
import { shortPath } from './spawn';
import { tr } from '../../../shared/i18n';

/** The rules that are on. */
export function activeRules(rules: Pick<OfficeRules, 'items'> | undefined): number {
  return rules?.items.filter((r) => r.on).length ?? 0;
}

/** Midnight (local) of the day of `now`. */
function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The office's violations since midnight (newest first, as the server sends them). */
export function violationsToday(violations: readonly RuleViolation[] | undefined, now: number): RuleViolation[] {
  const since = dayStart(now);
  return (violations ?? []).filter((v) => v.at >= since);
}

export const VIOLATION_ICON: Record<RuleViolation['kind'], string> = { deny: '🚫', outside: '📁', command: '⛔', cwd: '📂', jobs: '🧮', quota: '⏳' };

/** "Blocked a forbidden path", per kind. */
export function violationLabel(kind: RuleViolation['kind']): string {
  switch (kind) {
    case 'deny':
      return tr('forbidden path');
    case 'outside':
      return tr('edit outside the scope');
    case 'command':
      return tr('forbidden command');
    case 'cwd':
      return tr('job folder outside the scope');
    case 'jobs':
      return tr('too many jobs running');
    case 'quota':
      return tr('worker quota too high');
  }
}

export function forLabel(f: RuleFor): string {
  return f === 'boss' ? tr('boss') : f === 'workers' ? tr('workers') : tr('everyone');
}

/** One line: where it may edit, how many paths are forbidden, which commands. '' without rules. */
export function scopeLine(office: Pick<OfficeInfo, 'folder' | 'rules'>): string {
  const r = office.rules;
  if (!r) return '';
  const where = [office.folder, ...r.scope.write].filter(Boolean).map(shortPath);
  const parts = [where.length ? tr('✏️ {0}', [where.join(', ')]) : tr('✏️ no folder yet')];
  if (r.scope.deny.length) parts.push(tr('🚫 {0} hidden', [r.scope.deny.length]));
  if (r.scope.commands.length) parts.push(tr('⛔ {0}', [r.scope.commands.join(', ')]));
  return parts.join(' · ');
}

/** A text area's lines: trimmed, without blanks and repeats. */
export function linesOf(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/** What is wrong with an edited copy (empty = it can be saved). */
export function rulesProblems(draft: Pick<OfficeRules, 'scope' | 'items' | 'limits'>, office: Pick<OfficeInfo, 'id'>, offices: readonly OfficeInfo[]): string[] {
  const out: string[] = [];
  for (const p of draft.scope.write) {
    if (!p.startsWith('/') && !p.startsWith('~/')) out.push(tr('{0}: write the full path (starting with / or ~/).', [p]));
    else if (isDiskRoot(p) || trimFolder(p) === '~') out.push(tr('{0} is too wide to be a write folder', [p]));
    else {
      const other = writeFolderClash(p, offices, office.id);
      if (other) out.push(tr("{0} overlaps the folder of {1}: an office's rules cannot open another office's folder.", [p, other.name]));
    }
  }
  if (draft.scope.write.length > RULES_MAX.paths || draft.scope.deny.length > RULES_MAX.paths) out.push(tr('At most {0} paths per list.', [RULES_MAX.paths]));
  if (draft.scope.commands.length > RULES_MAX.commands) out.push(tr('At most {0} commands.', [RULES_MAX.commands]));
  if (draft.items.length > RULES_MAX.items) out.push(tr('At most {0} rules.', [RULES_MAX.items]));
  if (draft.items.some((r) => !r.text.trim())) out.push(tr('A rule has no text.'));
  if (draft.items.some((r) => r.text.length > RULES_MAX.text)) out.push(tr('A rule is longer than {0} characters.', [RULES_MAX.text]));
  const { maxJobs, quotaStop } = draft.limits;
  if (maxJobs !== undefined && !(Number.isInteger(maxJobs) && maxJobs >= 1 && maxJobs <= 50)) out.push(tr('Running jobs: a number from 1 to 50 (empty = no limit).'));
  if (quotaStop !== undefined && !(Number.isInteger(quotaStop) && quotaStop >= 1 && quotaStop <= 100)) out.push(tr('Quota stop: a % from 1 to 100 (empty = no limit).'));
  return out;
}

/** The part of the rules the user edits (proposals and rev stay the server's). */
export type RulesDraft = Pick<OfficeRules, 'scope' | 'items' | 'limits'>;

export function draftOf(rules: OfficeRules): RulesDraft {
  return JSON.parse(JSON.stringify({ scope: rules.scope, items: rules.items, limits: rules.limits })) as RulesDraft;
}

export function sameDraft(a: RulesDraft, b: RulesDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A new rule id, unused in the list. */
export function newRuleId(items: ReadonlyArray<{ id: string }>): string {
  let n = items.length + 1;
  while (items.some((r) => r.id === `r${n}`)) n++;
  return `r${n}`;
}
