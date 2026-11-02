import { describe, expect, it } from 'vitest';
import { konamiStep } from './konami';

describe('konamiStep', () => {
  it('completes with ↑↑↓↓←→←→BA (uppercase B and A too) and restarts on a mistake', () => {
    const keys = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'B', 'A'];
    expect(keys.reduce(konamiStep, 0)).toBe(10);
    expect(konamiStep(5, 'x')).toBe(0);
    expect(konamiStep(3, 'ArrowUp')).toBe(1);
  });
});
