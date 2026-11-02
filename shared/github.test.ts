// GitHub events: texts (notices/activities/banners) and room effects lifecycle.
import { describe, expect, it } from 'vitest';
import { ALARM_MS, bannerOf, describeGitHubEvent, GITHUB_TOOL, PARTY_MS, RoomEffects } from './github';

const T0 = 1_700_000_000_000;

describe('texts', () => {
  it('notices in office format', () => {
    expect(describeGitHubEvent({ kind: 'pr_opened', number: 12 }, 'Danilo', 'habblaud').notice).toBe('🎉 Danilo opened PR #12 in habblaud');
    expect(describeGitHubEvent({ kind: 'pr_merged', number: 12 }, 'Danilo', 'habblaud').notice).toBe('🎉 Danilo merged PR #12 in habblaud');
    expect(describeGitHubEvent({ kind: 'pr_merged' }, 'Danilo', 'habblaud').notice).toBe('🎉 Danilo merged a PR in habblaud');
    expect(describeGitHubEvent({ kind: 'ci_failed', branch: 'feat/x' }, 'Danilo', 'habblaud')).toMatchObject({ notice: '🚨 CI failed in habblaud (feat/x)', level: 'warn' });
    expect(describeGitHubEvent({ kind: 'ci_passed', number: 4 }, 'Danilo', 'habblaud').notice).toBe('✅ CI passed in habblaud (PR #4)');
    expect(describeGitHubEvent({ kind: 'push', branch: 'main' }, 'Danilo', 'habblaud').notice).toBe('🚀 Danilo pushed commits to main in habblaud');
    expect(describeGitHubEvent({ kind: 'release', tag: 'v1.2.0' }, 'Danilo', 'habblaud').notice).toBe('🎉 Danilo published release v1.2.0 in habblaud');
  });

  it('activity with marker, short and masked; red CI with error', () => {
    const a = describeGitHubEvent({ kind: 'ci_failed', branch: 'main', workflow: 'build-test' }, 'A', 'b').activity;
    expect(a).toMatchObject({ kind: 'git', icon: '🚨', text: 'CI failed: build-test', tool: GITHUB_TOOL, error: true });
    // generic workflow ("CI") says nothing: branch takes precedence
    expect(describeGitHubEvent({ kind: 'ci_failed', branch: 'feat/x', workflow: 'CI' }, 'A', 'b').activity.text).toBe('CI failed: feat/x');
    expect(describeGitHubEvent({ kind: 'ci_passed', number: 3 }, 'A', 'b').activity.text).toBe('CI passed: PR #3');
    const long = describeGitHubEvent({ kind: 'push', branch: `feat/${'x'.repeat(80)}` }, 'A', 'b').activity;
    expect(long.text.length).toBeLessThanOrEqual(46);
    const secret = describeGitHubEvent({ kind: 'pr_opened', number: 1, url: 'https://user:secret123@github.com/a/b/pull/1' }, 'A', 'b').activity;
    expect(secret.detail).not.toContain('secret123');
  });

  it('banners: party and alarm have text; push does not affect the room', () => {
    expect(bannerOf({ kind: 'pr_merged', number: 12 })).toBe('PR #12 merged!');
    expect(bannerOf({ kind: 'pr_opened' })).toBe('PR opened!');
    expect(bannerOf({ kind: 'ci_failed', branch: 'main' })).toBe('CI failed (main)');
    expect(bannerOf({ kind: 'release', tag: 'v2.0.0' })).toBe('Release v2.0.0 is live!');
    expect(bannerOf({ kind: 'push', branch: 'main' })).toBeUndefined();
  });
});

describe('room effects', () => {
  it('party lasts PARTY_MS and disappears', () => {
    const fx = new RoomEffects();
    expect(fx.apply('/r', { kind: 'pr_merged', number: 3 }, T0, 'ag1')).toBe(true);
    expect(fx.get('/r', T0)).toEqual({ kind: 'party', text: 'PR #3 merged!', at: T0, until: T0 + PARTY_MS, agentId: 'ag1' });
    expect(fx.get('/r', T0 + PARTY_MS - 1)?.kind).toBe('party');
    expect(fx.get('/r', T0 + PARTY_MS)).toBeUndefined();
    expect(fx.prune(T0 + PARTY_MS)).toBe(true);
    expect(fx.prune(T0 + PARTY_MS + 1)).toBe(false);
  });

  it('alarm lasts until green CI in room (which becomes a party) or expires in ALARM_MS', () => {
    const fx = new RoomEffects();
    fx.apply('/r', { kind: 'ci_failed', branch: 'main' }, T0, 'ag1');
    expect(fx.get('/r', T0 + 60_000)).toMatchObject({ kind: 'alarm', text: 'CI failed (main)', agentId: 'ag1' });
    // green CI in another room does not clear
    expect(fx.apply('/other', { kind: 'ci_passed' }, T0 + 1_000)).toBe(false);
    expect(fx.get('/r', T0 + 2_000)?.kind).toBe('alarm');
    expect(fx.apply('/r', { kind: 'ci_passed', branch: 'main' }, T0 + 5_000, 'ag2')).toBe(true);
    expect(fx.get('/r', T0 + 5_000)).toMatchObject({ kind: 'party', text: 'CI green again!', agentId: 'ag2' });
    expect(fx.get('/r', T0 + 5_000 + PARTY_MS)).toBeUndefined();

    const late = new RoomEffects();
    late.apply('/r', { kind: 'ci_failed' }, T0);
    expect(late.get('/r', T0 + ALARM_MS - 1)?.kind).toBe('alarm');
    expect(late.get('/r', T0 + ALARM_MS)).toBeUndefined();
    expect(late.apply('/r', { kind: 'ci_passed' }, T0 + ALARM_MS)).toBe(false);
  });

  it('party takes priority over alarm; when it ends, alarm returns; new red CI ends party', () => {
    const fx = new RoomEffects();
    fx.apply('/r', { kind: 'ci_failed' }, T0);
    fx.apply('/r', { kind: 'pr_opened', number: 9 }, T0 + 1_000);
    expect(fx.get('/r', T0 + 2_000)?.kind).toBe('party');
    expect(fx.get('/r', T0 + 1_000 + PARTY_MS)?.kind).toBe('alarm');
    fx.apply('/r', { kind: 'pr_merged', number: 9 }, T0 + 20_000);
    fx.apply('/r', { kind: 'ci_failed', branch: 'main' }, T0 + 21_000);
    expect(fx.get('/r', T0 + 21_000)).toMatchObject({ kind: 'alarm', text: 'CI failed (main)', at: T0 + 21_000 });
  });

  it('push and green CI without alarm do not affect room', () => {
    const fx = new RoomEffects();
    expect(fx.apply('/r', { kind: 'push', branch: 'main' }, T0)).toBe(false);
    expect(fx.apply('/r', { kind: 'ci_passed' }, T0)).toBe(false);
    expect(fx.get('/r', T0)).toBeUndefined();
  });
});
