import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../../shared/types';
import {
  accountChipLabel,
  accountProvider,
  codexApprovalLabel,
  emptyOfficeHint,
  fallbackShort,
  hasCodexPermission,
  isCodex,
  looksLikeCodexId,
  providerOf,
  showsProviderTag,
} from './provider';

describe('tool (Claude Code or Codex)', () => {
  it('missing provider = Claude Code', () => {
    expect(providerOf(undefined)).toBe('claude');
    expect(providerOf({})).toBe('claude');
    expect(providerOf({ provider: 'codex' })).toBe('codex');
    expect(isCodex({ provider: 'codex' })).toBe(true);
    expect(isCodex({ provider: 'claude' })).toBe(false);
    expect(isCodex(null)).toBe(false);
  });

  it('Codex folder-like id (only when the account is not already in the snapshot)', () => {
    for (const id of ['.codex', 'demo:.codex', '.codex-trabalho', '.codex~2', '/Users/ana/.codex', 'codex']) expect(looksLikeCodexId(id), id).toBe(true);
    for (const id of ['.claude', '.claude-conta2', 'demo:.claude', 'meucodex', '.codexy', '']) expect(looksLikeCodexId(id), id).toBe(false);
    // With the account on hand, its provider applies; without it, the caller hint, and finally the id.
    expect(accountProvider({ provider: 'codex' }, '.claude')).toBe('codex');
    expect(accountProvider({}, '.codex')).toBe('claude');
    expect(accountProvider(undefined, '.claude', 'codex')).toBe('codex');
    expect(accountProvider(undefined, '.codex')).toBe('codex');
    expect(accountProvider(undefined, 'x')).toBe('claude');
  });

  it('chip letter without account in snapshot: never "." or empty', () => {
    expect(fallbackShort('.claude-conta2')).toBe('C');
    expect(fallbackShort('.claude')).toBe('?');
    expect(fallbackShort('.codex')).toBe('X');
    expect(fallbackShort('.codex-trabalho')).toBe('T');
    expect(fallbackShort('.codex~2')).toBe('X');
    expect(fallbackShort('demo:.codex')).toBe('X');
    expect(fallbackShort('minha-conta')).toBe('M');
    expect(fallbackShort('')).toBe('?');
    expect(fallbackShort('...', 'codex')).toBe('X');
  });

  it('"Codex" tag: only on Codex, and without repeating the account name', () => {
    expect(showsProviderTag('codex', 'Account X')).toBe(true);
    expect(showsProviderTag('codex', 'Codex')).toBe(false);
    expect(showsProviderTag('codex', 'Demo Codex')).toBe(false);
    expect(showsProviderTag('claude', 'Account C')).toBe(false);
    expect(showsProviderTag('agy', 'Antigravity acc1')).toBe(false);
    expect(showsProviderTag('agy', 'alice (Agy)')).toBe(false);
    expect(showsProviderTag('agy', 'Huy')).toBe(true);
  });

  it('chip label: email on Claude Code; tool and plan on Codex', () => {
    expect(accountChipLabel({ name: 'Account C', email: 'a@b.c' }, '.claude', 'claude')).toBe('Account C (a@b.c)');
    expect(accountChipLabel({ name: 'Account X', plan: 'Team', provider: 'codex' }, '.codex', 'codex')).toBe('Account X · Codex · Team plan');
    expect(accountChipLabel({ name: 'Codex', plan: 'Team', provider: 'codex' }, '.codex', 'codex')).toBe('Codex · Team plan');
    expect(accountChipLabel(undefined, '.codex', 'codex')).toBe('.codex · Codex');
    expect(accountChipLabel(undefined, '', 'claude')).toBe('Unknown account');
  });

  it('empty office: shortcuts only for Claude Code accounts; Codex is included when its account exists', () => {
    const c = { short: 'C' };
    const d = { short: 'D' };
    const x = { short: 'X', provider: 'codex' as const };
    expect(emptyOfficeHint([c, d])).toBe('Open Claude Code in any project (shortcuts c or d) and watch your agent arrive.');
    expect(emptyOfficeHint([c, d, x])).toBe('Open Claude Code (shortcuts c or d) or Codex in any project and watch your agent arrive.');
    expect(emptyOfficeHint([x])).toBe('Open Claude Code or Codex in any project and watch your agent arrive.');
    expect(emptyOfficeHint([])).toBe('Open Claude Code in any project and watch your agent arrive.');
  });

  it('1 s ticker while there is a pending Codex request', () => {
    const agent = (permission?: AgentInfo['permission'], status: AgentInfo['status'] = 'waiting') => ({ status, permission }) as AgentInfo;
    const p = { id: 'p', tool: 'Bash', title: 'Bash(ls)', text: 'Listing', icon: '💻', createdAt: 0, expiresAt: 25_000 };
    const snap = (agents: AgentInfo[]) => ({ agents }) as Pick<OfficeSnapshot, 'agents'>;
    expect(hasCodexPermission(snap([agent({ ...p, provider: 'codex' })]))).toBe(true);
    expect(hasCodexPermission(snap([agent(p)]))).toBe(false);
    expect(hasCodexPermission(snap([agent({ ...p, provider: 'codex' }, 'offline')]))).toBe(false);
    expect(hasCodexPermission(null)).toBe(false);
  });

  it('Codex approvals (unknown value passes through as-is)', () => {
    expect(codexApprovalLabel('on-request')).toBe('Asks when needed');
    expect(codexApprovalLabel('never')).toBe('Never asks');
    expect(codexApprovalLabel('outra')).toBe('outra');
    expect(codexApprovalLabel(undefined)).toBe('—');
  });
});
