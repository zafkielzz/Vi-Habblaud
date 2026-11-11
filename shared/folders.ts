// Office folders, compared the same way by the server (server/team.ts checkFolder, on real paths) and the page
// (client/src/ui/offices.ts folderProblem, on the paths as typed). Pure string work: tested in folders.test.ts.

/** How folder `f` stands to another office's folder: the same, inside it, around it, or apart (''). */
export type FolderRelation = 'same' | 'inside' | 'contains' | '';

/** "/a/b/" -> "/a/b", "C:\a\" -> "C:\a" (but "/" and "C:\" stay). */
export function trimFolder(folder: string): string {
  const t = folder.trim();
  if (isDiskRoot(t)) return t;
  return t.length > 1 ? t.replace(/[\\/]+$/, '') : t;
}

/** The whole disk ("/", "C:\", "C:"): never an office's folder. */
export function isDiskRoot(folder: string): boolean {
  const t = folder.trim();
  return /^[\\/]+$/.test(t) || /^[a-zA-Z]:[\\/]*$/.test(t);
}

export function folderRelation(f: string, other: string): FolderRelation {
  const a = trimFolder(f);
  const b = trimFolder(other);
  if (!a || !b) return '';
  if (a === b) return 'same';
  const under = (x: string, y: string) => x.startsWith(`${y}/`) || x.startsWith(`${y}\\`);
  if (under(a, b)) return 'inside';
  if (under(b, a)) return 'contains';
  return '';
}

/**
 * The relations that make a folder unusable for an office: two offices never share one folder. Nested folders are fine
 * (an office for ~/Workspace and one for ~/Workspace/app): a room belongs to the office with the deepest folder holding
 * it (server/team.ts place). Team files from before this rule still load (folderOverlap warns).
 */
export const FOLDER_CLASH: ReadonlySet<FolderRelation> = new Set<FolderRelation>(['same']);

/**
 * The other office whose folder an extra write folder of an office's rules (OfficeRules.scope.write) overlaps: a rule
 * may not open another office's folder to editing. Paths as given ("~/…" only compares with "~/…" folders: the server
 * checks them expanded).
 */
export function writeFolderClash<O extends { id: string; folder: string }>(path: string, offices: readonly O[], self: string): O | undefined {
  return offices.find((o) => o.id !== self && o.folder && folderRelation(path, o.folder) !== '');
}
