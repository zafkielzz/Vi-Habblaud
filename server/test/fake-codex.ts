// Fake Codex binary for message tests: mimics real `codex queue` (0.162) output and records each
// call (arguments and CODEX_HOME) in a file. Never calls real Codex.
// - thread starting with 0199aaaa: "Error: ... no rollout found for thread id ..." on stderr, exit code 1;
// - thread starting with 0199bbbb: delays 10 s (for timeout testing);
// - forbidden flag (-c, --enable, --disable, --no-daemon) or missing argument: exit code 2;
// - otherwise: "Queued message <id> for thread <thread>." on stdout, exit code 0.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_BIN_NAME } from '../messages/codex';

/**
 * Does the fake binary run here? It is a script with a shebang, and on Windows execFile (without a shell) only runs
 * .exe: there, tests executing it are skipped (searching by name remains tested).
 */
export const FAKE_CODEX_RUNS = process.platform !== 'win32';

const SCRIPT = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ args, codexHome: process.env.CODEX_HOME }) + '\\n');
const thread = (args.find((a) => a.startsWith('--thread=')) || '').slice('--thread='.length);
const message = args.find((a) => a.startsWith('--message='));
if (args[0] !== 'queue' || args.some((a) => /^(-c|--config|--enable|--disable|--no-daemon)/.test(a))) {
  process.stderr.write("error: unexpected argument found\\n\\nUsage: codex queue --thread <THREAD> --message <TEXT>\\n");
  process.exit(2);
} else if (!thread || message === undefined) {
  process.stderr.write('error: the following required arguments were not provided:\\n  --thread <THREAD>\\n');
  process.exit(2);
} else if (thread.startsWith('0199aaaa')) {
  process.stderr.write('Error: failed to queue session message: thread/queue/add failed: failed to read thread: invalid thread-store request: no rollout found for thread id ' + thread + ' (code -32603)\\n');
  process.exit(1);
} else if (thread.startsWith('0199bbbb')) {
  setTimeout(() => process.stdout.write('tarde demais\\n'), 10000);
} else {
  process.stdout.write('Queued message 01a11fb4-27d1-7450-947c-e3c97aa47303 for thread ' + thread + '.\\n');
}
`;

/** Writes the fake binary as <dir>/codex (on Windows, codex.exe: the name searched for) and returns the path. */
export function writeFakeCodex(dir: string): string {
  const bin = join(dir, CODEX_BIN_NAME);
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  return bin;
}

/** Calls recorded by the fake binary. */
export function fakeCodexCalls(log: string): Array<{ args: string[]; codexHome?: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { args: string[]; codexHome?: string });
}
