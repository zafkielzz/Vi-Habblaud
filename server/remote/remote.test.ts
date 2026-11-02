import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mdnsCommand } from '../../scripts/remote-mdns';
import { parseArgs, passwordProblem, remoteEnv, urlFor } from '../../scripts/remote-setup';
import { remotePortsFrom, renderOverride } from '../../scripts/docker-up';
import { startRemoteListener, type RemoteListener } from '../http/remote';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { addToList, readEnvValue, updateEnv } from './envfile';
import { hashPassword, parsePasswordHash, verifyPassword } from './password';
import { caCovers, caFingerprint, certTargets, ensureServerCert, isPrivateIpv4, isValidDomain, isValidName, lanAddresses, remoteTargets, serverCertStatus, tlsPaths } from './tls';

setQuiet(true);

const HAS_OPENSSL = spawnSync('openssl', ['version']).status === 0;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe('password (scrypt)', () => {
  it('generates hash without "$" (Compose interpolates), verifies correct and rejects wrong', async () => {
    const text = await hashPassword('a good password', 10);
    expect(text).toMatch(/^scrypt:10:8:1:/);
    expect(text).not.toContain('$');
    const parsed = parsePasswordHash(text)!;
    expect(await verifyPassword('a good password', parsed)).toBe(true);
    expect(await verifyPassword('a good passworD', parsed)).toBe(false);
    expect(await verifyPassword('', parsed)).toBe(false);
  });
  it('different salt on each hash; unreasonable format or parameters are rejected', async () => {
    expect(await hashPassword('x'.repeat(12), 10)).not.toBe(await hashPassword('x'.repeat(12), 10));
    expect(parsePasswordHash('scrypt:30:8:1:AAAAAAAAAAAAAAAAAAAAAA:' + 'A'.repeat(43))).toBeUndefined();
    expect(parsePasswordHash('plaintext')).toBeUndefined();
    expect(parsePasswordHash(undefined)).toBeUndefined();
  });
});

describe('.env', () => {
  it('changes only requested keys, removes with null, and preserves comments', () => {
    const before = '# my .env\nHABBLAUD_PORT=4848\nHABBLAUD_REMOTE_PASSWORD=text\nHABBLAUD_REMOTE_USER=a\nHABBLAUD_REMOTE_USER=b\n';
    const after = updateEnv(before, { HABBLAUD_REMOTE_USER: 'ana', HABBLAUD_REMOTE_PASSWORD: null, HABBLAUD_REMOTE_NAME: 'myclaude' });
    expect(after).toBe('# my .env\nHABBLAUD_PORT=4848\nHABBLAUD_REMOTE_USER=ana\nHABBLAUD_REMOTE_NAME=myclaude\n');
    expect(readEnvValue(after, 'HABBLAUD_REMOTE_NAME')).toBe('myclaude');
    expect(readEnvValue('X="a b"\n', 'X')).toBe('a b');
    expect(addToList('a.lan, b', 'b', 'c.local')).toBe('a.lan,b,c.local');
  });
  it('setup remoteEnv: hash instead of password, allowed names in Host, open bind', () => {
    const env = remoteEnv('HABBLAUD_REMOTE_PASSWORD=old\nHABBLAUD_ALLOWED_HOSTS=casa.lan\n', {
      user: 'ana',
      hash: 'scrypt:15:8:1:salt:hash',
      name: 'myclaude',
      domain: 'myclaude.home',
      port: 443,
    });
    expect(env).not.toContain('HABBLAUD_REMOTE_PASSWORD=');
    expect(readEnvValue(env, 'HABBLAUD_REMOTE_PASSWORD_HASH')).toBe('scrypt:15:8:1:salt:hash');
    expect(readEnvValue(env, 'HABBLAUD_ALLOWED_HOSTS')).toBe('casa.lan,myclaude.local,myclaude.home');
    expect(readEnvValue(env, 'HABBLAUD_REMOTE_BIND')).toBe('0.0.0.0');
    expect(readEnvValue(env, 'HABBLAUD_REMOTE_PORT')).toBe('443');
  });
});

describe('setup and announcement', () => {
  it('options and password rules', () => {
    expect(parseArgs(['--name', 'MyClaude', '--domain', 'MyClaude.Home', '--port', '443', '--password-stdin', '--no-service'])).toMatchObject({
      name: 'myclaude',
      domain: 'myclaude.home',
      port: 443,
      passwordStdin: true,
      service: false,
    });
    expect(() => parseArgs(['--port', '99999'])).toThrow(/port/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown/);
    expect(passwordProblem('short', 'ana')).toMatch(/10/);
    expect(passwordProblem(' with trailing space ', 'ana')).toMatch(/spaces/);
    expect(passwordProblem('ana1234567', 'ana1234567')).toMatch(/username/);
    expect(passwordProblem('a good password', 'ana')).toBeUndefined();
    expect(urlFor('myclaude.local', 443)).toBe('https://myclaude.local');
    expect(urlFor('myclaude.local', 4748)).toBe('https://myclaude.local:4748');
  });
  it('valid names and system announcement command', () => {
    expect(isValidName('myclaude')).toBe(true);
    expect(isValidName('my_claude')).toBe(false);
    expect(isValidDomain('myclaude.home')).toBe(true);
    expect(isValidDomain('myclaude')).toBe(false);
    expect(isValidDomain('10.0.0.1')).toBe(false);
    expect(mdnsCommand('darwin', 'myclaude', '192.168.1.10', 443)).toEqual({
      cmd: 'dns-sd',
      args: ['-P', 'Habblaud (myclaude)', '_https._tcp', 'local', '443', 'myclaude.local', '192.168.1.10'],
    });
    expect(mdnsCommand('linux', 'myclaude', '192.168.1.10', 443)).toEqual({ cmd: 'avahi-publish', args: ['-a', '-R', 'myclaude.local', '192.168.1.10'] });
    expect(mdnsCommand('win32', 'myclaude', '192.168.1.10', 443)).toBeUndefined();
  });
  it('docker-up mounts ONLY server certificate folder, read-only', () => {
    const yaml = renderOverride([], new Date(0), undefined, undefined, [], '/h/.habblaud/remote-tls/server');
    expect(yaml).toContain('source: "/h/.habblaud/remote-tls/server"');
    expect(yaml).toContain('target: "/remote-tls"');
    expect(yaml).not.toContain('remote-tls/ca');
  });
  it('only publishes remote port (and http:// -> https:// redirect) with access configured', () => {
    expect(remotePortsFrom('')).toEqual([]);
    expect(remotePortsFrom('HABBLAUD_REMOTE_PORT=443\nHABBLAUD_REMOTE_HTTP_PORT=80\n')).toEqual([]);
    expect(remotePortsFrom('HABBLAUD_REMOTE_USER=ana\nHABBLAUD_REMOTE_PORT=443\nHABBLAUD_REMOTE_HTTP_PORT=80\nHABBLAUD_REMOTE_BIND=0.0.0.0\n')).toEqual([
      '0.0.0.0:443:4748',
      '0.0.0.0:80:4748',
    ]);
    expect(remotePortsFrom('HABBLAUD_REMOTE_USER=ana\n')).toEqual(['127.0.0.1:4748:4748']);
    const yaml = renderOverride([], new Date(0), undefined, undefined, [], undefined, ['0.0.0.0:80:4748']);
    expect(yaml).toMatch(/    ports:\n      - "0\.0\.0\.0:80:4748"/);
  });
});

const closers: Array<() => void> = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

describe.skipIf(!HAS_OPENSSL)('certificates (openssl)', () => {
  const targets = remoteTargets({ name: 'myclaude', domain: 'myclaude.home' }, { dns: ['localhost'], ips: ['127.0.0.1', '192.168.1.10'] });

  it('creates CA (600 key) and server certificate signed by it with all names', () => {
    const tmp = tempDir();
    closers.push(tmp.cleanup);
    const paths = tlsPaths(join(tmp.dir, 'remote-tls'));
    const r = ensureServerCert(paths, targets);
    expect(r).toMatchObject({ createdCa: true, issued: true });
    expect(statSync(paths.caKey).mode & 0o777).toBe(0o600);
    expect(statSync(paths.base).mode & 0o777).toBe(0o700);
    const cert = new X509Certificate(readFileSync(paths.serverCert));
    const ca = new X509Certificate(readFileSync(paths.caCert));
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(ca.ca).toBe(true);
    expect(certTargets(readFileSync(paths.serverCert))).toEqual({ dns: ['localhost', 'myclaude.local', 'myclaude.home'], ips: ['127.0.0.1', '192.168.1.10'] });
    const days = (new Date(cert.validTo).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(395);
    expect(days).toBeLessThan(398);
    expect(caFingerprint(paths)).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(readFileSync(paths.publicCa, 'utf8')).toBe(readFileSync(paths.caCert, 'utf8'));
  });

  it('CA only signs localhost, .local, own address, and private IPs (certificate for another site fails)', () => {
    const tmp = tempDir();
    closers.push(tmp.cleanup);
    const paths = tlsPaths(join(tmp.dir, 'remote-tls'));
    ensureServerCert(paths, targets);
    const ok = spawnSync('openssl', ['verify', '-CAfile', paths.caCert, paths.serverCert], { encoding: 'utf8' });
    expect(ok.status, ok.stderr).toBe(0);
    // A certificate for example.com signed with CA key (as a thief would do) is invalid.
    const key = join(tmp.dir, 'evil.key');
    const csr = join(tmp.dir, 'evil.csr');
    const crt = join(tmp.dir, 'evil.crt');
    const ext = join(tmp.dir, 'evil.ext');
    writeFileSync(ext, 'basicConstraints = critical,CA:FALSE\nsubjectAltName = DNS:example.com\n');
    expect(spawnSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=example.com']).status).toBe(0);
    expect(spawnSync('openssl', ['x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey, '-days', '1', '-set_serial', '7', '-extfile', ext, '-out', crt]).status).toBe(0);
    const evil = spawnSync('openssl', ['verify', '-CAfile', paths.caCert, crt], { encoding: 'utf8' });
    expect(evil.status).not.toBe(0);
    expect(`${evil.stdout}${evil.stderr}`).toMatch(/subtree/i);
    // New own address does not fit in this CA: docker:up requests setup; setup (newCa) creates another.
    const other = remoteTargets({ name: 'myclaude', domain: 'other.lan' }, { dns: ['localhost'], ips: ['127.0.0.1'] });
    expect(caCovers(paths, other)).toBe(false);
    expect(() => ensureServerCert(paths, other)).toThrow(/remote:setup/);
    const fp = caFingerprint(paths);
    expect(ensureServerCert(paths, other, { newCa: true })).toMatchObject({ createdCa: true, issued: true });
    expect(caFingerprint(paths)).not.toBe(fp);
    expect(caCovers(paths, other)).toBe(true);
  });

  it('IPs: only private networks (and 100.64/10 from Tailscale) enter certificate', () => {
    expect(['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.0.10', '100.100.1.2'].every(isPrivateIpv4)).toBe(true);
    expect(['8.8.8.8', '172.32.0.1', '100.128.0.1', '169.254.1.1', '1.2.3', 'x'].some(isPrivateIpv4)).toBe(false);
    const ifaces = { en0: [{ family: 'IPv4', address: '192.168.1.5', internal: false }, { family: 'IPv4', address: '203.0.113.9', internal: false }] };
    expect(lanAddresses(ifaces as unknown as ReturnType<typeof import('node:os').networkInterfaces>)).toEqual(['192.168.1.5']);
  });

  it('does not recreate unnecessarily; recreates when IP changes, keeping same CA', () => {
    const tmp = tempDir();
    closers.push(tmp.cleanup);
    const paths = tlsPaths(join(tmp.dir, 'remote-tls'));
    ensureServerCert(paths, targets);
    const fp = caFingerprint(paths);
    expect(ensureServerCert(paths, targets)).toMatchObject({ createdCa: false, issued: false });
    const moved = { ...targets, ips: ['127.0.0.1', '10.0.0.7'] };
    expect(serverCertStatus(paths, moved)).toMatchObject({ ok: false, reason: expect.stringContaining('10.0.0.7') });
    expect(ensureServerCert(paths, moved)).toMatchObject({ createdCa: false, issued: true });
    expect(caFingerprint(paths)).toBe(fp);
    expect(serverCertStatus(paths, moved).ok).toBe(true);
  });

  it('remote port speaks HTTPS with certificate, redirects http:// to https://, and reloads new certificate', async () => {
    const tmp = tempDir();
    closers.push(tmp.cleanup);
    const paths = tlsPaths(join(tmp.dir, 'remote-tls'));
    ensureServerCert(paths, targets);
    const listener: RemoteListener = startRemoteListener(
      { port: 0, host: '127.0.0.1', tls: { dir: paths.serverDir, keyFile: paths.serverKey, certFile: paths.serverCert, caFile: paths.publicCa } },
      (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok-https');
      },
      quiet,
      new Set(['myclaude.local']),
    );
    closers.push(() => listener.close());
    await new Promise<void>((ok) => (listener.server.listening ? ok() : listener.server.once('listening', () => ok())));
    const port = (listener.server.address() as AddressInfo).port;
    const ca = readFileSync(paths.caCert);
    const get = (servername: string) =>
      new Promise<{ status: number; body: string; serial: string }>((ok, fail) => {
        const req = https.request({ host: '127.0.0.1', port, path: '/', ca, servername, headers: { Host: `${servername}:${port}` } }, (res) => {
          const serial = (res.socket as import('node:tls').TLSSocket).getPeerCertificate().serialNumber;
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => ok({ status: res.statusCode ?? 0, body, serial }));
        });
        req.on('error', fail);
        req.end();
      });
    const first = await get('myclaude.local');
    expect(first).toMatchObject({ status: 200, body: 'ok-https' });
    // HTTP without "s": 308 to https://
    const redirect = await new Promise<{ status: number; location?: string }>((ok, fail) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/x?y=1', headers: { Host: `myclaude.local:${port}` } }, (res) => {
        res.resume();
        ok({ status: res.statusCode ?? 0, location: res.headers.location });
      });
      req.on('error', fail);
      req.end();
    });
    expect(redirect).toEqual({ status: 308, location: `https://myclaude.local:${port}/x?y=1` });
    // Name unknown to Habblaud does not redirect (no sending browser elsewhere).
    const foreign = await new Promise<number>((ok, fail) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        ok(res.statusCode ?? 0);
      });
      req.on('error', fail);
      req.end();
    });
    expect(foreign).toBe(400);
    // New certificate (renewal): server swaps without restart.
    ensureServerCert(paths, targets, { force: true });
    const future = new Date(Date.now() + 60_000);
    utimesSync(paths.serverCert, future, future);
    await new Promise((r) => setTimeout(r, 16_500));
    const second = await get('myclaude.local');
    expect(second.status).toBe(200);
    expect(second.serial).not.toBe(first.serial);
  }, 30_000);
});

describe('docker-compose.yml', () => {
  it('passes to container every remote access variable read by server', () => {
    const compose = readFileSync(join(__dirname, '..', '..', 'docker-compose.yml'), 'utf8');
    const server = readFileSync(join(__dirname, '..', 'http', 'remote.ts'), 'utf8');
    // In Docker, port, host, and certificate folder are fixed (4748, 0.0.0.0, /remote-tls): the rest must come from .env.
    const fixedInDocker = new Set(['HABBLAUD_REMOTE_PORT', 'HABBLAUD_REMOTE_HOST', 'HABBLAUD_REMOTE_TLS_DIR', 'HABBLAUD_REMOTE_PASSWORD']);
    const read = [...new Set([...server.matchAll(/env\.(HABBLAUD_REMOTE_[A-Z_]+)/g)].map((m) => m[1]))].filter((k) => !fixedInDocker.has(k));
    expect(read.sort()).toEqual(['HABBLAUD_REMOTE_ALLOW', 'HABBLAUD_REMOTE_INSECURE_HTTP', 'HABBLAUD_REMOTE_PASSWORD_HASH', 'HABBLAUD_REMOTE_USER']);
    for (const key of read) expect(compose, key).toMatch(new RegExp(`^\\s+${key}: \\$\\{${key}:-\\}$`, 'm'));
    expect(compose).not.toMatch(/HABBLAUD_REMOTE_PASSWORD: /);
    // Remote port is only published by docker:up override, after setup.
    expect(compose).not.toMatch(/4748/);
  });
});
