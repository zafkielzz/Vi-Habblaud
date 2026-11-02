import { describe, expect, it } from 'vitest';
import { WORLD_KNOWN_ERROR_CODES, WORLD_LOCAL_ERROR_CODES, isWorldKnownErrorCode, worldLastError } from './api';
import { WORLD_ERROR_CODES } from './protocol';

describe('World error codes', () => {
  it('world server codes include those sent by private server beyond the contract', () => {
    for (const code of ['no_player', 'unavailable', 'invalid_json', 'too_large', 'unsupported_media_type', 'method_not_allowed', 'name_cooldown', 'device_limit', 'internal']) {
      expect(WORLD_ERROR_CODES as readonly string[], code).toContain(code);
    }
  });

  it('known list merges both without duplicates', () => {
    expect(new Set(WORLD_KNOWN_ERROR_CODES).size).toBe(WORLD_KNOWN_ERROR_CODES.length);
    for (const c of [...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES]) expect(isWorldKnownErrorCode(c), c).toBe(true);
    expect(isWorldKnownErrorCode('algo_novo')).toBe(false);
    expect(isWorldKnownErrorCode(undefined)).toBe(false);
  });

  it('lastError: network errors become network; malformed response, uncoded error, and new codes become unknown', () => {
    expect(worldLastError('world_unreachable')).toBe('network');
    expect(worldLastError('world_timeout')).toBe('network');
    expect(worldLastError('world_bad_response')).toBe('unknown');
    expect(worldLastError('world_error')).toBe('unknown');
    expect(worldLastError('algo_novo')).toBe('unknown');
    for (const c of ['session_expired', 'storage_failed', 'terminal_off', 'rate_limited', 'unavailable', 'banned', 'internal']) expect(worldLastError(c)).toBe(c);
  });
});
