// Sound board: one AudioContext for everything (created only after a user gesture, per
// autoplay policy), master volume with limiter, and scheduler deciding what plays.
import { SoundScheduler, type SoundKind, type SoundSettings } from './scheduler';
import { makeNoise, playVoice } from './synth';

export class SoundBoard {
  readonly scheduler = new SoundScheduler();
  private ac: AudioContext | null = null;
  private out: AudioNode | null = null;
  private noise: AudioBuffer | null = null;
  private enabled = false;

  configure(enabled: boolean, settings: SoundSettings): void {
    this.enabled = enabled;
    this.scheduler.configure(enabled, settings);
  }

  /**
   * Must be called from a user gesture (click/key) for the browser to unlock
   * audio. Resolves when audio is ready (or could not be unlocked).
   */
  unlock(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    try {
      if (!this.ac) {
        const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return Promise.resolve();
        const ac = new Ctor();
        // soft limiter: multiple simultaneous sounds never clip
        const comp = ac.createDynamicsCompressor();
        comp.threshold.value = -18;
        comp.knee.value = 12;
        comp.ratio.value = 6;
        comp.connect(ac.destination);
        this.ac = ac;
        this.out = comp;
        this.noise = makeNoise(ac);
      }
      if (this.ac.state === 'suspended') return this.ac.resume().catch(() => undefined);
    } catch {
      this.ac = null;
      this.out = null;
    }
    return Promise.resolve();
  }

  /** Plays `kind` if preference and limits allow. Returns whether it played. */
  play(kind: SoundKind, opts: { gain?: number; pan?: number; count?: number } = {}): boolean {
    const ac = this.ac;
    if (!ac || !this.out || ac.state !== 'running') return false;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const gain = this.scheduler.decide(kind, performance.now(), { hidden, gain: opts.gain });
    if (gain === null) return false;
    try {
      playVoice(ac, this.out, kind, ac.currentTime + 0.01, { gain, pan: opts.pan, count: opts.count, rng: Math.random, noise: this.noise });
      return true;
    } catch {
      return false;
    }
  }
}
