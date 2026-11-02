// Local Habblaud World routes (/api/world/*, server/world/http.ts): what the Habblaud page requests from local server,
// which speaks to the world server on its behalf. Local port only, with local Host (never via mobile port), and
// all account actions require terminal lock (local bind). Device token never reaches here.
//
//   GET  /api/world/status[?refresh=1]       → WorldStatus
//   POST /api/world/register                 {email, password, name, locale?, invite?} → 202 {} (name: player name,
//                                                reserved in waitlist; 422 name_invalid | name_blocked, 409 name_taken)
//   POST /api/world/verify                   {email, code} → 200 WorldStatus (login: stores token on this machine)
//   POST /api/world/login                    {email, password} → 200 WorldStatus
//   POST /api/world/logout                   {} → 200 WorldStatus (deletes token locally and revokes on server)
//   POST /api/world/resend                   {email} → 202 {}
//   POST /api/world/password/forgot          {email} → 202 {}
//   POST /api/world/password/reset           {email, code, password} → 204
//   PUT  /api/world/character                PlayerInput → 200 Player (when creating with reserved name,
//                                                without `name`)
//   PUT  /api/world/visibility               Visibility → 200 Visibility
//   GET  /api/world/devices                  → {devices: DeviceInfo[]}
//   POST /api/world/devices/:id/revoke       {} → 204 (device itself: logs out locally too)
//   PUT  /api/world/theme                    {theme: WorldThemeChoice} → 200 {theme} (stored in world.json)
//   POST /api/world/pause                    {} → 200 WorldStatus (stops sending payload before responding; connection
//                                                closes, or stays only for open World scene, without `uplink`;
//                                                notifies POST /v1/me/building/pause, documented in protocol.ts)
//   POST /api/world/resume                   {} → 200 WorldStatus (notifies POST /v1/me/building/resume and
//                                                reopens uplink; if world server does not respond, retries
//                                                with exponential backoff)
//   POST /api/world/leave                    {} → 200 WorldStatus ("Leave world": stops upload like pause, calls
//                                                DELETE /v1/me/building and only then responds; account and character
//                                                remain)
//   POST /api/world/join                     {} → 200 WorldStatus ("Return to world": POST /v1/me/building/join and,
//                                                with response, removes leave and pause and reopens uplink; next
//                                                payload creates new building on another lot; if not left, acts as
//                                                resume)
//   GET  /api/world/last-uplink              → WorldLastUplink | {} (exact last sent payload)
//
// Account and data (Phase 6):
//   POST /api/world/delete-account           {} → 202 {} ("Delete account": POST /v1/me/delete sends code to email)
//   POST /api/world/delete-account/confirm   {code} → 200 WorldStatus (POST /v1/me/delete/confirm; on success,
//                                                closes building connection and deletes entire world.json: session
//                                                removed locally and status returns without account, with lastError
//                                                `account_deleted`)
//   GET  /api/world/export                   → 200 WorldExport (account JSON from GET /v1/me/export),
//                                                attachment (habblaud-world-dados.json); once per day
//                                                (429 rate_limited); only via page itself, like stream
//   PUT  /api/world/visibility               also accepts `notifyInactivity` (optional): email notification before
//                                                removing building due to inactivity
// Lightweight social (Phase 5; server/world/social.ts), via building connection, whether World scene is open or not:
//   POST /api/world/summary/seen             {} → 204 (sends ↑ `summary.seen`: owner viewed "While you were away";
//                                                409 not_connected without world connection)
//   POST /api/world/unblock                  {playerId} → 204 (sends ↑ `unblock`; removes from local blocked list
//                                                immediately and re-reads /v1/me; 409 not_connected without connection)
// Building code ("Go to HB-XXXX") goes directly into scene ↑ `teleport {code}`: protocol route GET /v1/buildings/:code
// (BuildingCodeResponse) is not used by the page.
//
// World scene (Phase 3; server/world/viewer.ts), with same guards and no mobile port:
//   GET  /api/world/stream                   → text/event-stream: `world.snapshot` (WorldSceneSnapshot) on connect and
//                                                on each reconnect (world connection up or down, `view` again),
//                                                `world` (WorldSceneMessage) with each city message as received,
//                                                in order and without `rev` gaps, and `: ping` every 15 s. Maximum
//                                                4 open (429 too_many_streams). Opening first sends `view` to world
//                                                server; closing last sends `view.off`
//   POST /api/world/cmd                      {stream, cmds: WorldSceneCommand[]} → 202 {sent} (up to 5 batches/s per
//                                                stream, 20 commands per batch; per batch, only last `move` is sent)
//
// Errors: {error: {code, message?, retryAfter?}} with world server status when originating there (codes in protocol
// WORLD_ERROR_CODES; new codes pass as received) or with local codes below. UI translates using `code`; `message`
// is only for logs or curl users.
import {
  WORLD_ERROR_CODES,
  type AfkMessage,
  type AppearanceParts,
  type AreaMessage,
  type AreaPatchMessage,
  type AwaySummary,
  type AwaySummaryMessage,
  type CityFireworksMessage,
  type CityStatusMessage,
  type KnockedMessage,
  type KnockMessage,
  type LikesTodayMessage,
  type StampMessage,
  type SummarySeenMessage,
  type TeleportMessage,
  type BlockMessage,
  type BuildingMessage,
  type BuildingPatchMessage,
  type DeviceInfo,
  type EnterMessage,
  type GoodbyeReason,
  type GreetingMessage,
  type GreetMessage,
  type IntroId,
  type LeaveMessage,
  type LikeMessage,
  type LikeUpdateMessage,
  type MinimapMessage,
  type MoveMessage,
  type NoticeMessage,
  type Player,
  type PlayerJoinMessage,
  type PlayerLeaveMessage,
  type PlayersMessage,
  type PosMessage,
  type ProfileMessage,
  type ProfileRequestMessage,
  type ReportMessage,
  type ResyncMessage,
  type TraitId,
  type ViewMessage,
  type ViewOffMessage,
  type VisitorsMessage,
  type WorldBuildingDetail,
  type WorldAccess,
  type WorldBuildingPublic,
  type WorldErrorCode,
  type UplinkAckError,
  type WorldPlayerPublic,
  type WorldPosition,
  type WorldTheme,
  type WorldUplink,
} from './protocol';

/**
 * Theme chosen in Settings › Appearance, saved in world.json (PUT /api/world/theme). Payload carries resolved
 * theme: automatic becomes calendar theme (server/world/theme.ts).
 */
export const WORLD_THEME_CHOICES = ['auto', 'none', 'halloween', 'christmas'] as const;
export type WorldThemeChoice = 'auto' | WorldTheme;

export function isWorldThemeChoice(v: unknown): v is WorldThemeChoice {
  return typeof v === 'string' && (WORLD_THEME_CHOICES as readonly string[]).includes(v);
}

/** Account state on this computer. */
export type WorldState = 'off' | 'logged_out' | 'waiting' | 'approved';

/** Why building upload stopped: reason from world server goodbye (deploy only reconnects). */
export type WorldBuildingStop = Exclude<GoodbyeReason, 'deploy'>;

/**
 * World server response to uplink (`uplink.ack`): accepted (`at` and `bytes` counted by it) or rejected with
 * reason (`error`, only UPLINK_ACK_ERRORS codes; unknown codes to this version become `internal`; `at` is time
 * rejection arrived locally).
 */
export interface WorldUplinkAck {
  ok: boolean;
  error?: UplinkAckError;
  /** Timestamp (ms). */
  at: number;
  bytes?: number;
}

/**
 * Building of this machine in the world: GET /api/world/status → `building`, only with approved account and created
 * character. `floors` and `agents` are from last upload (before it, values sent by server in `welcome`; 0 if none).
 */
export interface WorldBuildingStatus {
  /**
   * WebSocket open and accepted (`welcome`) and building uploading. Paused or outside world is always false: connection
   * opened by World scene to walk the city does not carry the building.
   */
  connected: boolean;
  /** Paused by owner (POST /api/world/pause). */
  paused: boolean;
  floors: number;
  agents: number;
  /** Last upload (ms). */
  lastUplinkAt?: number;
  /** Response to last upload (absent while pending). */
  lastAck?: { ok: boolean; error?: UplinkAckError };
  /**
   * World server closed connection and building stopped: `banned`/`suspended` (account), `update` (outdated version),
   * `other-device` (account connected elsewhere; resumes with "Resume" or when reopening Habblaud), `waiting`,
   * `no_player`, `unauthorized` (remote account changed; local state updated).
   */
  stopped?: WorldBuildingStop;
  /** Left world (POST /api/world/leave): building removed and no payloads sent until join (new building, new lot). */
  left?: true;
  /** Visitors inside building right now (see WorldBuildingMeta.visitors). */
  visitors?: number;
  /**
   * World marked building as "unverified" (WorldBuildingPublic.unverified, from `welcome` or city): data
   * seemed implausible and is under review; building excluded from leaderboards and spotlights. Can be disputed.
   */
  unverified?: true;
  /** Likes received today (see WorldBuildingMeta.likesToday). */
  likesToday?: number;
  /** Knocks on door since this Habblaud opened (see WorldBuildingMeta.knocks). */
  knocks?: number;
  /** "While you were away" not yet viewed (↓ `away.summary` or /v1/me): visits, likes, and stamps, anonymous. */
  summary?: AwaySummary;
  /** Building code ("HB-4F2K", from /v1/me), to share with a friend. */
  code?: string;
}

/** OfficeSnapshot.meta.world.building: building summary (without account), for UI to show without polling status. */
export interface WorldBuildingMeta {
  connected: boolean;
  paused: boolean;
  floors: number;
  agents: number;
  lastUplinkAt?: number;
  /** Left world (see WorldBuildingStatus.left). */
  left?: true;
  /** World server stopped building (`goodbye`); reason only goes in status, not sent to mobile. */
  stopped?: true;
  /**
   * Visitors inside building right now (↓ `visitors {count}` on building connection, Phase 4): absent before first
   * count, without connection, and when building closed to visits (when closed, server does not even send 0).
   */
  visitors?: number;
  /** Likes received today (↓ `likes.today` or /v1/me; Phase 5): "❤️ 3 today" toolbar chip. */
  likesToday?: number;
  /**
   * Knocks on door since this Habblaud opened (↓ `knock {}`, nameless; only with `knocks` enabled in visibility):
   * page shows notification when count increases.
   */
  knocks?: number;
  /** Has an unviewed "While you were away" (summary itself only goes in status, not sent to mobile). */
  awaySummary?: true;
}

/** GET /api/world/last-uplink ("See what was sent"): exact payload of last upload, bytes, and ack. */
export interface WorldLastUplink {
  at: number;
  /** Payload JSON bytes (UTF-8), as measured by world server. */
  bytes: number;
  uplink: WorldUplink;
  ack?: WorldUplinkAck;
}

/**
 * OfficeSnapshot.meta.world: minimal data for UI to decide whether to show section (snapshot also goes to
 * mobile and timeline: no account data here).
 */
export interface WorldMeta {
  /**
   * Section appears: HABBLAUD_WORLD is not 0 and world server was accepted (default server.habblaud.com or valid
   * HABBLAUD_WORLD_URL). If URL is rejected, feature is disabled and nothing from World appears in UI.
   */
  enabled: boolean;
  /** World server accepted (default or valid HABBLAUD_WORLD_URL). */
  configured: boolean;
  state: WorldState;
  /** Building in the world (only with approved account and created character). */
  building?: WorldBuildingMeta;
  /**
   * World scene (Phase 3), only with World configured, approved account, and created character; `available` also
   * requires terminal lock (scene routes require it) and no stop from ban, suspension, rejected version, or
   * another machine (connection does not resume automatically). Paused or outside world remains valid (walk with
   * dark building). Toolbar shows World button when `available`.
   */
  scene?: WorldSceneMeta;
}

export interface WorldSceneMeta {
  available: boolean;
}

// ------------------------------------------------------------------------------------------- World scene (Phase 3)

/** Commands browser can send in POST /api/world/cmd (never building commands: hello, uplink, ping never). */
export const WORLD_SCENE_COMMANDS = [
  'move', 'profile', 'resync', 'view', 'view.off', 'enter', 'leave', 'like', 'unlike', 'greet', 'block', 'unblock', 'report',
  'stamp', 'teleport', 'knock', 'summary.seen',
] as const;
export type WorldSceneCommand =
  | MoveMessage
  | ProfileRequestMessage
  | ResyncMessage
  | ViewMessage
  | ViewOffMessage
  | EnterMessage
  | LeaveMessage
  | LikeMessage
  | GreetMessage
  | BlockMessage
  | ReportMessage
  | StampMessage
  | TeleportMessage
  | KnockMessage
  | SummarySeenMessage;

/** Commands per batch (POST /api/world/cmd) and batches per second per stream. */
export const WORLD_SCENE_LIMITS = { cmdsPerBatch: 20, batchesPerSec: 5, streams: 4 } as const;

/**
 * City messages forwarded by stream (`world` event), as received from world server. Local server already
 * verified patch `rev` (gaps trigger `resync` and patch is dropped) and discarded non-scene messages.
 */
export type WorldSceneMessage =
  | AreaMessage
  | AreaPatchMessage
  | PlayersMessage
  | PlayerJoinMessage
  | PlayerLeaveMessage
  | PosMessage
  | MinimapMessage
  | AfkMessage
  | ProfileMessage
  | NoticeMessage
  | LikeUpdateMessage
  | GreetingMessage
  | BuildingMessage
  | BuildingPatchMessage
  | VisitorsMessage
  | CityStatusMessage
  | CityFireworksMessage
  | LikesTodayMessage
  | AwaySummaryMessage
  | KnockedMessage;

export const WORLD_SCENE_MESSAGES = [
  'area', 'area.patch', 'players', 'player.join', 'player.leave', 'pos', 'minimap', 'afk', 'profile', 'notice', 'like.update',
  'greeting', 'building', 'building.patch', 'visitors',
  'city', 'city.fireworks', 'likes.today', 'away.summary', 'knock',
] as const satisfies readonly WorldSceneMessage['t'][];

/**
 * Inside a building (Phase 4, Visit scene): interior sent by world server in `building` (on enter or
 * `resync {building}`), with each `building.patch` already applied, and current building `rev`.
 */
export interface WorldSceneInside {
  /** Building ID (owner ID). */
  id: string;
  rev: number;
  detail: WorldBuildingDetail;
}

/** The city (↓ `city`, Phase 5): lit buildings, weekly goal, and token tier (both only with 10+ buildings). */
export type WorldSceneCity = Omit<CityStatusMessage, 't'>;

/** Self in scene: player of this account (from `welcome`), without visibility options. */
export interface WorldSceneMe {
  id: string;
  name: string;
  look: 'f' | 'm';
  parts: AppearanceParts;
  traits: TraitId[];
  intro?: IntroId;
  country?: string;
  /** Building of this account (building ID is owner ID), if it has one in the world. */
  buildingId?: string;
}

/** Buildings of a chunk, with current `rev`. */
export interface WorldSceneChunk {
  chunk: string;
  rev: number;
  buildings: WorldBuildingPublic[];
}

/** City state held by local server (`world.snapshot` event): browser replaces its entire state with this. */
export interface WorldSceneSnapshot {
  /** Stream ID: sent in POST /api/world/cmd. */
  stream: string;
  /**
   * Connection to world server is open (`welcome`). Without it (dropped, reconnecting, stopped by server), nothing
   * is received. When paused or outside world, opens only with scene open, without building payload.
   */
  connected: boolean;
  /** `view` sent: world server is sending area and players. */
  viewing: boolean;
  /** District of chunk IDs (`<district>:<cx>,<cy>`), from `welcome`. */
  district?: string;
  me?: WorldSceneMe;
  /** My position: from latest server `pos` (or my ID in `players`) or latest sent `move`. */
  pos?: WorldPosition;
  /** Server sent `afk` and no real command sent yet (move, turn, `view`, `profile`). */
  afk: boolean;
  /** Subscribed chunks (only the 3×3 around my position). */
  chunks: WorldSceneChunk[];
  /** Other visible players (never self), with latest position. */
  players: WorldPlayerPublic[];
  /** Minimap (lit buildings per block), or null before first update. */
  minimap: MinimapMessage['blocks'] | null;
  /** Inside a building: interior (until `pos` signaling "back to street"). Absent on street. */
  inside?: WorldSceneInside;
  /** Latest `city` (Phase 5): world server sends one on opening scene and then one per minute. */
  city?: WorldSceneCity;
  /** Likes received today by my building (latest ↓ `likes.today` for this connection). */
  likesToday?: number;
  /** Latest "While you were away" for this connection, until `summary.seen`. */
  summary?: AwaySummary;
}

/** GET /api/world/status (and response to verify, login, and logout). */
export interface WorldStatus {
  /** Can act on account in this Habblaud (terminal lock on: local machine access only). */
  available: boolean;
  configured: boolean;
  state: WorldState;
  /**
   * `id`: world account ID, when known (from building connection `welcome`); used in appeal subject.
   * `reservedName`: player name chosen during signup, reserved while player is not yet created (from `GET /v1/me`).
   */
  account?: { emailMasked: string; access: WorldAccess; id?: string; reservedName?: string };
  player?: Player;
  devices?: DeviceInfo[];
  /** Code of last error (worldLastError: known codes only), when data may be stale. */
  lastError?: WorldKnownErrorCode;
  /** Building in the world (only with approved account and created character). */
  building?: WorldBuildingStatus;
  /** Saved theme for building (PUT /api/world/theme); absent = 'auto'. */
  theme?: WorldThemeChoice;
  /** Blocked players by this account (/v1/me; Phase 5): Settings › Habblaud World › Blocked. */
  blocked?: WorldBlockedPlayer[];
}

/** A blocked player (only world-assigned ID and name). */
export interface WorldBlockedPlayer {
  id: string;
  name: string;
}

export interface WorldErrorResponse {
  error: { code: string; message?: string; retryAfter?: number };
}

/**
 * Error codes generated by the local server itself. It also uses, with the same meaning, some from WORLD_ERROR_CODES
 * (from the world server): invalid, invalid_code, password_invalid, name_invalid, name_blocked, invalid_json,
 * too_large, unsupported_media_type, method_not_allowed, not_found, and internal (500: local server error).
 */
export const WORLD_LOCAL_ERROR_CODES = [
  'not_configured', // 409: no accepted world server (HABBLAUD_WORLD_URL rejected)
  'local_only', // 403: via mobile port or non-local Host
  'terminal_off', // 403: terminal lock disabled (network-exposed port or HABBLAUD_TERMINAL=0)
  'not_logged_in', // 401: account action while not logged in
  'session_expired', // in lastError: world server rejected token (revoked or expired) and session was cleared
  'invalid_email', // 400
  'altcha_failed', // 502: world server captcha challenge had no solution
  'world_unreachable', // 502: no connection to world server
  'world_timeout', // 504
  'world_bad_response', // 502: malformed response
  'world_error', // world server error without readable code (same status)
  'storage_failed', // in lastError: failed to write world.json (session valid only until restart)
  'too_many_streams', // 429: World scene already open in 4 tabs
  'no_stream', // 409: command for a stream not open (scene closed or server restarted)
  'not_connected', // 409: command without open connection to world server
  'account_deleted', // in lastError: account was deleted (locally or on another machine) and world.json removed
  'network', // in lastError: no connection to world server or timeout
  'unknown', // in lastError: other issue (malformed response, code unknown to this version)
] as const;
export type WorldLocalErrorCode = (typeof WORLD_LOCAL_ERROR_CODES)[number];

/** All known error codes: world server and local server codes, deduplicated. */
export const WORLD_KNOWN_ERROR_CODES: readonly (WorldErrorCode | WorldLocalErrorCode)[] = [...new Set([...WORLD_ERROR_CODES, ...WORLD_LOCAL_ERROR_CODES])];
export type WorldKnownErrorCode = WorldErrorCode | WorldLocalErrorCode;

export function isWorldKnownErrorCode(v: unknown): v is WorldKnownErrorCode {
  return typeof v === 'string' && (WORLD_KNOWN_ERROR_CODES as readonly string[]).includes(v);
}

/**
 * Code placed in WorldStatus.lastError: list codes only; connection failure or timeout becomes `network`,
 * and remaining (malformed response, uncoded error, code unknown to this version) becomes `unknown`.
 */
export function worldLastError(code: string): WorldKnownErrorCode {
  if (code === 'world_unreachable' || code === 'world_timeout') return 'network';
  if (code === 'world_bad_response' || code === 'world_error') return 'unknown';
  return isWorldKnownErrorCode(code) ? code : 'unknown';
}
