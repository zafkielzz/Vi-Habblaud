// Synthesized WebAudio sounds (no audio files): short, quiet, and soft timbre.
import type { SoundKind } from './scheduler';

export interface VoiceOpts {
  /** Final gain (including master volume). */
  gain: number;
  /** -1 .. 1 (left .. right). */
  pan?: number;
  /** Keyboard: keystrokes in burst. */
  count?: number;
  rng: () => number;
  /** Short white noise (keystrokes). */
  noise: AudioBuffer | null;
}

/** Percussive envelope: short attack and exponential decay. */
function env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function tone(ac: AudioContext, out: AudioNode, type: OscillatorType, freq: number, t: number, peak: number, attack: number, decay: number, toFreq?: number): void {
  const o = ac.createOscillator();
  const g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (toFreq) o.frequency.exponentialRampToValueAtTime(toFreq, t + Math.min(decay, 0.08));
  env(g, t, peak, attack, decay);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + decay + 0.05);
}

/** Creates a white noise buffer (keystroke base). */
export function makeNoise(ac: AudioContext): AudioBuffer | null {
  try {
    const len = Math.floor(ac.sampleRate * 0.06);
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  } catch {
    return null;
  }
}

/** Plays `kind` at `t` (AudioContext time) to `dest` output. */
export function playVoice(ac: AudioContext, dest: AudioNode, kind: SoundKind, t: number, o: VoiceOpts): void {
  let out: AudioNode = dest;
  if (o.pan && typeof ac.createStereoPanner === 'function') {
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    p.connect(dest);
    out = p;
  }
  const g = o.gain;
  switch (kind) {
    case 'chime':
      // soft chime: two partials and a third note right after, with long decay
      tone(ac, out, 'sine', 880, t, 0.16 * g, 0.012, 1.1);
      tone(ac, out, 'sine', 1318.5, t, 0.08 * g, 0.012, 1.1);
      tone(ac, out, 'sine', 1174.7, t + 0.14, 0.1 * g, 0.012, 1.1);
      return;
    case 'pop':
      // "pop": short downward sweep
      tone(ac, out, 'triangle', 740, t, 0.14 * g, 0.008, 0.15, 330);
      return;
    case 'elevator':
      // elevator "ding": round note with bell shimmer fading first
      tone(ac, out, 'sine', 784, t, 0.11 * g, 0.004, 1.5);
      tone(ac, out, 'sine', 1568, t, 0.025 * g, 0.004, 0.7);
      tone(ac, out, 'sine', 2164, t, 0.012 * g, 0.004, 0.25);
      return;
    case 'keys':
      keys(ac, out, t, o);
      return;
    case 'pingpong':
      // paddle hit: high-pitched "tok" with falling pitch
      tone(ac, out, 'sine', 1250, t, 0.09 * g, 0.002, 0.06, 880);
      return;
    case 'table':
      // table bounce: lower pitch and shorter
      tone(ac, out, 'sine', 760, t, 0.06 * g, 0.002, 0.045, 520);
      return;
    case 'arcade': {
      // arcade: three-note square wave arpeggio, filtered to soften
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2600;
      lp.connect(out);
      const scale = [1046.5, 1318.5, 1568, 1760, 2093];
      for (let i = 0; i < 3; i++) {
        const f = scale[Math.floor(o.rng() * scale.length)];
        tone(ac, lp, 'square', f, t + i * 0.055, 0.03 * g, 0.003, 0.05);
      }
      return;
    }
  }
}

/** Keystroke burst: clicks of filtered noise with irregular gaps, like real typing. */
function keys(ac: AudioContext, out: AudioNode, t: number, o: VoiceOpts): void {
  if (!o.noise) return;
  const n = Math.max(1, Math.min(8, o.count ?? 4));
  let at = t;
  for (let i = 0; i < n; i++) {
    const src = ac.createBufferSource();
    src.buffer = o.noise;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900 + o.rng() * 1500;
    bp.Q.value = 1.4;
    const g = ac.createGain();
    env(g, at, 0.08 * o.gain * (0.6 + o.rng() * 0.4), 0.0015, 0.022 + o.rng() * 0.012);
    src.connect(bp).connect(g).connect(out);
    src.start(at, o.rng() * 0.02, 0.04);
    at += 0.06 + o.rng() * 0.08 + (o.rng() < 0.15 ? 0.12 : 0);
  }
}
