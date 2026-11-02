import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findAgyCliLog, parseAgyCliLog, parseModelLabel, settingsModel } from './clilog';

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('agy log: what a run really applied', () => {
  it('reads the label as model and effort', () => {
    expect(parseModelLabel('Gemini 3.8 Flash (Low)')).toEqual({ model: 'gemini-3.8-flash', effort: 'low' });
    expect(parseModelLabel('Gemini 3.8 Flash')).toEqual({ model: 'gemini-3.8-flash' });
  });

  it('takes the last mode and model lines (print mode and interactive)', () => {
    const log = [
      'I1027 22:51:32.66 1 printmode.go:857] Print mode: applying agent mode plan',
      'I1027 22:51:35.93 1 model_config_manager.go:340] Propagating selected model override to backend: label="Gemini 3.8 Flash (High)"',
      'I1027 22:51:40.00 1 manager.go:1550] SetCycleMode called: accept_edits',
      'I1027 22:51:41.00 1 model_config_manager.go:340] Propagating selected model override to backend: label="Gemini 3.8 Flash (Medium)"',
    ].join('\n');
    expect(parseAgyCliLog(log)).toEqual({ mode: 'accept-edits', model: 'gemini-3.8-flash', effort: 'medium' });
    expect(parseAgyCliLog('nothing yet')).toEqual({});
  });

  it("finds the run's file by the PID on its first line (not a PID that only starts the same)", () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-agylog-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cli-20261027_224054.log'), 'I1 server.go:1836] Starting language server process with pid 171590\n');
    writeFileSync(join(dir, 'cli-20261027_224017.log'), 'I1 server.go:1836] Starting language server process with pid 17159\nmore\n');
    writeFileSync(join(dir, 'other.log'), 'Starting language server process with pid 17159\n');
    expect(findAgyCliLog(dir, 17159)).toBe(join(dir, 'cli-20261027_224017.log'));
    expect(findAgyCliLog(dir, 4)).toBeUndefined();
    expect(findAgyCliLog(join(dir, 'missing'), 17159)).toBeUndefined();
  });

  it("the account's own default effort from settings.json", () => {
    dir = mkdtempSync(join(tmpdir(), 'habblaud-agyset-'));
    expect(settingsModel(dir)).toEqual({});
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'Gemini 3.8 Flash (High)', permissions: {} }));
    expect(settingsModel(dir)).toEqual({ model: 'gemini-3.8-flash', effort: 'high' });
  });
});
