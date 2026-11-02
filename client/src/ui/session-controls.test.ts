import { describe, expect, it } from 'vitest';
import { modelAlias } from './session-controls';

describe('session controls', () => {
  it('shows the model the session uses as its drawer choice', () => {
    expect(modelAlias('claude-opus-5-5')).toBe('opus');
    expect(modelAlias('claude-haiku-5-5-20261001')).toBe('haiku');
    expect(modelAlias('gpt-5.3-codex')).toBe('');
    expect(modelAlias(undefined)).toBe('');
  });
});
