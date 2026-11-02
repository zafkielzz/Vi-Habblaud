// Dictation: turns audio recorded in the browser into text with LOCAL Whisper (whisper.cpp: `whisper-cli`), without
// sending voice to any service. Language is auto-detected (`-l auto`); since dictation is in English or Vietnamese,
// a result in another language is retried in the primary language. Needs whisper-cli, ffmpeg (mobile audio comes in
// mp4/webm), and a multilingual ggml-*.bin model (".en" models only understand English and are excluded). Runs where
// Whisper is: server in Node mode, host helper (scripts/codex-bridge.ts) in Docker. No shell (execFile), with timeout,
// in a temporary directory cleaned up at the end. Pure Node with no dependencies: also imported by host helper
// (via tsx).
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { tr } from '../../shared/i18n';

export const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Dictation languages: the first one is the fallback when the detected one is not in the list. */
export const DEFAULT_LANGS = ['en', 'vi'] as const;
/** Best to lightest: uses first one found. */
const MODELS = ['ggml-large-v3-turbo.bin', 'ggml-large-v3.bin', 'ggml-medium.bin', 'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin'];

export interface WhisperSetup {
  bin: string;
  ffmpeg: string;
  model: string;
  langs: string[];
}

export interface Transcript {
  text: string;
  /** ISO code of recognized language (e.g. "en", "vi"). */
  lang: string;
}

export type Transcriber = (audio: Buffer, type: string) => Promise<Transcript>;

function onPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** Finds whisper-cli, ffmpeg, and best multilingual model; undefined (with reason) if any missing. */
export function findWhisper(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): WhisperSetup | { missing: string } {
  const home = env.HOME || homedir();
  const bin = env.HABBLAUD_WHISPER_BIN?.trim() || ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(exists) || onPath('whisper-cli', env);
  if (!bin || !exists(bin)) return { missing: 'whisper-cli (brew install whisper-cpp)' };
  const ffmpeg = env.HABBLAUD_FFMPEG_BIN?.trim() || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(exists) || onPath('ffmpeg', env);
  if (!ffmpeg || !exists(ffmpeg)) return { missing: 'ffmpeg (brew install ffmpeg)' };
  const dirs = [join(home, '.local', 'share', 'whisper'), join(home, '.whisper'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp'];
  const model =
    env.HABBLAUD_WHISPER_MODEL?.trim() ||
    MODELS.flatMap((m) => dirs.map((d) => join(d, m))).find(exists);
  if (!model || !exists(model)) return { missing: tr('a multilingual Whisper model (ggml-small.bin or ggml-base.bin in ~/.local/share/whisper)') };
  const langs = (env.HABBLAUD_DICTATION_LANGS ?? '')
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => /^[a-z]{2,3}$/.test(l));
  return { bin, ffmpeg, model, langs: langs.length ? langs : [...DEFAULT_LANGS] };
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((ok) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      if (!err) return ok({ ok: true });
      const line = (stderr || err.message || '').split('\n').filter((l) => l.trim()).pop() ?? tr('failed');
      ok({ ok: false, error: line.trim().slice(0, 300) });
    });
  });
}

/** Text and language from whisper-cli JSON (-oj). */
export function parseWhisperJson(raw: string): Transcript {
  const d = JSON.parse(raw) as { result?: { language?: unknown }; transcription?: Array<{ text?: unknown }> };
  const text = (d.transcription ?? [])
    .map((t) => (typeof t.text === 'string' ? t.text : ''))
    .join(' ')
    .replace(/\[(BLANK_AUDIO|MUSIC|Música|SILENCE)\]|\((?:silence|música|music)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, lang: typeof d.result?.language === 'string' ? d.result.language : '' };
}

/** Transcriber using whisper-cli; temporary folder removed at the end, on success or error. */
export function createWhisperTranscriber(setup: WhisperSetup, timeoutMs = TRANSCRIBE_TIMEOUT_MS): Transcriber {
  return async (audio) => {
    const dir = mkdtempSync(join(tmpdir(), 'habblaud-dictation-'));
    try {
      const input = join(dir, 'audio.in');
      const wav = join(dir, 'audio.wav');
      writeFileSync(input, audio, { mode: 0o600 });
      const conv = await run(setup.ffmpeg, ['-nostdin', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], timeoutMs);
      if (!conv.ok) throw new Error(tr("couldn't read the audio ({0})", [conv.error]));
      const pass = async (lang: string): Promise<Transcript> => {
        const out = join(dir, `out-${lang}`);
        const r = await run(setup.bin, ['-m', setup.model, '-l', lang, '-f', wav, '-nt', '-np', '-oj', '-of', out], timeoutMs);
        if (!r.ok) throw new Error(tr('Whisper failed ({0})', [r.error]));
        return parseWhisperJson(readFileSync(`${out}.json`, 'utf8'));
      };
      const first = await pass('auto');
      if (!first.lang || setup.langs.includes(first.lang) || !first.text) return first;
      // Detected a language outside the list: retries in the primary language.
      const again = await pass(setup.langs[0]);
      return { text: again.text, lang: setup.langs[0] };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
