// ALTCHA: proof-of-work required by the Habblaud World server during registration and email dispatches (replacing a
// captcha). The server sends {algorithm, challenge, salt, maxnumber, signature}; requester finds number n (0..maxnumber)
// where SHA-256(salt + n) = challenge and returns base64 JSON {algorithm, challenge, number, salt, signature, took}
// (ALTCHA widget format). Solved by Habblaud's local server via brute force, without dependencies.
//
// The search runs in batches, yielding to the event loop between them: the office continues responding in the meantime.
import { createHash } from 'node:crypto';
import type { AltchaChallenge } from '../../shared/world/protocol';

/** Accepted ceiling for `maxnumber` (above this the challenge is rejected instead of hanging the machine for minutes). */
export const ALTCHA_MAX_NUMBER = 10_000_000;
/** Attempts per batch between yields to the event loop. */
const BATCH = 5_000;

/** Validates challenge received from world server; undefined if malformed. */
export function parseAltchaChallenge(raw: unknown, maxNumber = ALTCHA_MAX_NUMBER): AltchaChallenge | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  if (v.algorithm !== 'SHA-256') return undefined;
  if (typeof v.challenge !== 'string' || !/^[0-9a-f]{64}$/i.test(v.challenge)) return undefined;
  if (typeof v.salt !== 'string' || !v.salt || v.salt.length > 512) return undefined;
  if (typeof v.signature !== 'string' || !v.signature || v.signature.length > 512) return undefined;
  if (!Number.isInteger(v.maxnumber) || (v.maxnumber as number) < 1 || (v.maxnumber as number) > maxNumber) return undefined;
  return { algorithm: 'SHA-256', challenge: v.challenge.toLowerCase(), salt: v.salt, maxnumber: v.maxnumber as number, signature: v.signature };
}

export function altchaHash(salt: string, n: number): string {
  return createHash('sha256').update(salt + n).digest('hex');
}

export interface AltchaSolution {
  number: number;
  /** How long the search took (ms). */
  took: number;
}

/**
 * Solves challenge number. Returns undefined if no n up to `maxnumber` matches (invalid challenge). Aborts with
 * `signal` (throws abort reason).
 */
export async function solveAltcha(
  ch: AltchaChallenge,
  opts: { signal?: AbortSignal; now?: () => number } = {},
): Promise<AltchaSolution | undefined> {
  const now = opts.now ?? Date.now;
  const start = now();
  for (let n = 0; n <= ch.maxnumber; n++) {
    if (altchaHash(ch.salt, n) === ch.challenge) return { number: n, took: Math.max(0, now() - start) };
    if (n % BATCH === BATCH - 1) {
      await new Promise<void>((ok) => setImmediate(ok));
      opts.signal?.throwIfAborted();
    }
  }
  return undefined;
}

/** Solution in registration `altcha` field format: base64 of {algorithm, challenge, number, salt, signature, took}. */
export function encodeAltchaPayload(ch: AltchaChallenge, sol: AltchaSolution): string {
  const payload = { algorithm: ch.algorithm, challenge: ch.challenge, number: sol.number, salt: ch.salt, signature: ch.signature, took: sol.took };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
