// Office folders compared the same way by the server and the page.
import { describe, expect, it } from 'vitest';
import { FOLDER_CLASH, folderRelation, isDiskRoot, trimFolder, writeFolderClash } from './folders';

describe('office folders', () => {
  it('trims trailing separators but keeps a disk root', () => {
    expect(trimFolder(' /a/b/ ')).toBe('/a/b');
    expect(trimFolder('/')).toBe('/');
    expect(trimFolder('C:\\')).toBe('C:\\');
    expect(trimFolder('C:\\a\\')).toBe('C:\\a');
  });

  it('the whole disk', () => {
    for (const f of ['/', '//', 'C:', 'C:\\', 'd:/']) expect(isDiskRoot(f)).toBe(true);
    for (const f of ['/home', 'C:\\a', '', 'rel']) expect(isDiskRoot(f)).toBe(false);
  });

  it('same, inside, around or apart (not fooled by a shared prefix)', () => {
    expect(folderRelation('/w/a/', '/w/a')).toBe('same');
    expect(folderRelation('/w/a/b', '/w/a')).toBe('inside');
    expect(folderRelation('/w', '/w/a')).toBe('contains');
    expect(folderRelation('/w/ab', '/w/a')).toBe('');
    expect(folderRelation('C:\\w\\a', 'C:\\w')).toBe('inside');
    expect(folderRelation('', '/w')).toBe('');
  });

  it('office folders never overlap; an extra write folder may not reach another office', () => {
    expect([...FOLDER_CLASH]).toEqual(['same']);
    const offices = [{ id: 'a', folder: '/w/a' }, { id: 'b', folder: '/w/b' }];
    expect(writeFolderClash('/w/b/docs', offices, 'a')?.id).toBe('b');
    expect(writeFolderClash('/w', offices, 'a')?.id).toBe('b');
    expect(writeFolderClash('/w/a/x', offices, 'a')).toBeUndefined();
    expect(writeFolderClash('/tmp/out', offices, 'a')).toBeUndefined();
  });
});
