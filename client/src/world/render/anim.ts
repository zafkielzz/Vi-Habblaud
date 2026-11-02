// Curves and parameters for room build/dismantle animations (pure).

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function easeInBack(t: number): number {
  const c1 = 1.70158;
  return (c1 + 1) * t * t * t - c1 * t * t;
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export interface BuildAnim {
  /** 0..1: how much of the floor is visible. */
  floor: number;
  /** 0..1: walls. */
  walls: number;
  /** 0..1: name sign. */
  sign: number;
  /** Phase (to calculate each furniture item's scale). */
  mode: 'none' | 'build' | 'dismantle';
  p: number;
}

export const NO_ANIM: BuildAnim = { floor: 1, walls: 1, sign: 1, mode: 'none', p: 1 };

export function buildAnim(phase: string, p: number): BuildAnim {
  if (phase === 'building') {
    return { floor: clamp01(p / 0.4), walls: easeOutCubic(clamp01((p - 0.22) / 0.3)), sign: easeOutCubic(clamp01((p - 0.84) / 0.16)), mode: 'build', p };
  }
  if (phase === 'dismantling') {
    return {
      floor: 1 - clamp01((p - 0.7) / 0.3),
      walls: 1 - clamp01((p - 0.47) / 0.25),
      sign: 1 - clamp01(p / 0.15),
      mode: 'dismantle',
      p,
    };
  }
  return NO_ANIM;
}

/** Furniture scale during animation (bounce staggered by order 0..1). */
export function furnitureScale(a: BuildAnim, order: number): number {
  if (a.mode === 'build') {
    const t = clamp01((a.p - (0.48 + order * 0.36)) / 0.13);
    return t <= 0 ? 0 : t >= 1 ? 1 : Math.max(0, easeOutBack(t));
  }
  if (a.mode === 'dismantle') {
    // the last to arrive (high order) are the first to leave
    const t = clamp01((a.p - (1 - order) * 0.33) / 0.12);
    return t <= 0 ? 1 : t >= 1 ? 0 : Math.max(0, 1 - easeInBack(t));
  }
  return 1;
}

/** Relative delay (0..1) of floor sweep for tile (i, j) in a w×h area. */
export function sweepDelay(i: number, j: number, w: number, h: number): number {
  return (i + j * 0.8) / (w + h * 0.8);
}
