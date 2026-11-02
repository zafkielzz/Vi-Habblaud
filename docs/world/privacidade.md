# Habblaud World: what leaves your computer

Habblaud World is an online city where each Habblaud becomes a building: passersby on the street see, live, how many
projects and agents you are running and what each character is doing. The guiding rule here:

> **With the data that leaves, it is impossible to know who you are or what you work on.**

**Current status:** World is live and comes **enabled by default**, pointing to `server.habblaud.com` (or the
`HABBLAUD_WORLD_URL` you define; see README). **Nothing leaves the computer before you create an account and sign in**;
`HABBLAUD_WORLD=0` disables everything. This page is the complete list of what can leave; any change to it enters the
code and this page in the same pull request.

## What leaves: account and character

When using World, the following leaves the computer via HTTPS to the world server:

| Leaves | When | Why |
| --- | --- | --- |
| Email and password | On registration, sign in, and password reset | Account existence. Password is not saved locally; on server, only an Argon2id hash |
| Player name (nickname) | On registration | Character name (3-20 chars, unique, case/accent-insensitive): reserved while on waitlist |
| 6-digit code | Email confirmation or password reset | Proof of email ownership |
| UI language (`pt-BR`, `en`, `es`, or `fr`) | On registration | So emails arrive in your language |
| Terms of Use acceptance (`v1`) and invite code, if you have one | On registration | Record acceptance; invite code advances account to next waitlist batch |
| Anti-bot challenge solution (ALTCHA) | Registration, email requests, login check | Computed number replacing a captcha |
| Character: appearance (colors/styles), 2-3 traits, bio, and on change, player name (on creation, reserved name is used: not in request) | On saving character | What other players see |
| Visibility preferences (live/discrete, closed, hide country, show tokens, scoreboard, compactions) and inactivity warning | On saving | For the world to honor choices |
| Device token | On each account request | Proof of identity without resending password |
| Device to disconnect | When disconnecting one | Device id assigned by server |
| Pause and resume building | Clicking Pause or Resume (`POST /v1/me/building/pause` and `/resume`, token only) | Turns off building for all immediately, resumes at will |
| Leave world | Confirming "Leave world" (`DELETE /v1/me/building`, token only) | Building removed immediately, frees lot; account/character remain |
| Return to world | Clicking "Return to world" after leaving (`POST /v1/me/building/join`, token only) | Prompts server to accept building again (new building, different lot) |
| Delete account | Deletion request + email code (`POST /v1/me/delete` & `/v1/me/delete/confirm`, token + code) | Deletes account; building/profile disappear; purged in 7-30 days. Local `world.json` deleted |
| Download my data | Clicking "Download my data" (`GET /v1/me/export`, token only; once/day) | Server returns account JSON (including reserved name, country, IPs); nothing new leaves |
| Habblaud version | Every request `User-Agent` header (`Habblaud/1.0.0`) | Compatibility and diagnostics |

While the account is on the waitlist, open Habblaud polls the world server every 30 minutes to check if access has been
granted (`GET /v1/me`, device token only, nothing else). Once granted or signed out, polling stops.

The world server sees the connection IP (like any website). From it, it stores the **country** (which can be hidden)
and, in plain text, **only two addresses**: registration IP and last password login IP, for auditing and fraud
prevention. Only the admin team sees these IPs; they appear in "Download my data" (`signupIp`, `lastLoginIp`, and
`lastLoginAt`) and are deleted with the account. The daily per-IP rate-limiting summary (registration, login, codes)
continues as before. No other IP is stored: neither building connection nor walks through the city.

## What leaves: building (the closed list)

With the account approved and character created, your Habblaud opens a connection (WebSocket over TLS) to the world
server and your building enters the city. Through this connection leaves **only** this:

| Leaves | How | Why |
| --- | --- | --- |
| Initial connection message (`hello`) | Device `token`, Habblaud `version`, `build` (`commit`, `dirty`), UI `locale` (`pt-BR`, `en`, `es`, `fr`) | Auth, official version check, language notices. Token sent only here, never in URL; locale not in payload. Never paths or machine data |
| Building payload | On connect and when office changes: at most once every 5 s; nothing if unchanged | Live building status |
| Heartbeat (`ping`, `pong` when server asks) | Every 30 seconds, no payload | Keeps building lit while Habblaud is open (paused/outside world lights nothing: only keeps World scene connection) |
| World scene open/closed (`view`, `view.off`) | Opening/closing city in browser, no payload | Server streams neighborhood around character only while looking; nothing downloaded when closed |
| Character steps (`move`) | While walking in city (max 5/s): position (`x`, `y` in tiles), direction (`dir`: `n`, `s`, `e`, `w`), walking state (`moving`) | Character on street; world position only, never office data. In background tab: idle step every 30 s |
| Area resync request (`resync`) | Out-of-order changes: city chunk id (`chunk`), or visited building id (`building`) | Ensures Habblaud displays correct buildings |
| Profile request (`profile`) | Clicking someone on street: target `playerId` only | Shows nearby player's card |
| Enter/leave building (`enter`, `leave`) | Pressing E at door (or "View as others see it") and exit: `buildingId` | View building interior (fictional room names, current agent status, no terminal/messages/permissions/actions); steps are local only |
| Light social actions, when clicked (`like`/`unlike`, `greet`, `block`/`unblock`, `report`, `stamp`, `knock`, `teleport`, `summary.seen`) | IDs and list items only: `buildingId`, `playerId`, `greetingId`, `stampId`, `reason` from fixed lists, and building code ("HB-XXXX", as typed) in "Go to". No free text | Like, greet, block, report, leave stamp, knock on door, visit building, acknowledge "While you were away" |

The building payload contains these fields and no others (exact format in
[`shared/world/schema.json`](../../shared/world/schema.json); a test verifies each field against this page):

| Field | What it is | Why |
| --- | --- | --- |
| `v` | Payload format version (`1`) | Compatibility |
| `version` | Habblaud version (`1.0.0`) | Protocol compatibility |
| `theme` | `none`, `halloween`, or `christmas`, resolved: "Auto" uses calendar theme (Halloween in Oct, Christmas Nov 1 – Dec 26) via machine date (Docker UTC) | Building and interior theme |
| `floors` | One floor per room with occupants, in shuffled order | Building height and interior rooms |
| `id` (floor) | Random id per room (`f_` + 10 chars), not from folder path, **rotates every 24 h** (±6 h), and on room change or restart. No timestamps | Visitors today and tomorrow cannot tell if it is the same project |
| `agents` (floor) | One per main agent or subagent working, waiting, idle, or monitoring a shell | Character doing the right thing at the right desk |
| `id` (agent) | Random id (`a_` + 8 chars), with same rotation rules as floor id | Identifies agent in payload |
| `kind` and `parentId` | Main (`main`) or subagent (`sub`), and for subagent, the **world** id of caller agent (omitted if caller left) | Positions subagent near caller |
| `provider` | `claude` or `codex` | Tool appearance |
| `status` | `working`, `waiting`, `idle`, or `shell`. **No** "since when" timestamp | What character is doing |
| `look` | Character visual hint (`f` or `m`) | Body and name matching |
| `name` | Picked from name list based on random world id (never office name, edited or not) | Character name |
| `parts` | Appearance colors and styles (`skin`, `hair`, `hairStyle`, `eyes`, `top`, `topAccent`, `topStyle`, `bottom`, `bottomStyle`, `shoes`, `accessory`, `accessoryColor`, `facialHair`), from random world id + editor customizations | Character appearance |
| `tasksDone` | Tasks completed today by agent, tier only: `0` (none), `1` (1-2), `2` (3-5), `3` (6+). Never title | "+1" floating above head |
| `compacted` | Only if compactions enabled: `true` if agent compacted context since previous payload (`/clear` does not count) | Fills room wastebasket |
| `tokens` | Only if "show tokens" enabled (default on; can disable): `day` (today) and `week` (today + past 6 days), building total (input + output across all agents from "My day", demo mode excluded), rounded to 2 digits (e.g. 1,200,000). Others only see the **tier** (up to 100k, 1M, 10M, 100M, above) | Facade meter |

Nothing else. The payload for an office with 3 projects and 5 agents is ~2 KB. Limits: 64 floors, 64 agents per floor,
256 total, and 64 KB (practically ~170 agents); beyond this, Habblaud truncates excess and logs a warning. The server
validates every field (names in name list, colors in palettes, ids matching format) and rejects the entire payload if
any field outside the list appears.

### Real payload example

```json
{
  "v": 1,
  "version": "1.0.0",
  "theme": "halloween",
  "floors": [
    {
      "id": "f_8c1e5f7a2b",
      "agents": [
        { "id": "a_3f9d2c7e", "kind": "main", "provider": "claude", "status": "working",
          "look": "f", "name": "Marina",
          "parts": { "skin": "#e8b48c", "hair": "#2b1d14", "hairStyle": "bob", "eyes": "#3b5a7a", "top": "#4a6fa5",
                     "topStyle": "hoodie", "bottom": "#2f3542", "bottomStyle": "pants", "shoes": "#ffffff",
                     "accessory": "glasses", "accessoryColor": "#222222", "facialHair": "none" } },
        { "id": "a_71c0b5a9", "kind": "sub", "parentId": "a_3f9d2c7e", "provider": "claude", "status": "working",
          "look": "m", "name": "Caio", "parts": { "...": "..." } }
      ]
    },
    { "id": "f_02aa91c4de",
      "agents": [ { "id": "a_b2e74d10", "kind": "main", "provider": "codex", "status": "idle",
                    "look": "m", "name": "Rafael", "parts": { "...": "..." } } ] }
  ]
}
```

(`"...": "..."` abbreviates parts identical to Marina's. A test checks this example against
[`schema.json`](../../shared/world/schema.json).)

## What never leaves

| Never leaves | Examples |
| --- | --- |
| Project path and name, custom room name | `/Users/voce/projetos/cliente-x`, "Secret project" |
| Session title, branch, permission mode, model | "Fix login", `feat/pagamentos`, `opus` |
| What agents do | Activities, tasks, commands, shells, permission requests, questions, messages, terminal |
| Cost and productivity metrics | Money spent, lines of code, tool calls, tokens per agent (tokens leave only as building total, rounded) |
| Your Claude or Codex account | Email, organization, plan, 5-hour and weekly usage |
| Custom character name | Could be real name: in world, character gets random assigned name |
| Character seed | Appearance in world is derived from random id; only pieces chosen in editor match |
| Timestamps | When session started, status changed, room created: payload contains no time data |
| Machine details | Hostname, system username, timezone. Device shows only as "Device 1/2/3" |
| Your history | My day stats, timelapse timeline, session history |
| Demo mode agents | Excluded before assembling payload |

## Live, without identifying anyone

What visitors see: **visitors to the world see, live, how many projects and agents you are running and what each
character is doing (working, waiting, idle). Nobody sees which projects they are, what agents do, or who you are:
only nickname and chosen avatar.**

- **Nobody is identified:** only nickname (chosen during registration), chosen avatar, and IP country (can be
  hidden). No email, real name, account name, or machine name. Registration and last login IPs stay with admins only,
  never shown in world.
- **No project is identifiable:** floor ids are random and rotate every 24 h (±6 h), with shuffled room order.
- **No office timestamps leave:** payload has no "since when" or duration data. Visits show status, never duration.
- **No building history retained:** server stores only day of last signal and month joined. No building timeline or
  "last seen".
- **No global feed:** each person only receives city chunk around their character; no endpoint lists buildings or
  players.
- **Nothing proves you are at computer:** agents work autonomously. Card states "lit" or "dark" for building, never
  "online" for user.
- **Discrete mode:** only lit/dark status and floor count, no counters or statuses. **Closed to visitors:** nobody
  enters.
- **Visits:** entering your building shows rooms with fictional names and current agent status; in discrete mode,
  empty rooms with lights on; when paused, lights off. You see only "N visitors now", never identities. What you view
  inside others' buildings stays on your screen: nothing about interior or your character position is uploaded.
- **Two-way blocking:** blocked users disappear for you and you disappear for them, including buildings.
- **Light social actions hide identity:** owner sees visit counts, likes, and stamps ("While you were away") and likes
  received today, never sender; door knocks arrive without name, and only if owner enabled "Notify when knocked". City
  aggregates (weekly target, token tier total) only appear with 10+ buildings.

Plainly stated: observing the same building over a long period may reveal patterns (e.g. more agents on weekdays).
Those who prefer can use discrete mode or pause.

## On this computer

- World account is in `~/.habblaud/world.json` (in Docker, `/data` volume), restricted to your user. Device token leaves
  only to world server via HTTPS and in initial connection message; never sent to browser, logs, or URL. Same file
  stores chosen building theme (preserved after logout) and pause/out-of-world state.
- Last building dispatch (exact payload, timestamp, size, and server response) is in
  `~/.habblaud/world-last-uplink.json`, also user-restricted, deleted on sign-out.
- Random world ids exist only in Habblaud memory: restarting Habblaud generates new ids.
- Server messages to owner (today's likes, "While you were away", door knocks, block list) remain in Habblaud memory
  only; snapshot (synced to phone) includes only today's likes, knock count, and unseen summary flag. Stamps left today
  on a building remain in browser (`localStorage`) for button state.
- World section operates only via local computer (`http://localhost`), never phone, and requires Habblaud accessible
  only via local machine. As with office messages, any local process reaching `localhost` can interact with account.
- **Pause** stops building payload transmission before responding and notifies world server: building turns off
  immediately for everyone and lot is reserved. **Resume** restores transmission (retries if server unreachable).
- **Paused: building is dark, but you can walk the city.** With World scene open, connection remains (or opens)
  sending only initial message (`hello`), heartbeat (`ping`/`pong`), and scene commands (`view`, `view.off`, `move`,
  `profile`, `resync`, `enter`, `leave`): no building payload leaves, heartbeat does not illuminate building. Closing
  scene closes connection and stops transmission. Same applies when outside world.
- **Leave world** stops payload transmission and responds after world server removes building and frees lot. Account
  and character remain (can walk city, as when paused); no payload leaves until clicking **Return to world**, which
  requests return and allocates new building on another lot. If account leaves world on another computer, this one also
  remains outside world without sending payloads until **Return to world**.
- **City** (World scene) streams only while open in browser: nearby buildings and people sent by world server stay in
  Habblaud memory and reach page via `localhost`, never disk or logs, and are discarded when closing scene or losing
  connection. Scene opens only from Habblaud's own page, never third-party sites.
- Completed tasks and compactions are tracked in Habblaud memory even when paused or disconnected; only daily tier
  (and "compacted since previous payload") leaves in next dispatch.
- **Sign out** deletes device token locally and disconnects on server. Device list displays active connections (up to 3)
  and disconnects individually.

## How guarantees are maintained

1. **Protocol is public and closed:** [`shared/world/protocol.ts`](../../shared/world/protocol.ts) and
   [`schema.json`](../../shared/world/schema.json) define every field; server rejects any other.
2. **Single file builds building payload:** [`shared/world/projection.ts`](../../shared/world/projection.ts), which
   receives only room ids and never accounts, usage, or stats. Tests verify every payload key against `schema.json`,
   ensuring no office text (paths, room names, titles, activities, commands, tasks, branch, model, account, email,
   edited names) appears and no number resembles a timestamp.
3. **You inspect what was sent:** Habblaud World › Inspect sent payload (city icon in top bar) displays exact JSON of
   last dispatch, timestamp, size, and server response (accepted, or rejection reason). Identical object sent over the
   wire.
4. **Open source:** pull request reviews touching `shared/world/` or `server/world/` verify this list against code
   behavior ([`CONTRIBUTING.md`](../../CONTRIBUTING.md)).
