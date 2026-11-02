import { afterEach, describe, expect, it } from 'vitest';
import { access, fallbackAccess, loadAccess, onAccessChange, remoteLogout, setAccess } from './access';

afterEach(() => setAccess(null));

describe('access', () => {
  it('no server response: old rule (only the local machine acts)', async () => {
    expect(fallbackAccess('localhost')).toMatchObject({ local: true, permissions: true });
    expect(fallbackAccess('habblaud.localhost').permissions).toBe(true);
    expect(fallbackAccess('192.168.1.10')).toMatchObject({ local: false, permissions: false, messages: false });
    // Spawning a new agent is opt-in on the server: without response, never appears.
    expect(fallbackAccess('localhost').spawn).toBe(false);
    const failing = (() => Promise.reject(new Error('network'))) as unknown as typeof fetch;
    expect((await loadAccess(failing)).remote).toBe(false);
  });
  it('with response: server response applies (logged-in phone approving)', async () => {
    const body = { remote: true, local: false, permissions: true, messages: false, terminal: false, spawn: false };
    const ok = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch;
    expect(await loadAccess(ok)).toEqual(body);
    expect(access().permissions).toBe(true);
  });
  it('re-reading access notifies only on change (terminal allowed with mobile page open)', async () => {
    const base = { remote: true, local: false, permissions: true, messages: true, terminal: false, spawn: true };
    const reply = (b: object) => (() => Promise.resolve(new Response(JSON.stringify(b), { status: 200 }))) as unknown as typeof fetch;
    let calls = 0;
    const off = onAccessChange(() => calls++);
    await loadAccess(reply(base));
    await loadAccess(reply(base));
    expect(calls).toBe(1);
    await loadAccess(reply({ ...base, terminal: true }));
    expect(calls).toBe(2);
    expect(access().terminal).toBe(true);
    off();
    await loadAccess(reply(base));
    expect(calls).toBe(2);
  });
  it('expired login on remote port (401): redirects to login page', async () => {
    const went: string[] = [];
    const expired = (() => Promise.resolve(new Response('{"error":"please log in"}', { status: 401 }))) as unknown as typeof fetch;
    await loadAccess(expired, (u) => went.push(u));
    expect(went).toEqual(['/login']);
  });
  it('malformed response is ignored', async () => {
    const bad = (() => Promise.resolve(new Response('{"remote":"yes"}', { status: 200 }))) as unknown as typeof fetch;
    expect((await loadAccess(bad)).remote).toBe(false);
  });
  it('logout: POST JSON on logout and only then navigates to /login', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const went: string[] = [];
    const ok = ((u: string, i?: RequestInit) => (calls.push([u, i]), Promise.resolve(new Response('{"ok":true}', { status: 200 })))) as unknown as typeof fetch;
    expect(await remoteLogout(ok, (u) => went.push(u))).toBe(true);
    expect(calls[0][0]).toBe('/api/remote/logout');
    expect(calls[0][1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(went).toEqual(['/login']);
    const down = (() => Promise.reject(new Error('network'))) as unknown as typeof fetch;
    expect(await remoteLogout(down, (u) => went.push(u))).toBe(false);
    expect(went).toEqual(['/login']);
  });
});
