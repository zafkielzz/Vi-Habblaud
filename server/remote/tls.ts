// HTTPS for remote port: a local Certificate Authority (CA), created once per installation, and server certificate
// signed by it. The phone trusts the CA once (installing ca.crt) and from then on the connection is encrypted
// without warnings. Generated using system `openssl` (macOS, Linux, and Ubuntu on WSL already include it).
//
// Directories (default ~/.habblaud/remote-tls, permissions 700):
//   ca/ca.key, ca/ca.crt            the CA: private key NEVER leaves here (does not go into container)
//   ca/constraints.json             the names that CA can sign (see below)
//   server/server.key, server.crt   the server certificate (docker-up mounts ONLY this directory, read-only)
//   server/ca.crt                   public copy of CA, served at /remote/ca.crt to install on phone
//
// Server certificate is valid for 397 days (Apple limit) and covers localhost, <name>.local and local network IPs;
// ensureServerCert regenerates it when a name/IP is missing (Wi-Fi IP changed) or when 30 days remain.
//
// CA is constrained (nameConstraints, critical): only valid for localhost, .local names, custom domain chosen during
// setup, and private network IPs. Even if key leaks, certificate for any other site is rejected by phone trusting it.
// Changing custom domain requires a new CA (and reinstalling certificate on phone).
import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

export const CA_DAYS = 3650;
export const SERVER_DAYS = 397;
export const RENEW_BEFORE_DAYS = 30;

export interface TlsPaths {
  base: string;
  caDir: string;
  caKey: string;
  caCert: string;
  serverDir: string;
  serverKey: string;
  serverCert: string;
  publicCa: string;
}

export function tlsPaths(base: string): TlsPaths {
  const caDir = join(base, 'ca');
  const serverDir = join(base, 'server');
  return {
    base,
    caDir,
    caKey: join(caDir, 'ca.key'),
    caCert: join(caDir, 'ca.crt'),
    serverDir,
    serverKey: join(serverDir, 'server.key'),
    serverCert: join(serverDir, 'server.crt'),
    publicCa: join(serverDir, 'ca.crt'),
  };
}

/** IPv4 ranges that CA can sign: loopback, private networks, and 100.64/10 (CGNAT, Tailscale). */
const PRIVATE_V4: ReadonlyArray<readonly [string, string]> = [
  ['127.0.0.0', '255.0.0.0'],
  ['10.0.0.0', '255.0.0.0'],
  ['172.16.0.0', '255.240.0.0'],
  ['192.168.0.0', '255.255.0.0'],
  ['100.64.0.0', '255.192.0.0'],
];

function v4(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.some((n) => n > 255) ? undefined : (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

/** Private network IPv4 (what CA can sign). */
export function isPrivateIpv4(ip: string): boolean {
  const n = v4(ip);
  return n !== undefined && PRIVATE_V4.some(([net, mask]) => ((n & v4(mask)!) >>> 0) === v4(net));
}

/** Local network IPv4 (excluding loopback, link-local 169.254, or public addresses). */
export function lanAddresses(ifaces = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIpv4(a.address)) out.add(a.address);
    }
  }
  return [...out].sort();
}

/** Computer mDNS name (<name>.local), which the phone discovers even when IP changes. */
export function localDnsName(run = spawnSync): string | undefined {
  if (process.platform === 'darwin') {
    const r = run('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' });
    const name = typeof r.stdout === 'string' ? r.stdout.trim() : '';
    if (r.status === 0 && /^[A-Za-z0-9-]{1,63}$/.test(name)) return `${name.toLowerCase()}.local`;
  }
  const short = hostname().split('.')[0];
  return /^[A-Za-z0-9-]{1,63}$/.test(short) ? `${short.toLowerCase()}.local` : undefined;
}

export interface CertTargets {
  dns: string[];
  ips: string[];
}

export function defaultTargets(): CertTargets {
  const dns = ['localhost'];
  const local = localDnsName();
  if (local) dns.push(local);
  return { dns, ips: ['127.0.0.1', ...lanAddresses()] };
}

/** Names and IPs (subjectAltName) of a PEM certificate. */
export function certTargets(pem: string | Buffer): CertTargets {
  const san = new X509Certificate(pem).subjectAltName ?? '';
  const dns: string[] = [];
  const ips: string[] = [];
  for (const part of san.split(',')) {
    const [kind, ...rest] = part.trim().split(':');
    const value = rest.join(':');
    if (kind === 'DNS') dns.push(value.toLowerCase());
    else if (kind === 'IP Address') ips.push(value);
  }
  return { dns, ips };
}

export type CertStatus = { ok: true; expiresAt: Date } | { ok: false; reason: string };

/** Does the server certificate work as-is? (exists, signed by this CA, covers everything, not near expiration) */
export function serverCertStatus(paths: TlsPaths, wanted: CertTargets, now = new Date()): CertStatus {
  if (!existsSync(paths.serverCert) || !existsSync(paths.serverKey)) return { ok: false, reason: tr("server certificate doesn't exist yet") };
  if (!existsSync(paths.caCert)) return { ok: false, reason: tr("the local CA doesn't exist") };
  let cert: X509Certificate;
  let ca: X509Certificate;
  try {
    cert = new X509Certificate(readFileSync(paths.serverCert));
    ca = new X509Certificate(readFileSync(paths.caCert));
  } catch {
    return { ok: false, reason: tr('unreadable certificate') };
  }
  if (!cert.verify(ca.publicKey)) return { ok: false, reason: tr("certificate wasn't signed by the current CA") };
  const expiresAt = new Date(cert.validTo);
  if (expiresAt.getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86_400_000) return { ok: false, reason: tr('certificate about to expire') };
  const have = certTargets(readFileSync(paths.serverCert));
  const missing = [...wanted.dns.filter((d) => !have.dns.includes(d.toLowerCase())), ...wanted.ips.filter((ip) => !have.ips.includes(ip))];
  if (missing.length) return { ok: false, reason: tr('missing from the certificate: {0}', [missing.join(', ')]) };
  return { ok: true, expiresAt };
}

type Run = typeof spawnSync;

function openssl(run: Run, args: string[]): void {
  const r = run('openssl', args, { encoding: 'utf8' });
  if (r.error) throw new Error(tr("couldn't find openssl ({0}); install it and run again", [r.error.message]));
  if (r.status !== 0) throw new Error(tr('openssl {0} failed: {1}', [args[0], String(r.stderr).trim().split('\n').slice(-2).join(' ')]));
}

function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
}

function constraintsFile(paths: TlsPaths): string {
  return join(paths.caDir, 'constraints.json');
}

/** Names (DNS) that CA can sign: localhost, anything ending in .local, and `domains` (with subdomains). */
export function caDomains(domains: readonly string[] = []): string[] {
  return [...new Set(['localhost', 'local', ...domains.map((d) => d.trim().toLowerCase()).filter(Boolean)])];
}

/** Can this directory's CA sign all `targets`? (Old CA without constraints will not work.) */
export function caCovers(paths: TlsPaths, targets: CertTargets): boolean {
  let allowed: string[];
  try {
    const raw: unknown = JSON.parse(readFileSync(constraintsFile(paths), 'utf8'));
    allowed = Array.isArray((raw as { dns?: unknown }).dns) ? ((raw as { dns: unknown[] }).dns.filter((d) => typeof d === 'string') as string[]) : [];
  } catch {
    return false;
  }
  const okName = (name: string) => allowed.some((a) => name === a || name.endsWith(`.${a}`));
  return targets.dns.every((d) => okName(d.toLowerCase())) && targets.ips.every(isPrivateIpv4);
}

/** openssl.cnf lines for CA name constraints. */
export function nameConstraintLines(dns: readonly string[]): string[] {
  return [
    'nameConstraints = critical,@name_constraints',
    '[name_constraints]',
    ...dns.map((d, i) => `permitted;DNS.${i} = ${d}`),
    ...PRIVATE_V4.map(([net, mask], i) => `permitted;IP.${i} = ${net}/${mask}`),
  ];
}

/**
 * Creates local CA if it does not exist yet. Returns true when created. `domains`: custom domains it can sign
 * (besides localhost and .local).
 */
export function ensureCa(paths: TlsPaths, label: string, run: Run = spawnSync, domains: readonly string[] = []): boolean {
  if (existsSync(paths.caKey) && existsSync(paths.caCert)) return false;
  ensureDir(paths.base, 0o700);
  ensureDir(paths.caDir, 0o700);
  const dns = caDomains(domains);
  const work = join(tmpdir(), `habblaud-ca-${randomBytes(6).toString('hex')}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const cnf = join(work, 'ca.cnf');
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = v3_ca',
        '[dn]',
        `CN = Habblaud local CA (${label.replace(/[^A-Za-z0-9 .-]/g, '')})`,
        'O = Habblaud',
        '[v3_ca]',
        'basicConstraints = critical,CA:TRUE,pathlen:0',
        'keyUsage = critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier = hash',
        ...nameConstraintLines(dns),
        '',
      ].join('\n'),
    );
    const key = join(work, 'ca.key');
    const crt = join(work, 'ca.crt');
    openssl(run, ['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS), '-keyout', key, '-out', crt, '-config', cnf]);
    chmodSync(key, 0o600);
    writeFileSync(constraintsFile(paths), `${JSON.stringify({ dns })}\n`, { mode: 0o600 });
    renameSync(key, paths.caKey);
    renameSync(crt, paths.caCert);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Reissues server certificate signed by CA, covering `targets`. Replaces files atomically. */
export function issueServerCert(paths: TlsPaths, targets: CertTargets, run: Run = spawnSync): void {
  if (!existsSync(paths.caKey) || !existsSync(paths.caCert)) throw new Error(tr("the local CA doesn't exist: run npm run remote:setup"));
  ensureDir(paths.serverDir, 0o755);
  const work = join(tmpdir(), `habblaud-cert-${randomBytes(6).toString('hex')}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const key = join(work, 'server.key');
    const csr = join(work, 'server.csr');
    const crt = join(work, 'server.crt');
    const ext = join(work, 'server.ext');
    const cn = targets.dns.find((d) => d.endsWith('.local')) ?? 'localhost';
    writeFileSync(
      ext,
      [
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid,issuer',
        `subjectAltName = ${[...targets.dns.map((d) => `DNS:${d}`), ...targets.ips.map((ip) => `IP:${ip}`)].join(',')}`,
        '',
      ].join('\n'),
    );
    openssl(run, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', key, '-out', csr, '-subj', `/CN=${cn}/O=Habblaud`]);
    openssl(run, [
      'x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey, '-sha256', '-days', String(SERVER_DAYS),
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-extfile', ext, '-out', crt,
    ]);
    // Readable by container user (parent directory, 700, protects key on host).
    chmodSync(key, 0o644);
    chmodSync(crt, 0o644);
    // Atomic replacement (rename), in key -> cert order: reloaders seeing new cert already find new key.
    renameSync(key, paths.serverKey);
    renameSync(crt, paths.serverCert);
    copyFileSync(paths.caCert, paths.publicCa);
    chmodSync(paths.publicCa, 0o644);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface EnsureResult {
  createdCa: boolean;
  issued: boolean;
  reason?: string;
  targets: CertTargets;
}

/** Custom domains of `targets` (not localhost or .local), for CA name constraints. */
function ownDomains(targets: CertTargets): string[] {
  return targets.dns.filter((d) => d !== 'localhost' && !d.endsWith('.local'));
}

/**
 * Ensures CA and valid server certificate for current names/IPs (only regenerates when needed). IPs outside
 * private networks are excluded. If CA does not cover names (new custom domain or old CA without constraints):
 * with `newCa` (setup) creates a new one; otherwise fails asking to run setup.
 */
export function ensureServerCert(paths: TlsPaths, wanted: CertTargets = defaultTargets(), opts: { force?: boolean; run?: Run; newCa?: boolean } = {}): EnsureResult {
  const run = opts.run ?? spawnSync;
  const targets: CertTargets = { dns: wanted.dns, ips: wanted.ips.filter(isPrivateIpv4) };
  if (existsSync(paths.caKey) && existsSync(paths.caCert) && !caCovers(paths, targets)) {
    if (!opts.newCa) throw new Error(tr("the local CA doesn't cover {0}: run npm run remote:setup (it creates a new CA)", [targets.dns.join(', ')]));
    rmSync(paths.caDir, { recursive: true, force: true });
    rmSync(paths.serverDir, { recursive: true, force: true });
  }
  const createdCa = ensureCa(paths, targets.dns.find((d) => d.endsWith('.local')) ?? 'habblaud', run, ownDomains(targets));
  const status = serverCertStatus(paths, targets);
  if (!opts.force && !createdCa && status.ok) return { createdCa, issued: false, targets };
  issueServerCert(paths, targets, run);
  return { createdCa, issued: true, reason: opts.force ? tr('request') : status.ok ? tr('new CA') : status.reason, targets };
}

/** CA SHA-256 fingerprint, to verify on phone before trusting it. */
export function caFingerprint(paths: TlsPaths): string | undefined {
  try {
    return new X509Certificate(readFileSync(paths.caCert)).fingerprint256;
  } catch {
    return undefined;
  }
}

/** Remote access key directory (~/.habblaud/remote-tls). */
export function remoteTlsBase(home: string): string {
  return join(home, '.habblaud', 'remote-tls');
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Short name for <name>.local (letters, digits, and hyphens). */
export function isValidName(name: string): boolean {
  return LABEL.test(name);
}

/** Custom domain (e.g. myclaude.home): 2+ valid parts, no trailing dot or IP. */
export function isValidDomain(domain: string): boolean {
  const parts = domain.split('.');
  return parts.length >= 2 && parts.every((p) => LABEL.test(p)) && !/^\d+$/.test(parts[parts.length - 1]);
}

/** Certificate names: defaults (localhost, <computer>.local, IPs) + <name>.local + custom domain. */
export function remoteTargets(opts: { name?: string; domain?: string }, base: CertTargets = defaultTargets()): CertTargets {
  const dns = [...base.dns];
  for (const n of [opts.name ? `${opts.name}.local` : undefined, opts.domain]) {
    const v = n?.trim().toLowerCase();
    if (v && !dns.includes(v)) dns.push(v);
  }
  return { dns, ips: [...base.ips] };
}

/** IPv4 of default route interface (real Wi-Fi/cable); if unavailable, first local network IP. */
export function primaryIp(platform: NodeJS.Platform = process.platform): string | undefined {
  let iface: string | undefined;
  if (platform === 'darwin') {
    const r = spawnSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
    iface = /interface:\s*(\S+)/.exec(String(r.stdout))?.[1];
  } else if (platform === 'linux') {
    const r = spawnSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
    iface = /\bdev\s+(\S+)/.exec(String(r.stdout))?.[1];
  }
  const addr = iface ? networkInterfaces()[iface]?.find((a) => a.family === 'IPv4' && !a.internal)?.address : undefined;
  return addr ?? lanAddresses()[0];
}
