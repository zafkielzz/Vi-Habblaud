# Habblaud Claude Code Plugins

The repository is also a Claude Code plugin marketplace: `.claude-plugin/marketplace.json` (at the root)
lists the `habblaud` marketplace with three plugins, one in each directory here: the `habblaud` mod (observes only),
`habblaud-permissoes` (answer permissions from the office), and `habblaud-mensagens` (send messages from the
office). `npm run mod:install` installs all three; `--sem-permissoes` and `--sem-mensagens` leave theirs out.
Versions track `package.json` (the `server/test/mod.test.ts` test fails if they diverge).

Tested with **Claude Code 2.1.293** (`habblaud-mensagens`, currently only via `claude plugin test` from
2.1.295). Mods (TypeScript hooks loaded by Claude Code itself) exist from 2.1.287; the API is still
"early access" and may change between versions. In earlier versions, use the usual installers
(`npm run usage:install` and `npm run hooks:install`); sending messages from the office only exists with the mod. The
installation is in the main README.

## `habblaud` — the mod

`habblaud/hooks/register.ts`, a single module, no build. Connects each session to the office without reading the chat:

- **Plan usage (5h and weekly):** at session start and on each `session.measure` (after each turn and when
  a limit advances a full point) reads `$.session.usage().rateLimits` and writes `~/.habblaud/usage/<account>.json` (or
  to `HABBLAUD_USAGE_DIR`) in the same format as the statusline tap, plus `"source": "mod"`. Replaces
  `npm run usage:install`: your statusline remains untouched. The account is the `CLAUDE_CONFIG_DIR` directory (the
  first item) or `~/.claude` (`~` is `HOME`; on Windows without it, `USERPROFILE`). Identical values written less
  than 10 s ago are not rewritten; write failure = silence.
- **"Needs you" below the prompt:** every 5 s polls local Habblaud
  (`GET http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/summary`) for who is waiting, excluding this session and its
  subagents, and displays `🏢 Valentina needs you in loja-virtual` or
  `🏢 2 need you: Valentina (loja-virtual), Elias (app-mobile)` (up to 3 names, then "and N more").
  Nobody waiting or Habblaud offline: the line disappears; when offline, polling backs off to every 30 s until
  it returns. Only in sessions that render (no polling in `claude -p`).
- **`/habblaud`:** office-wide summary, answered by the mod itself (does not call the model, does not consume usage):

  ```
  Habblaud 0.3.0 at http://localhost:4747
  7 agents · 3 working · 2 need you
  ✋ Valentina (loja-virtual): approve a permission · can answer from the office
  ✋ Elias (app-mobile): answer in the terminal
  ```

  Offline: `Habblaud did not respond at http://localhost:4747. To start it: npm run docker:up in the Habblaud folder.`

### What it accesses

Output of `claude plugin validate --strict mod/habblaud` (the static analysis Claude Code performs before
loading the module; nothing outside this list is called):

```
❯ ./register.ts hooks: session.start, prompt.submit, tool.call, session.measure, command.run{command=habblaud}
❯ ./register.ts answers its own command: command.run{command=habblaud}
❯ ./register.ts gating hook with .catch: prompt.submit
❯ ./register.ts gating hook with .catch: tool.call
❯ ./register.ts calls: $.clock.after (via askHabblaud), $.clock.every (via schedule), $.clock.now (via writeUsage), $.command.register, $.env.get (via readEnv), $.fs.write (via writeUsage), $.http.fetch (via askHabblaud), $.process.run (via checkRules, refreshBoss), $.session.id (via poll), $.session.surfaces (via poll), $.session.usage, $.ui.status (via setStatus)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HABBLAUD_RULES_HOOK, HABBLAUD_USAGE_DIR, HOME, USERPROFILE
```

In plain words: writes a single file (usage), communicates only with `127.0.0.1`, reads six environment variables and
does not read messages. It makes decisions only for **office rules**, and only while the session is the boss of an
office: it runs agy-hub's `rules-hook` (`HABBLAUD_RULES_HOOK`, else `~/.local/bin/rules-hook`; ~20 ms) at the session
start and on each prompt (`rules-hook boss`); the rules for the boss go with the first prompt, and again when the user
changes them, as context for the model; each Edit/Write/MultiEdit/NotebookEdit/Read/Grep/Glob/Bash call is checked by
the same script and denied with its reason when it breaks the rules. Without `rules-hook`, on an error or after 3 s,
the call is allowed (both hooks fail open).
`$.clock.after` is the 2 s timeout for each query to Habblaud (`$.http.fetch` does not accept AbortSignal).

## `habblaud-permissoes` — respond to permissions from the office

A standard `PermissionRequest` hook (no mod), in `habblaud-permissoes/hooks/hooks.json`:

```json
{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/permission-hook.mjs\"", "timeout": 86430, "statusMessage": "Aguardando resposta no Habblaud" }] }
```

The script `hooks/permission-hook.mjs` is the same one installed by `npm run hooks:install` (single source; pure Node,
only `node:*`, because Claude Code copies only the plugin folder to the cache). It sends the request to local Habblaud
and waits up to 5 min for an answer; the dialog continues in the terminal and whichever answer comes first wins.
Without Habblaud running or with no page open, it exits immediately. Port: `HABBLAUD_PORT` (default 4747); timeout:
`HABBLAUD_PERMISSION_TIMEOUT` (default 300 s, up to 86400 s = 24 h; the hook timeout in the plugin is 86430 s). To
approve from a phone away from the computer, set `"env": { "HABBLAUD_PERMISSION_TIMEOUT": "86400" }` in the account's
`settings.json`: applies to sessions opened afterward. Background subagents only show the dialog when the hook
finishes, which is why the default remains 5 min. Requires `node` 22+ in the session `PATH`.

`claude plugin validate --strict mod/habblaud-permissoes`: `✔ Validation passed` (the validator also checks the
`hooks.json` schema).

## `habblaud-mensagens` — messages from the office

`habblaud-mensagens/hooks/register.ts`, a single module, no build. Brings into the session what you type in the office
(in the agent panel or T terminal), as if you typed it in the terminal:

- **Fetch:** every 2 s, only in sessions that render (no queries in `claude -p`),
  `POST http://127.0.0.1:<HABBLAUD_PORT or 4747>/api/mod/inbox` with `{session, account}`. The query also marks the
  session as present: this is what displays the agent's message box on the page (without the plugin, the page suggests
  installing it). Offline, or responding with something else (403 when messages are disabled, 404 on a version without
  the route), polling backs off to every 30 s until it returns.
- **Delivery:** each message, in order, is submitted via `$.prompt.submit({ text, asUser: true })`. The model reads the
  text as yours, without "The habblaud-mensagens plugin sent a message" (the session transcript still notes it came from
  the plugin), and text goes through exactly as typed. If the session is mid-turn, Claude Code queues the prompt and
  runs it in its own turn when the current turn ends (a plugin prompt never injects mid-turn, unlike a typed prompt). A
  hook rejecting the message (`{drop}`) or an exception becomes a failure, with the reason, on the page.
- **Model, effort and plan mode:** a message may carry `command` {name, args} instead (set from the agent drawer's
  model/effort selects and "Plan mode" button). Only `model`, `effort` and `plan` are accepted (`COMMANDS` in the
  module); any other name fails and is never submitted as text. `plan` runs via `$.command.run`, as if you typed
  `/plan`. Model and effort do not run `/model` or `/effort`, which Claude Code also saves as the default for new
  sessions: the module keeps them and a `turn.step` hook puts them on each request of the session's main loop, so
  only that session changes (`default` returns to its own; a hot reload forgets them).
- **Acknowledgment:** `POST /api/mod/inbox/ack` with each result (`{session, results: [{id, ok, error?}]}`). Timeout
  per message is at most 2 s: beyond that, the session is busy, the message is queued in it and counts as delivered
  (subsequent messages follow in order). This ensures a round never exceeds a few seconds and server presence (10 s)
  and ack (30 s) timeouts do not expire while the session is busy; the tradeoff is that a rejection after these 2 s
  will not reach the page.

Kept separate from the `habblaud` mod on purpose: that one only observes; this one acts, typing into the session on
your behalf. To omit it: `npm run mod:install -- --sem-mensagens` (an already installed one remains; to remove:
`claude plugin uninstall habblaud-mensagens@habblaud`). `npm run docker:up` updates the plugin for those who already
have it, but does not install it on its own: on an account with the mod and without it, it only suggests running
`npm run mod:install`.

### What it accesses

Output of `claude plugin validate --strict mod/habblaud-mensagens`:

```
❯ ./register.ts hooks: session.start, turn.step
❯ ./register.ts calls: $.clock.after (via waitAtMost), $.clock.every (via schedule), $.command.run (via runCommand), $.env.get (via readEnv), $.http.fetch (via postJson), $.prompt.submit (via submitOne), $.session.id (via round), $.session.surfaces (via round)
❯ ./register.ts env writes: nothing
❯ ./register.ts env reads: CLAUDE_CODE_ENTRYPOINT, CLAUDE_CONFIG_DIR, HABBLAUD_PORT, HOME, USERPROFILE
```

In plain words: two hooks (`session.start`, which starts the round timer, and `turn.step`, which applies the model
and effort chosen in the office to this session's own requests); the only session actions are `$.prompt.submit` for
messages and `$.command.run` for `/plan` (nothing else); does not read the conversation, writes no files, talks only to `127.0.0.1`, and reads
four environment variables (account comes from `CLAUDE_CONFIG_DIR`, as in the mod). `$.clock.after` is the 2 s timeout
for each request to Habblaud and each `$.prompt.submit`.

Port: `HABBLAUD_PORT` (default 4747). Requires Claude Code 2.1.287+ and a Habblaud with messages enabled: same guard
as terminal and permissions (port bound to `127.0.0.1` and local Host header) and `HABBLAUD_MENSAGENS` not disabled
(`0`, `false`, `off`, or `no` disable it). Any process on this machine that can talk to Habblaud can send messages to
sessions with the plugin: hence the local guard.

## Development

```bash
claude --plugin-dir mod/habblaud                     # load mod in a session without installing (reloads on save)
claude -p "/habblaud" --plugin-dir mod/habblaud      # test command without interactive session (does not call model)
cd mod/habblaud && claude plugin test                # mod tests (tests/*.test.ts), no session, login, or network
cd mod/habblaud-mensagens && claude plugin test      # same for messaging plugin
claude plugin validate --strict mod/habblaud         # static analysis + manifest (same for other folders and .)
npx tsc -p mod/habblaud                              # types (after loading mod once with --plugin-dir)
```

When loading a mod, Claude Code writes types for the installed version into `<folder>/.claude-plugin/types/` and a
`<folder>/tsconfig.json` that extends them; both are generated and excluded from git (`mod/.gitignore`). Mod tests
import `claude-code/testing` and run only via `claude plugin test`: `npm test` (vitest) and `npm run typecheck`
do not inspect this folder.
