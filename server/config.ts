// Server configuration from environment variables (documented in server/README.md).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeDirs } from './accounts/detect';
import { parseAllowedHosts } from './http/guard';
import { parseRemoteConfig, type RemoteConfig } from './http/remote';
import { parseGithubRepo } from './updates/checker';
import { tr } from '../shared/i18n';

export interface ServerConfig {
  port: number;
  host: string;
  /** `--dev`: Vite in middleware mode (HMR) on the same server. */
  dev: boolean;
  /** Starts demo simulator on launch. */
  demo: boolean;
  /** Running inside a container (registry PIDs are from host: cannot check them). */
  inDocker: boolean;
  home: string;
  /** Observed Claude Code config dirs (one per account). */
  claudeDirs: string[];
  /** Where Habblaud stores its own state (persisted names). */
  dataDir: string;
  /**
   * Directory with usage captured by Claude Code statusline (scripts/statusline-tap.mjs):
   * HABBLAUD_USAGE_DIR or ~/.habblaud/usage. In Docker, docker-up mounts this directory to /usage.
   */
  usageDir: string;
  /** Extra names accepted in Host/Origin header (HABBLAUD_ALLOWED_HOSTS); localhost and IPs always valid. */
  allowedHosts: Set<string>;
  /**
   * Terminal (GET /api/agents/:id/terminal) enabled: only with local bind, i.e., Habblaud accessible only
   * from the computer itself (see terminalOffReason). Locks everything that displays or acts on sessions.
   */
  terminal: boolean;
  /**
   * Messages across the office (POST /api/messages and habblaud-mensagens plugin inbox) enabled:
   * terminal lock and HABBLAUD_MENSAGENS enabled (see messagesOffReason).
   */
  messages: boolean;
  /** Records office timeline for timelapse (<dataDir>/timeline); HABBLAUD_TIMELINE=0 disables it. */
  timeline: boolean;
  /** Project root (where package.json lives); serves dist/client from here. */
  rootDir: string;
  version: string;
  /** GitHub repository ("owner/repo", from package.json `repository` field) where new releases are published. */
  repo?: string;
  /** Checks GitHub for new releases (server/updates/checker.ts); HABBLAUD_UPDATE_CHECK=0 disables it. */
  updateCheck: boolean;
  /** Observes Codex sessions (sources/codex/); HABBLAUD_CODEX=0 disables it. */
  codex: boolean;
  /**
   * Antigravity CLI workers (sources/agy/): profiles in ~/.agy_profiles; HABBLAUD_AGY=0 disables it. `room` = their
   * room directory (HABBLAUD_AGY_ROOM; default ~/Workspace/agy-hub if present, else HOME); `usageMs` = interval for
   * each account's `/usage` (HABBLAUD_AGY_USAGE_MIN, in minutes; 0 disables it).
   */
  agy: { enabled: boolean; room: string; usageMs: number };
  /** Second port, with login, for mobile on local network (http/remote.ts); missing = disabled. */
  remote?: RemoteConfig;
  /** Why remote access was disabled when variables are incomplete. */
  remoteWarning?: string;
  /** Habblaud World (server/world/): account, character, and, in future phases, building in the world. */
  world: WorldConfig;
}

export interface WorldConfig {
  /** HABBLAUD_WORLD other than 0 (false, off, no): /api/world/* routes exist and interface shows section. */
  enabled: boolean;
  /**
   * HTTP(S) base of the world server, without trailing slash (from HABBLAUD_WORLD_URL or DEFAULT_WORLD_URL;
   * `wss://` becomes `https://`). Missing = HABBLAUD_WORLD_URL rejected (`warning` explains why): feature stays off
   * and nothing leaves the computer. WebSocket is the same origin with /v1/socket.
   */
  url?: string;
  /** The URL came from default (HABBLAUD_WORLD_URL missing or empty). */
  defaultUrl?: true;
  /**
   * `--dev` or HABBLAUD_WORLD_DEV=1: also accepts `http://` and `ws://` for 127.0.0.1 and host.docker.internal (local
   * world server; from Habblaud container, host is host.docker.internal).
   */
  dev: boolean;
  /** Why HABBLAUD_WORLD_URL was rejected (logged on start). */
  warning?: string;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Walks up from `from` until finding the project package.json. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'habblaud') return dir;
      } catch {
        // unreadable package.json: keep walking up
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

/** Version and repository from package.json. */
function readPackage(rootDir: string): { version: string; repo?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown; repository?: unknown };
    return { version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', repo: parseGithubRepo(pkg.repository) };
  } catch {
    return { version: '0.0.0' };
  }
}

export function detectDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HABBLAUD_IN_DOCKER !== undefined) return isTruthy(env.HABBLAUD_IN_DOCKER);
  return existsSync('/.dockerenv');
}

/**
 * Listen address reachable only by the computer itself: 127.0.0.0/8, `::1` (with or without brackets),
 * or `localhost`. `0.0.0.0`, `::`, network IPs, and arbitrary names do not count.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    // Canonical form (0:0:0:0:0:0:0:1 -> [::1]).
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Why the terminal stays disabled (undefined = enabled). Transcripts contain full conversation, so it
 * only turns on when Habblaud is not exposed beyond the computer itself:
 * - Node: HABBLAUD_HOST must be loopback;
 * - Docker: process always listens on 0.0.0.0 inside container and exposure is decided by the host
 *   published port, HABBLAUD_BIND (docker-compose.yml forwards the same value to container). Missing
 *   or empty = disabled: without it we cannot know if the port is exposed.
 * HABBLAUD_TERMINAL with any value other than "enabled" (0, false, off...) disables it; there is no
 * way to enable it with an exposed port.
 */
export function terminalOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_TERMINAL?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_TERMINAL=${flag}`;
  if (inDocker) {
    const bind = env.HABBLAUD_BIND?.trim();
    if (!bind) return tr("HABBLAUD_BIND didn't reach the container, so the port may be exposed on the network");
    return isLoopbackBind(bind) ? undefined : tr('the port is exposed on the network: HABBLAUD_BIND={0}', [bind]);
  }
  return isLoopbackBind(host) ? undefined : tr('the port is exposed on the network: HABBLAUD_HOST={0}', [host]);
}

/**
 * Why office messages stay disabled (undefined = enabled). They enter the session as if you typed
 * them, so they follow the terminal lock; HABBLAUD_MENSAGENS with any value other than
 * "enabled" (0, false, off, no...) disables only them.
 */
export function messagesOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_MENSAGENS?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_MENSAGENS=${flag}`;
  const terminal = terminalOffReason(env, host, inDocker);
  return terminal ? tr('same lock as the terminal: {0}', [terminal]) : undefined;
}

/**
 * Habblaud World server when HABBLAUD_WORLD_URL is missing or empty: World is on by default, but nothing
 * leaves the computer until the user creates an account and logs in (server/world/service.ts).
 * HABBLAUD_WORLD=0 disables all.
 */
export const DEFAULT_WORLD_URL = 'https://server.habblaud.com';

/** Hosts accepted without TLS in dev mode: the computer itself and, from inside Docker, the host. */
const LOCAL_WORLD_HOSTS: readonly string[] = ['127.0.0.1', 'host.docker.internal'];

/**
 * Habblaud World from environment. Without HABBLAUD_WORLD_URL, DEFAULT_WORLD_URL. URL requires `https://` or
 * `wss://` (device token never travels without TLS); `http://` and `ws://` only in dev mode and only for
 * 127.0.0.1 or host.docker.internal (world server running locally, seen from outside or inside
 * Docker). No path, user, password, or query params: server address only. A defined and rejected URL does not
 * fall back to default: feature remains disabled, with reason in `warning`.
 */
export function parseWorldConfig(env: NodeJS.ProcessEnv, argv: string[]): WorldConfig {
  const flag = env.HABBLAUD_WORLD?.trim();
  const enabled = !flag || isTruthy(flag);
  const dev = argv.includes('--dev') || isTruthy(env.HABBLAUD_WORLD_DEV);
  if (!enabled) return { enabled, dev };
  const raw = env.HABBLAUD_WORLD_URL?.trim();
  if (!raw) return { enabled, dev, url: DEFAULT_WORLD_URL, defaultUrl: true };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL is not a valid address') };
  }
  const secure = u.protocol === 'https:' || u.protocol === 'wss:';
  const local = (u.protocol === 'http:' || u.protocol === 'ws:') && LOCAL_WORLD_HOSTS.includes(u.hostname);
  if (!secure && !(local && dev)) {
    return {
      enabled,
      dev,
      warning: local
        ? tr('HABBLAUD_WORLD_URL with http:// (127.0.0.1 or host.docker.internal) only works in development mode (--dev or HABBLAUD_WORLD_DEV=1)')
        : tr('HABBLAUD_WORLD_URL must start with https:// or wss://'),
    };
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return { enabled, dev, warning: tr('HABBLAUD_WORLD_URL must contain only the server address (no path, user, password or parameters)') };
  }
  return { enabled, dev, url: `${secure ? 'https:' : 'http:'}//${u.host}` };
}

/** World WebSocket address from HTTP(S) base (ServerConfig.world.url). */
export function worldSocketUrl(base: string): string {
  return `${base.replace(/^http/, 'ws').replace(/\/+$/, '')}/v1/socket`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  const host = env.HABBLAUD_HOST?.trim() || '127.0.0.1';
  const pkg = readPackage(rootDir);
  const remote = parseRemoteConfig(env, inDocker);
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host,
    dev: argv.includes('--dev'),
    demo: isTruthy(env.HABBLAUD_DEMO),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.HABBLAUD_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.habblaud'))),
    usageDir: resolve(env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage')),
    allowedHosts: parseAllowedHosts(env.HABBLAUD_ALLOWED_HOSTS),
    terminal: terminalOffReason(env, host, inDocker) === undefined,
    messages: messagesOffReason(env, host, inDocker) === undefined,
    timeline: !env.HABBLAUD_TIMELINE?.trim() || isTruthy(env.HABBLAUD_TIMELINE),
    rootDir,
    version: pkg.version,
    repo: pkg.repo,
    updateCheck: !env.HABBLAUD_UPDATE_CHECK?.trim() || isTruthy(env.HABBLAUD_UPDATE_CHECK),
    codex: !env.HABBLAUD_CODEX?.trim() || isTruthy(env.HABBLAUD_CODEX),
    agy: parseAgyConfig(env, home),
    remote: remote.config,
    remoteWarning: remote.warning,
    world: parseWorldConfig(env, argv),
  };
}

function parseAgyConfig(env: NodeJS.ProcessEnv, home: string): ServerConfig['agy'] {
  const hub = join(home, 'Workspace', 'agy-hub');
  const room = env.HABBLAUD_AGY_ROOM?.trim() ? resolve(env.HABBLAUD_AGY_ROOM.trim()) : existsSync(hub) ? hub : home;
  const min = Number(env.HABBLAUD_AGY_USAGE_MIN?.trim() || 15);
  return {
    enabled: !env.HABBLAUD_AGY?.trim() || isTruthy(env.HABBLAUD_AGY),
    room,
    usageMs: Number.isFinite(min) && min > 0 ? min * 60_000 : 0,
  };
}
