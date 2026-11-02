// Dictation: microphone button that records in the browser (MediaRecorder), sends the audio to Habblaud (POST /api/dictation)
// and returns the transcribed text from Mac's local Whisper, with auto-detected language (Portuguese or English; see
// server/dictation/whisper.ts). Placed in "New agent" and message box (drawer and terminal). Microphone requires
// a secure context (HTTPS or localhost); otherwise the button is hidden.
import { tr } from '../../../shared/i18n';
import { h, setText } from './dom';
import { ICONS } from './icons';

export const MAX_RECORD_MS = 180_000;
const POLL_MS = 600;
const WAIT_MS = 150_000;
/** Formats in order of preference: iPhone Safari records mp4 (AAC); Chrome and Firefox, webm/ogg (Opus). */
const MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

/** Notice when dictation is ready, with recognized language (one full phrase per language, for translation). */
export function dictationDone(lang: string | undefined): string {
  if (lang === 'en') return tr('Dictated in English: check the text.');
  if (lang === 'vi') return tr('Dictated in Vietnamese: check the text.');
  return tr('Dictation ready: check the text.');
}

export interface DictationText {
  text: string;
  lang?: string;
}

type State = 'idle' | 'recording' | 'working';

interface DictationReply {
  id: string;
  status: 'queued' | 'sent' | 'done' | 'failed';
  text?: string;
  lang?: string;
  error?: string;
}

/** Appends dictated text to current field value at cursor position, with proper spacing/newlines. */
export function insertDictation(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const t = text.trim();
  if (!t) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${lead}${t}${trail}${after}`;
  return { value: next, caret: before.length + lead.length + t.length };
}

export function pickMimeType(isSupported: (t: string) => boolean): string | undefined {
  return MIME_TYPES.find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  });
}

export function canRecord(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr("couldn't read the recording")));
    r.readAsDataURL(blob);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error(tr("Habblaud didn't respond"));
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? tr('error {0}', [res.status]));
  return body;
}

const AVAILABLE_TTL_MS = 30_000;
let availableCache: { at: number; value: Promise<boolean> } | null = null;

/** Is dictation available here (browser records and Mac has Whisper)? Polled every 30 s, shared across inputs. */
export function dictationAvailable(now = Date.now()): Promise<boolean> {
  if (!canRecord()) return Promise.resolve(false);
  if (availableCache && now - availableCache.at < AVAILABLE_TTL_MS) return availableCache.value;
  const value = api<{ available: boolean }>('/api/dictation').then(
    (r) => r.available === true,
    () => false,
  );
  availableCache = { at: now, value };
  return value;
}

export interface DictationButtonOptions {
  /** Icon only (message box); shows time while recording. */
  compact?: boolean;
  /** Called when recording starts (the box remembers which agent the dictation was for). */
  onStart?: () => void;
}

export class DictationButton {
  readonly el: HTMLButtonElement;
  private readonly label: HTMLElement;
  private state: State = 'idle';
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private cancelled = false;

  constructor(
    private readonly onText: (t: DictationText) => void,
    private readonly say: (text: string, error?: boolean) => void,
    private readonly opts: DictationButtonOptions = {},
  ) {
    this.label = h('span', { class: 'ui-dictate__label', text: opts.compact ? '' : tr('Dictate') });
    this.el = h('button', {
      class: `ui-btn ui-dictate${opts.compact ? ' ui-dictate--compact' : ''}`,
      type: 'button',
      attrs: { 'aria-pressed': 'false', 'aria-label': tr('Dictate'), title: tr('Dictate (English or Vietnamese, the language is detected automatically)') },
      on: { click: () => void this.toggle() },
    });
    const icon = h('span', { class: 'ui-dictate__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.mic;
    this.el.append(icon, this.label);
  }

  get busy(): boolean {
    return this.state !== 'idle';
  }

  /** Stops recording without transcribing (panel closed). */
  cancel(): void {
    if (this.state !== 'recording') return;
    this.cancelled = true;
    this.stopRecorder();
  }

  private async toggle(): Promise<void> {
    if (this.state === 'recording') return this.stopRecorder();
    if (this.state === 'working') return;
    await this.start();
  }

  private async start(): Promise<void> {
    if (!canRecord()) return this.say(tr("This browser won't record audio here (HTTPS required)."), true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const denied = (err as DOMException)?.name === 'NotAllowedError';
      return this.say(denied ? tr('No microphone permission: allow it in the browser settings and try again.') : tr("Couldn't open the microphone."), true);
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch {
      this.release();
      return this.say(tr("This browser can't record audio."), true);
    }
    this.chunks = [];
    this.cancelled = false;
    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) this.chunks.push(e.data);
    });
    this.recorder.addEventListener('stop', () => void this.finish(), { once: true });
    this.recorder.start(1_000);
    this.startedAt = Date.now();
    this.opts.onStart?.();
    this.set('recording');
    this.say(this.opts.compact ? tr('Recording… tap the microphone again to stop.') : tr('Recording… speak English or Vietnamese and tap Stop.'));
    this.timer = setInterval(() => {
      const ms = Date.now() - this.startedAt;
      const s = Math.floor(ms / 1000);
      const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      setText(this.label, this.opts.compact ? clock : tr('Stop {0}', [clock]));
      if (ms >= MAX_RECORD_MS) this.stopRecorder();
    }, 250);
  }

  private stopRecorder(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    } catch {
      // already stopped
    }
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async finish(): Promise<void> {
    const type = this.recorder?.mimeType || this.chunks[0]?.type || 'audio/mp4';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;
    this.release();
    if (this.cancelled) {
      this.cancelled = false;
      return this.set('idle');
    }
    if (blob.size < 512) {
      this.set('idle');
      return this.say(tr("I didn't hear anything: try again, closer to the microphone."), true);
    }
    this.set('working');
    this.say(tr('Transcribing on the computer…'));
    try {
      let r = await api<DictationReply>('/api/dictation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type.split(';')[0], data: await blobToBase64(blob) }),
      });
      const end = Date.now() + WAIT_MS;
      while ((r.status === 'queued' || r.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        r = await api<DictationReply>(`/api/dictation/${encodeURIComponent(r.id)}`);
      }
      if (r.status !== 'done') throw new Error(r.error || tr("the computer didn't respond in time"));
      if (!r.text?.trim()) this.say(tr("I couldn't make out anything in the recording: try again."), true);
      else {
        this.onText({ text: r.text, lang: r.lang });
        this.say(dictationDone(r.lang));
      }
    } catch (err) {
      this.say(tr('Dictation failed: {0}', [(err as Error).message]), true);
    } finally {
      this.set('idle');
    }
  }

  private set(state: State): void {
    this.state = state;
    this.el.classList.toggle('is-recording', state === 'recording');
    this.el.classList.toggle('is-working', state === 'working');
    this.el.setAttribute('aria-pressed', String(state === 'recording'));
    this.el.disabled = state === 'working';
    const icon = this.el.querySelector('.ui-dictate__icon');
    if (icon) icon.innerHTML = state === 'recording' ? ICONS.stopRec : ICONS.mic;
    this.el.setAttribute('aria-label', state === 'recording' ? tr('Stop dictation') : state === 'working' ? tr('Transcribing') : tr('Dictate'));
    if (this.opts.compact) setText(this.label, state === 'recording' ? '0:00' : state === 'working' ? '…' : '');
    else setText(this.label, state === 'recording' ? tr('Stop {0}', ['0:00']) : state === 'working' ? tr('Transcribing…') : tr('Dictate'));
  }
}
