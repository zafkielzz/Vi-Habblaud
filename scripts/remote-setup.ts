// npm run remote:setup — enables phone access with login and HTTPS, in a single step.
//
// Prompts for (or takes as options) username, password (hidden, twice), address name (<name>.local) and,
// optionally, a custom address (e.g. myclaude.home); and then:
//   1. creates the local CA and server certificate (server/remote/tls.ts) in ~/.habblaud/remote-tls;
//   2. writes ONLY the scrypt hash of the password to .env (never the password), name, port and
//      HABBLAUD_REMOTE_BIND=0.0.0.0;
//   3. keeps the <name>.local announcement running as a service (npm run remote:mdns; LaunchAgent/systemd);
//   4. prints the addresses, CA fingerprint and phone setup instructions.
// Afterwards: npm run docker:up. To disable: npm run remote:setup -- --off.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addToList, readEnvValue, updateEnv } from '../server/remote/envfile';
import { hashPassword } from '../server/remote/password';
import { tr } from '../shared/i18n';
import { caFingerprint, ensureServerCert, isValidDomain, isValidName, primaryIp, remoteTargets, remoteTlsBase, tlsPaths } from '../server/remote/tls';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = join(ROOT, '.env');
const HOME = process.env.HOME || homedir();
export const MIN_PASSWORD = 10;
const SERVICE_LABEL = 'com.habblaud.remote-mdns';
const REMOTE_KEYS = [
  'HABBLAUD_REMOTE_USER',
  'HABBLAUD_REMOTE_PASSWORD',
  'HABBLAUD_REMOTE_PASSWORD_HASH',
  'HABBLAUD_REMOTE_BIND',
  'HABBLAUD_REMOTE_PORT',
  'HABBLAUD_REMOTE_HTTP_PORT',
  'HABBLAUD_REMOTE_NAME',
  'HABBLAUD_REMOTE_DOMAIN',
  'HABBLAUD_REMOTE_ALLOW',
];

export interface SetupArgs {
  user?: string;
  name?: string;
  domain?: string;
  port?: number;
  allow?: string;
  passwordStdin: boolean;
  service: boolean;
  off: boolean;
  help: boolean;
}

const USAGE = tr(`Usage: npm run remote:setup [-- options]

Turns on phone access (https://<name>.local) with username, password and HTTPS.

  --user <name>        login username (default: your system username)
  --name <name>        address <name>.local (default: habblaud)
  --domain <address>   own address, e.g. myclaude.home (needs an entry in the router's DNS)
  --port <n>           port on the computer (default: 443 if free, otherwise 4748)
  --allow <list>       what the phone can do: permissions, messages, terminal, spawn, none (default: permissions)
  --password-stdin     reads the password from standard input (automation) instead of asking
  --no-service         doesn't install the <name>.local announcement service (run npm run remote:mdns yourself)
  --off                turns off phone access (removes the lines from .env and the service; keeps the CA)`);

export function parseArgs(argv: string[]): SetupArgs {
  const out: SetupArgs = { passwordStdin: false, service: true, off: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(tr('missing value for {0}', [a]));
      return v;
    };
    if (a === '--user') out.user = val();
    else if (a === '--name') out.name = val().toLowerCase();
    else if (a === '--domain') out.domain = val().toLowerCase();
    else if (a === '--port') out.port = Number(val());
    else if (a === '--allow') out.allow = val();
    else if (a === '--password-stdin') out.passwordStdin = true;
    else if (a === '--no-service') out.service = false;
    else if (a === '--off') out.off = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(tr('unknown option: {0}', [a]));
  }
  if (out.port !== undefined && !(Number.isInteger(out.port) && out.port > 0 && out.port < 65536)) throw new Error(tr('invalid port'));
  return out;
}

/** Why the password is not accepted (undefined = valid). */
export function passwordProblem(password: string, user: string): string | undefined {
  if (password.length < MIN_PASSWORD) return tr('use at least {0} characters', [MIN_PASSWORD]);
  if (password.trim() !== password) return tr('no spaces at the start or end');
  if (password.toLowerCase() === user.toLowerCase()) return tr("the password can't be the username");
  return undefined;
}

/** The .env with remote access enabled (the rest of the file stays the same). */
export function remoteEnv(
  current: string,
  s: { user: string; hash: string; name: string; domain?: string; port: number; httpPort?: number; allow?: string },
): string {
  const hosts = addToList(readEnvValue(current, 'HABBLAUD_ALLOWED_HOSTS'), `${s.name}.local`, ...(s.domain ? [s.domain] : []));
  return updateEnv(current, {
    HABBLAUD_REMOTE_USER: s.user,
    HABBLAUD_REMOTE_PASSWORD: null,
    HABBLAUD_REMOTE_PASSWORD_HASH: s.hash,
    HABBLAUD_REMOTE_BIND: '0.0.0.0',
    HABBLAUD_REMOTE_PORT: String(s.port),
    HABBLAUD_REMOTE_HTTP_PORT: s.httpPort ? String(s.httpPort) : null,
    HABBLAUD_REMOTE_NAME: s.name,
    HABBLAUD_REMOTE_DOMAIN: s.domain ?? null,
    HABBLAUD_REMOTE_ALLOW: s.allow ?? readEnvValue(current, 'HABBLAUD_REMOTE_ALLOW') ?? null,
    HABBLAUD_ALLOWED_HOSTS: hosts,
  });
}

export function urlFor(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((ok) => {
    const srv = net.createServer();
    srv.once('error', () => ok(false));
    srv.listen(port, '0.0.0.0', () => srv.close(() => ok(true)));
  });
}

function ask(question: string, fallback?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((ok) =>
    rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `, (a) => {
      rl.close();
      ok(a.trim() || fallback || '');
    }),
  );
}

/** Prompts without echoing input (real terminal only). */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error(tr('no terminal to ask for the password: use --password-stdin'));
  return new Promise((ok) => {
    process.stdout.write(`${question}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          ok(buf);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function readStdinLine(): Promise<string> {
  return new Promise((ok) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (data += c));
    process.stdin.on('end', () => ok(data.split(/\r?\n/)[0] ?? ''));
  });
}

function writeEnv(content: string): void {
  writeFileSync(ENV_FILE, content, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

function tsxCommand(): string[] {
  return [process.execPath, join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(ROOT, 'scripts', 'remote-mdns.ts')];
}

function plistPath(): string {
  return join(HOME, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

function unitPath(): string {
  return join(HOME, '.config', 'systemd', 'user', 'habblaud-remote-mdns.service');
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Installs (or reinstalls) the <name>.local announcement as a service. Returns a status line. */
function installService(): string {
  const cmd = tsxCommand();
  const logDir = join(HOME, '.habblaud', 'logs');
  mkdirSync(logDir, { recursive: true });
  const pathEnv = [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>ProgramArguments</key>
  <array>${cmd.map((c) => `<string>${xml(c)}</string>`).join('')}</array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathEnv)}</string><key>HOME</key><string>${xml(HOME)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'remote-mdns.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'remote-mdns.log'))}</string>
</dict>
</plist>
`;
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), plist);
    const domain = `gui/${process.getuid?.() ?? userInfo().uid}`;
    spawnSync('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    const r = spawnSync('launchctl', ['bootstrap', domain, plistPath()], { encoding: 'utf8' });
    return r.status === 0 ? tr('service {0} enabled (log: ~/.habblaud/logs/remote-mdns.log)', [SERVICE_LABEL]) : tr("couldn't enable the service: {0}", [String(r.stderr).trim()]);
  }
  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=${tr('Habblaud: announces the .local address for phone access')}
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
Environment=PATH=${pathEnv}
ExecStart=${cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ')}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`;
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), unit);
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    const r = spawnSync('systemctl', ['--user', 'enable', '--now', 'habblaud-remote-mdns.service'], { encoding: 'utf8' });
    return r.status === 0
      ? tr('habblaud-remote-mdns service enabled (to keep it on while logged out: loginctl enable-linger)')
      : tr("couldn't enable the service: {0}", [String(r.stderr).trim()]);
  }
  return tr('{0}: no automatic service; keep npm run remote:mdns running or use the IP', [process.platform]);
}

function removeService(): void {
  if (process.platform === 'darwin' && existsSync(plistPath())) {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? userInfo().uid}/${SERVICE_LABEL}`], { stdio: 'ignore' });
    rmSync(plistPath(), { force: true });
  }
  if (process.platform === 'linux' && existsSync(unitPath())) {
    spawnSync('systemctl', ['--user', 'disable', '--now', 'habblaud-remote-mdns.service'], { stdio: 'ignore' });
    rmSync(unitPath(), { force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(USAGE);
  const current = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';

  if (args.off) {
    writeEnv(updateEnv(current, Object.fromEntries(REMOTE_KEYS.map((k) => [k, null]))));
    removeService();
    console.log(tr('[remote-setup] Phone access turned off (the CA stays in ~/.habblaud/remote-tls). Now: npm run docker:up'));
    return;
  }

  const user = args.user ?? (args.passwordStdin ? undefined : await ask(tr('Login username'), readEnvValue(current, 'HABBLAUD_REMOTE_USER') ?? userInfo().username));
  if (!user || /\s/.test(user)) throw new Error(tr('invalid username (no spaces)'));

  let password: string;
  if (args.passwordStdin) {
    password = await readStdinLine();
    const problem = passwordProblem(password, user);
    if (problem) throw new Error(tr('password rejected: {0}', [problem]));
  } else {
    for (;;) {
      password = await askHidden(tr('Password ({0}+ characters; hidden while you type)', [MIN_PASSWORD]));
      const problem = passwordProblem(password, user);
      if (problem) {
        console.log(`  ${problem}.`);
        continue;
      }
      if ((await askHidden(tr('Repeat the password'))) !== password) {
        console.log(tr("  they don't match; try again."));
        continue;
      }
      break;
    }
  }

  const name = args.name ?? (args.passwordStdin ? 'habblaud' : await ask(tr('Address name (becomes <name>.local)'), readEnvValue(current, 'HABBLAUD_REMOTE_NAME') ?? 'habblaud')).toLowerCase();
  if (!isValidName(name)) throw new Error(tr('invalid name: "{0}" (letters, numbers and hyphens)', [name]));
  const domainAnswer =
    args.domain ??
    (args.passwordStdin ? '' : await ask(tr('Own address, optional (e.g. myclaude.home; Enter skips)'), readEnvValue(current, 'HABBLAUD_REMOTE_DOMAIN') ?? ''));
  const domain = domainAnswer.trim().toLowerCase() || undefined;
  if (domain && !isValidDomain(domain)) throw new Error(tr('invalid address: "{0}"', [domain]));

  const existingPort = Number(readEnvValue(current, 'HABBLAUD_REMOTE_PORT'));
  const port = args.port ?? (Number.isInteger(existingPort) && existingPort > 0 ? existingPort : (await portFree(443)) ? 443 : 4748);

  // On 443, port 80 (if free) just redirects to https://: typing "myclaude.local" without https:// also works.
  const existingHttp = Number(readEnvValue(current, 'HABBLAUD_REMOTE_HTTP_PORT'));
  const httpPort = port !== 443 ? undefined : existingHttp === 80 || (await portFree(80)) ? 80 : undefined;

  console.log(tr('[remote-setup] Generating the password hash…'));
  const hash = await hashPassword(password);
  const paths = tlsPaths(remoteTlsBase(HOME));
  const hadCa = caFingerprint(paths);
  const cert = ensureServerCert(paths, remoteTargets({ name, domain }), { force: true, newCa: true });
  writeEnv(remoteEnv(current, { user, hash, name, domain, port, httpPort, allow: args.allow }));
  const service = args.service ? installService() : tr('service not installed (--no-service): run npm run remote:mdns');

  const fp = caFingerprint(paths);
  // Wi-Fi/cable IP (default route), not a VPN IP which also enters the certificate.
  const ip = primaryIp() ?? cert.targets.ips.find((i) => i !== '127.0.0.1');
  const caNote = !cert.createdCa ? '' : hadCa ? tr(' New local CA (the address changed or the previous one had no name constraints): install the certificate on the phone again.') : tr(' Local CA created.');
  const urls = [
    `${urlFor(`${name}.local`, port)}${ip ? tr('   (or {0})', [urlFor(ip, port)]) : ''}`,
    ...(domain ? [tr('{0}   (after creating it in the router: {1} -> {2})', [urlFor(domain, port), domain, ip ?? tr("this computer's IP")])] : []),
  ];
  console.log(
    [
      '',
      tr('[remote-setup] Done.{0}', [caNote]),
      tr('  .env:        user "{0}", password stored only as a hash (scrypt), port {1}', [user, port]),
      tr('  Certificate: {0}', [cert.targets.dns.concat(cert.targets.ips).join(', ')]),
      tr('  Announcing:  {0}', [service]),
      '',
      tr('  Now run:     npm run docker:up'),
      '',
      tr('  On the phone (same Wi-Fi):'),
      ...urls.map((u) => `    ${u}`),
      tr('  First time: accept the warning, tap "Install the Habblaud certificate" and trust it'),
      tr('    iPhone:  Settings > Profile Downloaded > Install; then Settings > General > About > Certificate Trust Settings'),
      tr('    Android: Settings > Security > Encryption & credentials > Install a certificate > CA certificate'),
      tr('  CA fingerprint (check it on the phone before trusting it):'),
      `    ${fp ?? tr('(unavailable)')}`,
    ].join('\n'),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(tr('[remote-setup] Error: {0}', [(err as Error).message]));
    process.exitCode = 1;
  });
}
