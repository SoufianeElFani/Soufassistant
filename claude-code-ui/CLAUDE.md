# Claude Code UI — Home Assistant App

A browser-based Claude Code interface running as an HA app. Provides a chat UI backed by the Claude Agent SDK with direct access to Home Assistant config and state.

## Architecture

```
browser  ←→  WebSocket  ←→  server/lib/  ←→  @anthropic-ai/claude-agent-sdk
                                  ↓
                          ha-tools (this app's one CLI: states, services, registries,
                            history, automation & script traces, running work,
                            dashboards, logs)
                          plugins/homeassistant-config/
```

- **`server/index.js`** — the composition root; wires `server/lib/` together and listens
- **`server/lib/`** — one module per concern (see **Server layout** below)
- **`frontend/app.js`** — the browser composition root; `frontend/js/` holds the modules (see **Frontend layout**)
- **`run.sh`** — App entrypoint; initialises `/data` environment, runs context generation, starts Node
- **`plugins/homeassistant-config/`** — Local plugin with SKILL.md and pre-save YAML validation hook
- **`plugins/productivity-tools/`** — Local plugin (SKILL.md only) covering `claude-tasks`, the `/data/workspace` convention, and scheduled tasks — see **Task List, Workspace, and Scheduled Tasks** below
- **`scripts/`** — `ha-context.sh` (writes the generated HA context to `~/.claude/ha-context.md`), `browser-capture.sh` (auth flow URL capture), `claude-tasks.cjs`/`.sh` (the task-list CLI), and the `ha-tools` helper suite:
  - `ha-tools.sh` — dispatcher; the single entry point (see below)
  - `ha-tools.cjs` — the dispatcher: one command table loaded from `commands/`, one generated `--help`
  - `commands/*.cjs` — every command: `basic` (states, services, templates), `registry`, `history` (history / stats / timeline / logbook …), `monitor`, `automation` (automation, config-check, reload), `lovelace`, and `traces` (automation **and script** traces, `running`, `trace-stuck`, `trace-watch`); see **ha-tools** below
  - `lib/ha-ws.cjs` — shared connect/auth/request client (and subscriptions)
  - `lib/ha-args.cjs`, `lib/ha-output.cjs`, `lib/ha-command.cjs` — argument parsing, the three output shapes, and the `--help`/usage/clock wrapper every `commands/*.cjs` command gets
  - `lib/ha-trace.cjs` — pure trace helpers (config-at-path, open steps, breadcrumbs), unit-tested
  - `lib/ha-time.cjs` — one clock for all output (see "Time" below)
  - `lib/ha-rest.cjs` — the few Supervisor REST endpoints with no WebSocket equivalent
  - `lib/ha-log-scan.cjs` — pure helpers for reading the errors HA logs about itself during an operation
  - `ha-logs.sh` — Supervisor journald log reader, reached as `ha-tools logs` (the one command that is not Node)

### Server layout

`server/index.js` is a composition root and nothing else: it wires the modules,
loads the persisted state, and listens. Everything with behaviour lives in
`server/lib/`, one module per concern.

| Module | Owns |
|---|---|
| `config.js` | every environment variable and derived path |
| `state.js` | the mutable values that span the process (`runtime`) |
| `broadcast.js` | connected sockets, `send()` / `broadcast()` |
| `auth.js` | credentials, auth-error detection, the device-login flow |
| `sessions.js` | Claude Code's on-disk transcript store, and reading it |
| `dialogs.js` | AskUserQuestion interception and pending questions |
| `permissions.js` | the `/addon_configs` guard and `canUseTool` |
| `auto-continue.js` | scheduling and firing a resume after a usage limit |
| `run-query.js` | one turn: SDK options in, wire events out |
| `ws-protocol.js` | the greeting, and a dispatch table of client messages |
| `diag.js` | the `/diag` routes (registered only when `debug` is on) |
| `ha-auth.js` | the HA admin-token guard those routes sit behind |
| `uploads.js`, `ha-links.js`, `mcp.js`, `exec.js`, `log.js` | attachments, entity link targets, MCP hygiene, shelling out, logging |
| `tasks.js` | the task-list widget's state, fed by the `claude-tasks` CLI via `/internal/tasks` |
| `workspace.js` | the configurable workspace root, projects, listing and sync status |
| `modes.js` | Chat / Code / Cowork: per-mode SDK options, the Cowork write fence, per-session modes |
| `skills.js`, `zip.js` | the Skills panel: discovery, on/off, local CRUD, .zip export |
| `session-tools.js` | conversation titles/pins, search, export, duplicate, per-turn changes and rewind |
| `previews.js` | the /preview/<port>/ proxy for apps running in a Cowork project |
| `runs.js` | several conversations running at once: the run per conversation key (session id, or a draft key until `init`), the shared view, `emit()` to the tabs showing a run |
| `doc-preview.js` | PDF / Office files as page images for the viewer (LibreOffice → PDF → `pdftoppm`), cached under `/data/cache/previews` |
| `plan-usage.js` | claude.ai plan limits for the Usage panel |
| `scheduler.js` | persisted cron-like prompts, ticked and fired as their own unattended SDK calls |
| `cron.js` | the pure 5-field cron matcher `scheduler.js` is built on |
| `team.js` | the Team panel's state, fed by both the UI and the `team-notes` CLI via `/internal/team` |
| `internal.js` | the loopback guard in front of `/internal/*` routes |

Rules that keep it readable: **no top-level side effects** beyond pure
constants (the composition root does the starting); anything genuinely shared
and mutable goes on `runtime` in `state.js` rather than becoming another
file-scope `let`; and the module graph is **one-way** — `run-query` imports
`auto-continue`, and the resume runner is injected back at startup rather than
closing the cycle.

**Adding a `COPY` to the Dockerfile:** `server/lib/` is copied as a directory.
A new top-level file under `server/` needs its own `COPY` line, and
`ARG SCRIPTS_VER` must be bumped or Docker will serve the cached layer.

### Frontend layout

`frontend/app.js` is likewise a composition root; the modules are in
`frontend/js/`, loaded with `<script type="module">`. **There is no build step
and there should not be one** — the files are served straight from the
container and loaded through the ingress, and relative module specifiers
resolve correctly there.

`marked.min.js` stays a classic `<script>` before the module (it sets a
global; classic scripts run before deferred modules).

The one thing to know before editing: an ES module's exported binding is
**read-only in the importing module**, so a value more than one module writes
cannot be an exported `let`. Those live on the `S` object in `js/state.js`.
Anything only one module touches stays a plain `let` in that module — do not
add to `S` reflexively.

## Deploying to a Home Assistant box

```bash
tools/deploy-to-ha.sh              # copy + rebuild
tools/deploy-to-ha.sh --prune      # ...and list files on the box that no longer exist locally
tools/deploy-to-ha.sh --live       # ...and run the live smoke suite afterwards
tools/deploy-to-ha.sh --no-rebuild # copy only
```

It lives outside `claude-code-ui/` on purpose — CI triggers on
`claude-code-ui/**`, and editing a deploy script should not queue an image
build. The manual sequence is still documented under **Deploy Workflow** below;
the script exists because that sequence has traps in it (chiefly: copying the
repo restores the `image:` key, which then has to be stripped again or the
rebuild fails with `AppRebuildImageBasedError`).

**A rebuild restarts the app**, so any in-progress chat drops.

## Testing

```bash
cd claude-code-ui
npm install                # dev-only; server/package.json is the runtime manifest
npm test                   # unit + server integration + CLI
npm run test:browser       # the real UI in headless Chrome (needs Chrome; CHROME_PATH to point it)
npm run test:live          # smoke test against the deployed app on the real HA box
npm run test:live -- --with-agent    # ...plus one real agent turn (spends tokens)
npm run test:live -- --mutating      # ...plus a write to the live conversation
```

`test/` is **not** copied into the image, and its dependencies live in
`claude-code-ui/package.json` rather than `server/package.json` — adding a test
dependency must never bust the Dockerfile's `npm install` layer. A unit test
asserts the two manifests agree on anything they share.

| Layer | What it does |
|---|---|
| `test/unit/` | pure functions — transcript parsing, the clock, permission labels |
| `test/integration/` | boots the real `server/index.js` in a child process and drives the real WebSocket protocol. The Agent SDK is replaced by a **scripted stub** via a module-resolution hook (`--import test/helpers/sdk-loader.mjs`), so production code is untouched and no 240 MB SDK is needed |
| `test/cli/` | runs the real `ha-tools` (incl. `logs`) / `ha-context` against a fake Home Assistant (WebSocket + Supervisor REST) |
| `test/browser/` | drives the actual UI in headless Chrome, and asserts a clean console — in a no-build-step app there is nothing else to catch a typo'd identifier. `ui.test.mjs` is the main flow plus the two phone-layout suites (the app alone, and the app inside a stand-in for HA's panel page — request-interception serves that shell same-origin, and it is deliberately 100px taller than the screen, which is the geometry that broke), `modules.test.mjs` proves every module loads and runs, `interactions.test.mjs` goes deeper into the paths no wire assertion can stand in for (setting a question aside, paging a dialog, opening a folded run, find navigation, scroll anchoring) |
| `test/parity/` | `npm run test:parity` — the old `ha-ws-client` binary this app once shipped (pinned by sha256) and the built-in one, run against the same fake HA inside an unprivileged user+network namespace (the old binary hard-codes `ws://supervisor`), `--json` compared command by command. Not part of `npm test`: it downloads a binary |
| `test/live/` | the part only the real thing can answer: does the Supervisor token authenticate, do the tools reach a live instance, is the log endpoint still there. Read-only by default |

The integration tests are **characterisation tests**: they were written against
the behaviour as it was, and they are what makes a restructure safe. When one
fails after a change, the question is whether the behaviour was meant to change
— not whether to update the assertion.

The live suite needs the **`debug` app option on**; without it the `/diag`
routes are not registered and every probe returns the SPA. It also needs an **HA
admin token** for the `/diag` checks (`HA_API_TOKEN`, or `HOME_ASSISTANT_TOKEN_NICK`
as privd delivers it — `prsecret Home-assistant-token-nick -- npm run test:live`);
without one those checks are *skipped*, not failed. It reaches the
container through SSH (the app's IP is on Docker's internal network) — override
with `HA_SSH_HOST` / `HA_SSH_PORT` / `HA_SSH_USER` / `HA_SSH_KEY`, or pass
`--local` when running inside the container.

### Agent memory (CLAUDE.md)

`ha-context.sh` writes the live Home Assistant context to `~/.claude/ha-context.md` (i.e. `/data/home/.claude/ha-context.md`), regenerated on every start. `run.sh` seeds `~/.claude/CLAUDE.md` **once** with a `@ha-context.md` import line and never overwrites it, so the user's own instructions are user-editable and persist across restarts/updates (everything under `/data` is persistent). Claude Code resolves the `@ha-context.md` import relative to CLAUDE.md's directory.

## Deploy Workflow

SSH key: `~/.ssh/ha_claude`. Host: `192.168.1.10:222`. **User: `hassio`**, not `root` —
this HA install uses the community "Advanced SSH & Web Terminal" app (the
official "Terminal & SSH" app has no protection-mode toggle). `hassio` has
genuine passwordless root via `wheel` (`sudo -n whoami` → `root`), so anything
needing root goes through `sudo`, not a different login.

```bash
# Copy to app directory on HA host. -O forces the legacy SCP protocol — this
# app has no SFTP subsystem, so a modern scp fails with "Connection closed"
# without it. /addons/ itself is root-owned (mkdir there needs sudo), but the
# existing claude-code-ui/ dir is hassio-owned, so copy INTO it, not onto
# /addons/ directly.
scp -O -P 222 -r claude-code-ui/* hassio@192.168.1.10:/addons/claude-code-ui/

# scp MERGES, it doesn't mirror — files removed locally since the last deploy
# stay on the host unless deleted explicitly. Diff scripts/ against the repo
# after a deploy, or track deletions by hand as below.
ssh -p 222 hassio@192.168.1.10 "rm -f /addons/claude-code-ui/scripts/<removed-file>"

# If scp reports "Permission denied" on individual files: a previous rebuild
# (which runs as root) left some files root-owned inside the hassio-owned
# directory. Fix ownership, then retry the copy:
ssh -p 222 hassio@192.168.1.10 "sudo chown -R hassio:hassio /addons/claude-code-ui"

# IMPORTANT: strip the `image:` key from the REMOTE copy so the Supervisor
# builds from the Dockerfile. config.yaml ships `image:` for STORE installs
# (prebuilt image), but with it present `need_build` is false (ATTR_IMAGE not
# in data) and `ha apps rebuild` errors (AppRebuildImageBasedError) / `update`
# pulls the published image instead of your local changes.
ssh -p 222 hassio@192.168.1.10 "sed -i '/^image:/d' /addons/claude-code-ui/config.yaml"

# `ha` CLI calls need a LOGIN shell. Non-interactive `ssh host "ha ..."` doesn't
# source the profile script that exports SUPERVISOR_TOKEN, so a bare `ha`
# command fails `unauthorized: missing or invalid API token` even with
# protection mode off and everything else correct. Wrap every `ha` call:
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps rebuild local_claude-code-ui'"   # same version
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps update local_claude-code-ui'"    # after a version bump
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps info local_claude-code-ui'"      # state / version
ssh -p 222 hassio@192.168.1.10 "bash -lc 'ha apps logs local_claude-code-ui'"      # startup / runtime logs

# To shell into the running container: `ha apps exec` is not a real subcommand
# (it silently falls through to something else). Use docker directly — the
# container is named app_<slug>, not addon_<slug>:
ssh -p 222 hassio@192.168.1.10 "sudo docker exec app_local_claude-code-ui ha-tools --help"
```

To bust Docker layer cache for shell script changes, bump `ARG SCRIPTS_VER` in the Dockerfile.

Rebuilding restarts the app — any in-progress Claude Code UI session on HA drops.

## Releasing

**Do not bump `version:` on every commit.** Home Assistant reads that value
straight off `master` to decide whether an update is available, so bumping it
tells every installed user there's a new release — and if CI hasn't published a
matching image tag yet, their update *fails*. The version and the published
image must stay in lockstep.

The rule is therefore: **`version:` in `config.yaml` names the latest released
image; a bump *is* the release.** Ordinary commits leave it alone. CI enforces
this — it runs on every push touching `claude-code-ui/**`, but the `version` job
checks GHCR and skips the build entirely when that version is already published,
so a published tag is never silently overwritten.

Day to day, land changes with the version untouched and add them under
`## Unreleased` at the top of `CHANGELOG.md`. To cut a release:

1. Rename the `## Unreleased` heading to the new version number
2. Bump `version:` in `config.yaml` to match
3. Commit and push **to the `next` branch** (`git push origin HEAD:next`), never
   straight to `master`. CI tests and builds there; the `promote` job then
   fast-forwards `master` to that commit **only once the images exist**, so
   Home Assistant (which polls `master` on its own schedule) never offers a
   version it cannot pull. Pushing a bump straight to master is what made the
   0.3.0 update fail with "manifest unknown" for a few minutes. Non-release
   commits go through `next` the same way (promoted once the tests pass).

`workflow_dispatch` takes a `force` input to rebuild and overwrite an
already-published version; use it only to repair a broken publish.

**Agent SDK updates** arrive as Dependabot PRs (`.github/dependabot.yml`:
weekly, SDK only, held back until a release is 3 days old). A PR runs the tests
plus an **image smoke test** — builds the amd64 image, runs `claude --version`,
imports `query` — and never publishes. Merging one is not a release: add a line
under `## Unreleased` and ship it with the next version bump.

## Prebuilt images (CI)

`.github/workflows/build.yml` builds a multi-arch image with the Home Assistant
`builder` composite actions (`prepare-multi-arch-matrix` → `build-image` →
`publish-multi-arch-manifest`, pinned to `2026.06.0`) and pushes it to
`ghcr.io/xionic/claude-code-ui:<version>` + `:latest` — but only when that
version isn't already published (see **Releasing** above). The new builder does **not** read
`build.yaml`, so the workflow passes `BUILD_FROM` per arch. Store installs pull
this image (via the `image:` key in config.yaml); local dev builds from source
after the `sed` strip above. **One-time GHCR setup:** after the first successful
run, set the `claude-code-ui` package visibility to **public** so users can pull
anonymously.

## Environment

- **Platform**: Raspberry Pi 4 (aarch64), Home Assistant OS
- **`SUPERVISOR_TOKEN`**: Injected automatically by HA Supervisor; authenticates REST calls via `http://supervisor/core/api/`
- **`ANTHROPIC_CONFIG_DIR`**: `/data/.config/claude` — persists Claude auth credentials across restarts
- **`WORK_DIR`**: `/config` (HA config directory, mounted read-write)

### Folder maps

`config.yaml` uses the current Supervisor map types with **explicit `path` pins**:
`homeassistant_config` → `/config` (its default is `/homeassistant`) and
`all_app_configs` → `/addon_configs` (its default is `/app_configs`). The pins are
deliberate — `WORK_DIR`, the persisted Claude session keys (`~/.claude.json` is
keyed on the project dir `/config`), the `/addon_configs` guard in
`server/index.js`, and the ESPHome fallback in `run.sh` are all written against
these paths, so taking the new defaults would be a breaking change, not a rename.
The legacy names (`config`, `all_addon_configs`) still work but log deprecation
advisories; `all_app_configs` requires **Supervisor 2026.07+**.

## Authentication

Claude authenticates via device flow (`claude auth login`) or `ANTHROPIC_API_KEY` in app config. Credentials persist in `/data/.config/claude/.credentials.json`. The server checks this on connect and shows a login screen if unauthenticated.

## HA Tool Access

Patterns for interacting with HA at runtime:

| Tool | Use case | Auth |
|------|----------|------|
| **ha-tools state / states-filter / entities / template / call …** | Entity states, registry search, Jinja templates, service calls (`call` changes HA) | `$SUPERVISOR_TOKEN` auto |
| **ha-tools running / trace-stuck / trace-timeline / trace-summary / traces** | Automation **and script** traces (`--domain script\|automation`, or `script.x`), what is executing right now and for how long, and which step an unfinished run is waiting on. `trace` / `trace-latest` print the whole raw trace | `$SUPERVISOR_TOKEN` auto |
| **ha-tools history** / **stats** | State history / long-term statistics over a window (a trailing hours number, `--hours`, `--days`, or `--from`/`--to`) — wraps `history/history_during_period` + `recorder/statistics_during_period` | `$SUPERVISOR_TOKEN` auto |
| **ha-tools timeline** | Several entities' state changes merged onto one clock (`--between HH:MM-HH:MM`) — the core automation-debugging move | `$SUPERVISOR_TOKEN` auto |
| **ha-tools automation** | `list` / `show` (config HA has loaded) / `yaml` (its block in `automations.yaml`, numbered) | `$SUPERVISOR_TOKEN` auto |
| **ha-tools config-check** / **reload** | Validate config then reload a domain — REST-only, previously hand-rolled curl. Both read the Core log across the call to catch per-entity errors HA only logs (`--no-log-scan` opts out); `reload --expect <entity_id>` asserts the entity materialised | `$SUPERVISOR_TOKEN` auto |
| **ha-tools trace-watch** | Block until an automation actually fires, then report the trace (incl. condition-blocked runs). Waits 100s by default | `$SUPERVISOR_TOKEN` auto |
| **ha-tools lovelace** | Lovelace dashboards (list / get / save / create / delete) over WebSocket | `$SUPERVISOR_TOKEN` auto |
| **ha-tools logs** | Core / host / Supervisor / per-app logs via the Supervisor journald endpoints | `$SUPERVISOR_TOKEN` auto |
| **REST curl** | States, services (`/api/...`) | `Authorization: Bearer $SUPERVISOR_TOKEN` |
| **Direct YAML edit** | YAML-mode dashboards & all config files in `/config` | file is on disk, no auth |

**Safety:** the agent is instructed (via `ha-context.sh` CLAUDE.md + the plugin SKILL.md) to never edit `/config/.storage/*` or the recorder DB without asking the user first — they need a restart, bypass validation, and corrupt easily.

### ha-tools

`ha-tools` is this app's one CLI — a single name, on purpose. The consumer is an
agent: two spellings of a tool are a choice it has to make for no benefit, and every
alias is another line in the context it carries. (The third-party `ha-ws-client`
binary and the `ha-history` / `ha-stats` / `ha-timeline` / `ha-lovelace` / `ha-logs`
shortcuts were removed outright, along with the duplicate commands `trace-debug`,
`history-full`, `states-json` and `watch` — a clean break, no compatibility shims.)
`ha-tools --help` maps every HA command available in the container. `ha-tools.sh`
execs Node for everything except `logs`, which is a bash script.

The WebSocket subcommands share `scripts/lib/ha-ws.cjs`, which owns the connect →
`auth_required` → `auth_ok` handshake and turns each command into a promise keyed
on the message id. Add a new helper by adding a definition to `commands/*.cjs`
(see below) — not a function in `ha-tools.cjs`, and not another top-level script.

#### One tool, one contract (`commands/*.cjs`)

`ha-tools.cjs` is only a dispatcher: it loads every module in `commands/` into one
table and generates `--help` from it. Each command is a plain definition —
`{ name, usage, summary, flags, min, examples, run }` — and `lib/ha-command.cjs`
supplies argument parsing, `--help` (stdout, exit 0, with examples), usage errors
(stderr, exit 2), the HA-timezone clock and the output shapes. A new command is its
definition and its `run()`; `ha-tools.sh` has no command list to forget. Definition
options beyond the above: `formats: ['tsv']` (extra `--format` values), `ws: false`
(REST-only commands — `config-check` and `reload` — must not need a WebSocket to
work), `validate(parsed)`, `mutates: true` (marks the command `[changes HA]` in the
help — an agent under a permission mode should be able to tell a read from a write),
and `listing` / `range` / `showAge`, which opt in to `--max-items`, `--from`/`--to` and
`--show-age`.

- **Shared flags work in any position**, including before the command
  (`ha-tools --json state x`): `--json`, `--compact`, `--format`, `--no-headers`,
  `--utc`. **A command accepts a flag only if it acts on it**: `--max-items`,
  `--from`/`--to` and `--show-age` are opt-in per command, and an undeclared flag is a
  usage error — an ignored flag is an agent believing it filtered when it didn't.
  (`--no-timestamps` was accepted by everything and honoured by nothing; it is gone.)
  `--compact` is lossless: a list is one line per item, a document is its complete JSON
  on one line — never a prefix of it.
- **`--json` is one envelope everywhere**, on one line:
  `{"success":…,"command":…,"data":…,"count"?:…,"timezone"?:…}`. A list command's
  `data` is the array and `count` its length; `timezone` is present whenever the
  command formatted times, so the zone travels with them. **`success` always agrees
  with the exit code**: a failure prints `{"success":false,"command":…,"error":…}`
  (an invalid `config-check` or a `reload --expect` that missed keeps its `data`
  too), on top of the stderr message and the non-zero exit. The default output of a
  *document* command (`lovelace get`, `automation show`, `config-check`, `reload`,
  `state`, the traces) is the bare pretty JSON, so `lovelace get x > f` followed by
  `lovelace save f` round-trips — and `save` accepts a `--json` envelope too.
- **Windows are spelled one way across `history`, `stats`, `timeline`, `logbook`,
  `attrs`:** a trailing hours number (`history x 6`), `--hours N`, `--days N` (may be
  a fraction), or `--from`/`--to`. Two of the first three is a usage error, not a
  quiet pick. With no `--to` no `end_time` is sent: HA reads that as "up to now".
  (They used to mean two different things — a date range under `ha-tools`, "last N hours"
  under `ha-ws-client` — which is why they were merged.)
- **Where the Go tool re-serialised HA's data through a struct** (dropping most
  fields), `data` is HA's raw value — a superset, which `npm run test:parity` checks.
- **`fire-event` is new** — SKILL.md documented it but the Go tool never had it.
- **`ha-history` / `ha-stats` used to print HA's raw object by default**; now `--json` is
  the envelope (the raw points are its `data`) and the default is text.
- **`trace-watch` waits 100s by default**, not 15 minutes: a foreground command is cut off at
  about two minutes, so a longer default meant the agent never saw a result. For a longer wait
  it passes `--timeout` and runs the command in the background.

#### Traces, scripts and running work (`commands/traces.cjs`)

HA's trace API is domain-generic (`trace/list` / `trace/get` take `domain:
"automation" | "script"`); the Go tool hard-coded `automation`. Every trace command now
takes `--domain script|automation` **or** reads it from `script.x` / `automation.x`
(a conflict is exit 2; a bare name tries automation first and falls back to script,
saying so on stderr).

- **item_id.** An automation's trace key is its `attributes.id`. A script's was verified
  live to be its **object id** (`nick_blind_creep_open`); the resolver still checks the
  trace list and falls back to the registry `unique_id`, rather than assuming.
- **Newest run = newest `timestamp.start`, never "the first listed".** HA lists traces
  **oldest first** (verified live), so the Go tool's `traces[0]` "latest" was actually
  the *oldest* stored run for `trace-latest` / `trace-summary` / `automation-config`.
- **Script steps are `sequence/…`, not `action/…`.** The Go tool's `trace-actions` kept
  only `action/` paths, so it was empty for scripts; it is now every step except
  top-level trigger/condition. Nested paths (`sequence/1/parallel/0/sequence/2`,
  `…/choose/0/sequence/0`, `…/default/0`, `…/if/condition/0`, `…/then/0`,
  `…/repeat/sequence/0`) resolve back into the config via `lib/ha-trace.cjs`'s
  `configAt()`. HA writes the word `condition` under `if` where the config has the
  list directly — a real-instance finding the fixtures didn't have.
- **Timeline and vars are chronological.** The Go tool iterated a map, so order was random.
- **`running`** lists scripts that are `on` and automations with `current > 0` (an
  automation's `on` only means *enabled*), joined to the running traces (`state:
  running`) for how long. If no running trace is stored the duration is `null`/`?` —
  never guessed from `last_triggered`. The **effect** column states what the mode does
  to the next trigger (`single` → dropped, `queued` → queues or drops when full, …);
  it never says "stuck", per the design rules below.
- **`trace-stuck`** finds open steps: one a trace records as mid-wait (`delay` with
  `done: false`, `wait` with `completed: false`), or the trace's own `last_step` with no
  result yet. The first kind is *explicit*; the second is flagged `[inferred from
  last_step]`. A parallel script can wait in several branches — all are listed, deepest
  first. A step with a `child_id` (a script call) is followed into the child's run, to a
  depth of 5. A `wait_template` is rendered once, now, without the run's variables
  (and says so); `--no-render` skips that.

#### Design rules (the consumer is an agent, not a person)

These came out of a real debugging session's feedback and are worth holding to,
because the failure modes are asymmetric: a human discards a bad diagnostic, an
agent believes it and spends three tool calls acting on it.

- **Never state an inferred cause as fact.** Say what failed
  (`websocket automation/config failed (…)`), not what you guess caused it. The
  the old upstream `ha-ws-client automation-config` announced "blueprint automation with
  no stored traces" from a branch that can only run when the automation is *not*
  a blueprint, and while traces exist — that message cost an agent several calls.
- **Empty is `[]`, broken is a non-zero exit.** `success: true` with a `null`
  payload is indistinguishable from a failed query, so an agent abandons the tool.
  `timeline` goes further and names entities that returned nothing at all, since
  "no events" and "you typo'd the entity_id" otherwise look identical.
- **Output shape is an API.** Flat rows with a header, or JSON with a documented
  top level. If the shape is unknown-nested, the caller writes a recursive walker
  to find the payload — a whole tool call spent on plumbing.
- **Do the plumbing here.** Merging several entities' histories onto one clock is
  the common debugging move, so it's `timeline`, not a script the agent rewrites
  each session.

#### Time

`lib/ha-time.cjs` is the only place that formats a timestamp. Everything prints
Home Assistant's configured timezone (fetched per-run via `get_config`) with an
explicit offset — `2026-08-12 23:27:42+01:00` — and `--utc` opts out.

The container clock is **UTC and never inherits HA's timezone**, so `new Date()`
formatting would silently shift every reported time by the user's offset. HA also
hands out three formats depending on the API — epoch floats (history), UTC ISO
(state attributes), local (`now()` in templates) — and an agent doing arithmetic
across two of them gets it wrong quietly. `toMillis()` normalises all three.

`ha-ws-client` was a third-party MIT Go binary
([schoolboyqueue/home-assistant-blueprints](https://github.com/schoolboyqueue/home-assistant-blueprints)
v1.8.1, downloaded per-arch in the Dockerfile) and was deliberately left alone while it
was good enough. **It was absorbed on 2026-10-18**: it hard-coded the `automation` trace
domain, reported the *oldest* run as the latest, panicked now and then ("concurrent write
to websocket connection" in `stats-multi`), and could not be extended without owning Go
and cross-compilation. Its name is not kept as an alias (one name for the agent);
`scripts/commands/NOTICE` carries its MIT licence.
**`npm run test:parity` is the regression net**: it runs the pinned old binary and the
built-in implementation against the same fake Home Assistant and compares their `--json`
for every command, with each *intended* difference written down in the test (anything
else is a regression). Run it before changing a ported command.

Everything here connects to
`ws://supervisor/core/api/websocket` with `$SUPERVISOR_TOKEN`. Lovelace is
WebSocket-only (the REST `/api/lovelace/*` endpoints 404). Full command reference
is in `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md`.

### Logs — journald only (HA 2025.11+)

**`/config/home-assistant.log` no longer exists** on HAOS/Supervised, and the Core
REST endpoint **`/api/error_log` was removed with it** — it returns 404 while
remaining listed in the HA developer docs, so it looks available and isn't.
Verified against Core 2026.8.1: `/api/config` and `/api/states` answer 401
unauthenticated (route present) while `/api/error_log` answers 404, same as a
nonexistent route.

Logs now come from the Supervisor's journald endpoints, which need `hassio_api`
(config.yaml grants it): `core/logs`, `host/logs`, `supervisor/logs`,
`addons/self/logs`, `host/logs/identifiers[/<id>]`, `host/logs/boots`. They take
`?lines=N`, `?boot=N`, `?verbose`, `?follow`, return **plain text**, not JSON,
and **colour it with ANSI escapes** — strip with `sed 's/\x1b\[[0-9;]*m//g'` or
the codes land in whatever you generate. `scripts/ha-logs.sh` (exposed as
`ha-tools logs`) wraps all of this; `section_recent_errors()` in `ha-context.sh` uses
`core/logs` for the startup context.

**Validate on the HTTP status, never on the body.** This endpoint's removal went
unnoticed for months precisely because `section_recent_errors()` only checked for
*empty* output: the body `404: Not Found` is short, non-empty, plausible text, so
it was pasted into Claude's context as though it were the error log. Content
sniffing can't fix that either — only Core/host/Supervisor logs are
timestamp-first; an app's log is raw container stdout with no guaranteed shape.

### Diagnostics

`GET /diag` runs a read-only auth/connectivity probe from inside the container: reports `$SUPERVISOR_TOKEN` presence, then exercises `ha-tools`, REST, and `ha-tools lovelace` with the live token. Use it to confirm what authenticates without theorising.

All diagnostic routes are **only registered when the `debug` app option is `true`** (default `false`); otherwise they're absent and requests fall through to the SPA. Enable via the app **Configuration** tab, or the Supervisor API (`POST /addons/local_claude-code-ui/options` with the full options object incl. `"debug": true`, then restart). The Supervisor token is available as `$SUPERVISOR_TOKEN` inside the SSH & Web Terminal app.

#### They need a Home Assistant admin token (`server/lib/ha-auth.js`)

Every `/diag` route requires `Authorization: Bearer <token>`, where the token is a
Home Assistant **long-lived access token** belonging to an **admin** user. Missing
or rejected → 401, valid but not an admin → 403, Home Assistant unreachable → 503:
it **fails closed**, because an unvalidatable token must never be treated as valid.

These endpoints were unauthenticated until 1.14.0, which mattered more than
"diagnostics" suggests: `/diag/query` and `/diag/feed` run a real turn with every
tool auto-approved (code execution, `/config` write access), `/diag/conv?clear=1`
clears the conversation, and `/diag/grep` / `/diag/sesslist` hand back transcripts.
Nothing on the LAN could reach them — the port is unpublished and the container
sits on the `hassio` bridge alone — but every other app, Core and the Supervisor
could. The guard is mounted on the group (`app.use('/diag', requireHaAdmin)`), so a
route added later is covered without anyone remembering to.

**Validated against Core directly (`homeassistant:8123`), never the Supervisor
proxy.** Measured: `http://supervisor/core/api/` answers **200** to this app's own
`SUPERVISOR_TOKEN`, so validating there would accept the add-on's own credentials —
and every other app's — as a user key; Core answers **401** to that token and 200
only to real Core tokens. One WebSocket round-trip does both jobs: the `auth`
handshake proves the token is genuine, then `auth/current_user` reports `is_admin`
(there is no REST endpoint for the second part). Verdicts are cached ~5 min keyed on
a SHA-256 of the token, never the token itself; `unreachable` is never cached.

The live suite reads the token from `HA_API_TOKEN` or `HOME_ASSISTANT_TOKEN_NICK`
(what privd delivers), and **skips** the /diag checks when neither is set:
`prsecret Home-assistant-token-nick -- npm run test:live`.

Endpoints:
- `GET /diag` — env + auth probes (`ha-tools`, REST, `ha-tools lovelace`) and the persisted-MCP extract from `~/.claude.json`.
- `GET /diag/config` — dumps the Claude config files the SDK may load settings/MCP from.
- `GET /diag/query?q=...` — runs a **real headless agent query** with tools auto-approved and returns the streamed events (init `mcp_servers`/`tools`, every `tool_use`/`tool_result`, text, result). This is the fastest way to emulate a user prompt and see which tools load and what errors come back.
- `GET /diag/conv` — inspect the persisted conversation (transcript length, resume id, file status). `?clear=1` clears it.
- `GET /diag/feed?q=...` — drive one real turn through the persistence path (records + saves + resumes), for verifying chat persistence without a browser.

```bash
IP=$(ha apps info local_claude-code-ui --raw-json | jq -r .data.ip_address)
# HA_TOKEN: Profile → Security → Long-lived access tokens, on an admin account.
curl -H "Authorization: Bearer $HA_TOKEN" http://$IP:7681/diag | jq .
curl -H "Authorization: Bearer $HA_TOKEN" \
  "http://$IP:7681/diag/query?q=Tell%20me%20the%20car%20battery%20state" | jq '.events'
```

**ha-mcp has been removed entirely** — it was unreliable (broken WebSocket auth; mis-reports dashboards; the SDK doesn't invoke `canUseTool` for MCP tools so they bypass prompts). Use `ha-tools` + direct YAML edits, which run as Bash/Edit calls and honour the permission mode. The `enable_ha_mcp` / `ha_token` app options are gone.

**Important — persisted MCP state:** the Claude CLI persists MCP servers into `~/.claude.json` (`projects["/config"].mcpServers`), and the SDK auto-loads them on every run. An early MCP-enabled build wrote a `home-assistant` server there, which kept loading and causing "Invalid authentication token" errors long after we stopped configuring it. `sanitizeMcpState()` in `server/index.js` strips persisted `mcpServers` (global + per-project) at startup so the app never loads a stale MCP server. **Do not remove it** even though we no longer configure any MCP servers ourselves.

**Important — the account's claude.ai connectors:** from Agent SDK **0.3.26x** the
CLI also auto-fetches the *claude.ai account's* cloud connectors (Gmail, Drive,
Calendar …) and connects them. They arrive over the network from the logged-in
account, not from any file, so `sanitizeMcpState()` cannot see them — the live
suite caught three loading straight after the 0.3.237 → 0.3.274 bump. Every run
therefore passes `settings: MCP_FREE_SETTINGS` (`disableClaudeAiConnectors`,
`server/lib/mcp.js`), which is any-source-true and highest priority as an inline
`settings` object. This is a permission matter, not tidiness: **the SDK does not
invoke `canUseTool` for MCP tools**, so a connector's tools would run with no
prompt in any mode — outside the permission mode the user picked, and reaching
their mailbox rather than their house. `/diag/query` passes the same settings, or
it would report connectors a real turn does not have.

### Other apps' configs (`/addon_configs`)

The `all_app_configs` map in `config.yaml` mounts every other app's config folder at `/addon_configs/<repo>_<slug>/`. HA folder maps are **static** (always mounted; can't be toggled per-option), so access is gated in the app instead: the `allow_addon_configs` option (default **false**) → `ALLOW_ADDON_CONFIGS` env → a **PreToolUse hook** (`ADDON_CONFIGS_HOOKS` in `server/index.js`) that returns `permissionDecision: 'deny'` for any tool call whose serialized input contains `/addon_configs`. A PreToolUse hook is used rather than `canUseTool` because it runs in **every** permission mode — including `auto`, which has no `canUseTool` — and its deny short-circuits the tool before it runs. The hook is only attached when access is disabled (no per-call overhead when enabled). When enabled, `ha-context.sh` appends a section telling Claude the folder exists and how it's laid out; when disabled it's not advertised at all.

## Conversation Persistence

Conversations are Claude Code's own transcripts (`sessions.js`); the app keeps a pointer to the one on screen (`runtime.activeSessionId`, saved to `/data/active-session.json`), shared by every tab. On connect the server replays `{ type: 'history', view, items, running, background, artifacts }`; the client rebuilds the DOM via `renderHistory` (artifact cards included, placed after the reply that wrote them).

**Several conversations run at once (0.5.0, `runs.js`).** `runtime.runs` maps a conversation key to its run — the session id, or a `draft:<uuid>` key for a new conversation until its `init` arrives (then `rekey()` moves the run, and the view if it was on screen, to the real id). A run is **not** tied to a connection, nor to the view: `session_switch` and `new_session` no longer abort anything; `abort` stops the conversation on screen, or `{ key }` from the running list; deleting a conversation stops its run. Transcript events go through `emit(run, msg)`, which broadcasts only while that run is the view (tagged `sid`); the `runs` list (every tab) and `run_finished` (when it ends out of sight) say the rest. Permission prompts and questions are broadcast regardless, tagged with `sid` + `conversation`, so a tab can say whose they are. Each reply's workspace files (`turn_artifacts`) are recorded per conversation in `session-meta.json` (`recordArtifacts`) — what its file tools wrote, plus anything new in the workspace that another run's file tools did not write. `sessionId` is used for SDK `resume`; a stale id is dropped on error so the next prompt starts fresh while keeping the visual transcript.

## Permission Modes

Selectable in the UI per-prompt; the **default for new chats** comes from the `default_permission_mode` app option (`DEFAULT_PERMISSION_MODE` → sent to the client in the `config` connect message; localStorage overrides it once the user picks one).

- **Ask** — `canUseTool` prompts the user for each tool call
- **Plan** — SDK-native plan mode (`permissionMode: 'plan'`): the model is restricted to read-only tools and proposes a plan. Routed through `canUseTool` too, which auto-allows read-only tools and only prompts on `ExitPlanMode` (the plan-approval step). Like `auto`, a run *started* in plan can't be live-switched.
- **Accept Edits** — file edits (`EDIT_TOOLS`) auto-approved, other tools prompt
- **Bypass** — all tools auto-approved (auto-allow `canUseTool`, not the SDK `bypassPermissions` mode, which the CLI refuses when running as root — it exits 1)
- **Auto** — a model classifier approves/denies each tool, no prompts (`permissionMode: 'auto'`, no `canUseTool`)

**Reasoning effort:** the Settings panel has an effort selector (Low→Max) sent as `effort` on the prompt; the server sets `opts.effort` only when a level is chosen (else the SDK model default, high). Higher effort means longer, quieter thinking — a common cause of the "chat looks stuck" perception.

## Background Tasks

An `Agent` (subagent) or a backgrounded shell command can keep running after the
model's own reply has already ended and the SDK has reported `result`. That used
to break every permission mode, confirmed live against the real SDK/CLI (0.3.284
/ 2.1.284): **`run-query.js` passes the prompt as a streamed `AsyncIterable`
(`lib/input-channel.js`), never a plain string.** A string prompt makes the SDK
mark the query single-turn, and once the session goes idle after `result` it
closes the CLI's stdin — even while a background task is still running. From
then on the CLI can no longer send **any** control request back to this host (a
PreToolUse hook callback, a `canUseTool` ask): every one is denied *inside the
CLI itself*, with its canned "The user doesn't want to take this action right
now" text, before any host code runs at all. A background subagent trying to
deliver its report through SubagentHandback loses exactly this way — repro'd
with a real 120s backgrounded sleep: the hand-back was denied ~110s after
`result`, with no PreToolUse hook log preceding it. Keeping the channel open
until nothing is left running fixes it for every mode (ask/acceptEdits/plan/
bypass go through `canUseTool`; `auto` goes through the PreToolUse hook — both
need the same open channel).

- **Run phase.** Each run in `runtime.runs` is `{channel, q, phase, …}`: `phase` is
  `'turn'` while the model is actively responding, `'background'` once that
  turn's own `result` has arrived but a task it spawned is still live. The
  channel only closes (`maybeEndRun()` in `run-query.js`) once `resultSeen` **and**
  the run's `backgroundTasks` is empty — a single streamed query can legitimately
  emit more than one `result`, one per follow-up turn, which is expected and not
  treated as a fresh prompt.
- **Task tracking.** `system/background_tasks_changed` is the authoritative
  membership signal (REPLACE semantics — swap the set, don't diff it; `ambient`
  tasks are excluded, they're housekeeping not activity). `task_progress` only
  enriches entries already there (`lastTool`/`summary`). `task_notification` is
  what becomes the chat-visible `task_notice` (see Interactive Tools below) —
  it is not relied on for membership.
- **A prompt arriving while `phase === 'background'`** is pushed into the same
  still-open channel (`runQuery` in `run-query.js`) rather than aborting it —
  aborting would kill the background task, which is the bug this exists to
  avoid. `abortRun()` (Stop, or deleting the conversation) still ends it, closing
  the channel and clearing its `backgroundTasks`.
- **The stall watchdog is exempt in the background phase** — that silence is
  expected, not a stall — and logs an occasional heartbeat (~5 min) instead.
  `STALL_WARN_MS`/`STALL_CHECK_MS` (`config.js`) are overridable so a test can
  see the watchdog actually fire without a real 20s wait; the idle measurement
  itself rounds to whole seconds, so an override still needs to clear a 1s floor.
- **Wire protocol:** `background_tasks` (the full current list, replayed on
  reconnect alongside `history.background`), `task_notice` (one background
  task ending), `agent_report` (a delivered SubagentHandback report, live). The
  UI shows a strip above the composer while the list is non-empty
  (`frontend/js/banners.js`'s `refreshBgTasksStrip`).
- **Never raw harness XML.** A background task's own `<task-notification>` and
  a delivered hand-back report arrive as `user`-role transcript lines stamped
  `origin.kind` (`'task-notification'` / `'peer'`) — never `'human'` and never
  unstamped. `sessions.js`'s `lineToItems`/`sessionTitle` route every non-human
  origin away from an ordinary user bubble/title; `isHarnessEcho` and
  `parseTaskNotification` do the same for older-CLI shapes with no origin at
  all. This covers both the live stream and a reloaded transcript — the actual
  incident was a `<task-notification>` rendering as if the user had typed it.

## The model picker

**The `<option>` list in `index.html` is a fallback, not the source of truth. Do
not "fix" a stale model list by editing it.** After `system/init`, `run-query.js`
asks the live query for `supportedModels()` — the catalog Claude Code's own
`/model` picker is built from, already filtered to what the logged-in account may
run — caches it on `runtime.cachedModels`, and broadcasts `models`. The client
rebuilds the dropdown from that. It is cached and replayed in the greeting
exactly like `cachedSlashCommands`, so a tab connecting later gets it without
waiting for a turn; the static options only ever show before the first run of a
boot.

The call is fire-and-forget and wrapped in try/catch: a CLI that doesn't
implement it leaves the static list in place rather than emptying the dropdown.

Two things about the live catalog that the shapes have to tolerate, both seen on
a real account:

- **Its `value`s are mostly aliases, not ids** — `sonnet`, `haiku`, `opus[1m]`,
  `default` — while this app has always stored full ids. Every row also carries
  `resolvedModel` (`sonnet` → `claude-sonnet-5`), which is what matches a stored
  id to its row; without it a stored `claude-sonnet-5` would look absent and be
  appended as a duplicate. A stored id that matches nothing is *kept* and shown
  by name (`ensureModelOption`), never silently swapped for another model.
- **A row's `value` can differ between runs** — the Fable row arrived as
  `claude-fable-5-1` on one turn and `claude-fable-5-1[1m]` on the next. The
  catalog is forwarded verbatim; both spellings run.

## Auto-Continue on Usage Limit

When a **claude.ai subscription** hits its **5-hour** usage limit mid-run, the SDK emits a `rate_limit_event` with `status: 'rejected'`, `rateLimitType: 'five_hour'`, and a `resetsAt` epoch. If the **Auto-continue on limit** Settings toggle is on, the server persists that and resumes the conversation automatically once the limit resets. (This is a genuine, first-class SDK signal — not log-scraping.)

- **Subscription-only.** Gated on `isSubscriptionAuth()` (`!ANTHROPIC_API_KEY && .credentials.json` present). API-key auth surfaces plain 429s with no reset time to schedule against, so the toggle is shown disabled. The `rate_limit_event` itself is only emitted for subscription users.
- **5-hour only.** `seven_day`/`overage` rejections are broadcast (`rate_limit`) and logged but never auto-resumed — waiting out a week unattended is not the intent.
- **State is server-owned**, persisted to `/data/auto-continue.json` as `{ enabled, pending }`. The toggle is *not* localStorage (the resume must fire with **no browser open**). `enabled` is the user toggle; `pending` is a scheduled resume `{ resetsAt, rateLimitType, model, effort, permissionMode, attempts }`.
- **Survives restarts.** On boot, `loadAutoContinue()` + a re-arm block reschedule a saved `pending` (fires ~immediately if `resetsAt` already elapsed during downtime). `setTimeout`'s ~24.8-day ceiling covers a 5-hour wait.
- **Loop safety.** `attempts` is capped at `AUTO_CONTINUE_MAX_ATTEMPTS` (3): if a resume is immediately re-limited it backs off and eventually gives up (`auto_continue_gaveup`).
- **The resume** is a headless `runQuery` (a fake `{ readyState: 3 }` socket) with a short "continue where you left off" prompt, reusing the interrupted run's model/effort/permission mode. If that run needs a **permission prompt**, it is broadcast to whatever's connected — and now **waits** even if nothing is, exactly like a question, rather than denying to end the run cleanly (see `pendingPermissions` under Interactive Tools above). An unattended resume can therefore sit waiting on an unanswered prompt until someone opens the app. A manual prompt / new chat / session switch supersedes a pending resume (`cancelAutoContinue`).
- **When it's off, the limit is still surfaced.** `autoContinue.offer` (persisted alongside `enabled`/`pending`) records a limit that stopped a run while nothing could be scheduled. The client shows the reset time and a **Resume automatically** button; pressing it just sends `set_auto_continue`, and the server schedules *that* offer rather than only affecting the next limit. An offer is dropped on a new prompt / new session / session switch, or once `resetsAt` is more than `LIMIT_OFFER_GRACE_MS` past (`liveLimitOffer()`).
- **Wire protocol:** server→client `auto_continue_pending` (banner + countdown), `auto_continue_resuming`, `auto_continue_cancelled`, `auto_continue_gaveup`, `auto_continue_state`, `limit_notice` (the in-transcript note at the point the run stopped), `limit_offer` / `limit_offer_cleared`, plus raw `rate_limit`; client→server `set_auto_continue`, `cancel_auto_continue`. Connect `config` carries `autoContinue` + `autoContinueSupported`, and replays `auto_continue_pending` or `limit_offer`.
- **Testing without a real limit:** `GET /diag/autocontinue?simulate=<seconds>` (debug option on) arms a resume that fires after N seconds against the active session, exercising the full schedule→resume path.
- **A rejection can still throw, and the throw lies.** Confirmed live: `rate_limit_event(status:'rejected')` fires (setting `limitHit`) — then the query still emits a `'result'` event claiming `subtype:'success'` (cost $0, 1 turn) — then the async generator *throws*, landing in the `catch` block with `err.message` like `"Claude Code returned an error result: You've hit your session limit · resets 1am (Europe/London)"`. None of that later noise is trustworthy: `limitHit`, set from the real `rate_limit_event`, is. So once `limitHit` is set for a run, the `'result'` handler no longer touches an `endedSuccessfully` flag (removed — a `'success'` subtype can't override a rejection that already happened), and the `catch` block skips both the generic `error` broadcast (the `finally` block's `limit_notice` already explains it) **and** the stale-resume-id drop (`resuming` branch) — that drop used to fire here every time, silently swapping `activeSessionId` to `null` so the *next* prompt started a brand-new session instead of resuming the interrupted one. Nothing was actually lost (the old transcript is still on disk, just no longer `activeSessionId`, findable in the session list), but it read as if the conversation had vanished.

## Branding

This is Soufiane's personal fork (`name`/`slug` in `config.yaml`:
`Soufassistant`/`soufassistant`), forked from the upstream `xionic/home-assistant-claude-code`
project (AGPL-3.0 — see the repo-root `README.md`'s Credits section and
`LICENSE`; this fork keeps the same license, which AGPL requires). There is
**no `image:` key** in `config.yaml` — no CI publishes an image for this fork
(yet), so every install, local or otherwise, builds from the Dockerfile. If
CI is set up later to publish one, the key can be reintroduced (see the
upstream project's `.github/workflows/build.yml` for the pattern this
project used). `icon.png`/`logo.png` were regenerated (teal/white, script not
kept in the repo — a plain PIL script, trivial to redo if the mark needs to
change) to match the new brand colors (`frontend/styles.css`'s `:root`
variables — `--accent`/`--bg`/`--surface`/`--surface-2`/`--border` — plus a
handful of hardcoded accent-blue hex values that were swapped to teal
equivalents; status colors — success green, error red, warning amber — were
deliberately left alone, they're semantic, not brand).

**Full-width desktop layout.** `#app` used to cap at `max-width: 860px` with
`margin: 0 auto`, which is correct for a phone but left the `--bg` background
showing as side bars on anything wider — reported as "black bars" on desktop.
`#app` is now full-bleed (no cap); `.bubble` instead caps its own width at
`min(82%, 760px)` above `1000px` viewports so a reply doesn't stretch into an
unreadable line length on a wide monitor. Header/messages/composer are not
separately constrained — they fill `#app` edge to edge, which is the normal
look for a desktop chat app and is what actually fixes the "bars" complaint
(a centered, narrower reading column would just reintroduce them in a
different color).

## Task List, Workspace, Scheduled Tasks, Team panel, and Usage panel

Local, self-hosted analogues of a few things Claude's hosted products
(including "Cowork") give for free — there is no public API to embed those
products' own UI or backend here, so each is a from-scratch equivalent built
on the same Agent SDK this app already drives. `plugins/productivity-tools`
is the one skill that tells Claude about all three.

**Task list (`server/lib/tasks.js`, `scripts/claude-tasks.cjs`).** A plain
Node CLI, run via Bash like `ha-tools` (so it goes through the ordinary
permission system), `POST`s to this app's own `/internal/tasks` — loopback
only, guarded by `server/lib/internal.js`: each Docker container has its own
network namespace, so 127.0.0.1 here is unreachable from anywhere outside
this container, which is the same trust boundary a Bash call already sits
inside. `tasks.js` owns validation (ids/descriptions length-capped, status
restricted to `pending`/`in_progress`/`completed`, list capped at
`MAX_TASKS`), persistence (`/data/tasks.json`, same pattern as
`auto-continue.js`), and broadcasting `{type:'tasks', tasks}` to every tab —
replayed on connect in `ws-protocol.js`'s `greet()`. The frontend
(`frontend/js/tasks.js`) is a header button that only appears once the list
is non-empty, opening a panel built from the same CSS as Sessions.

**Workspace (`server/lib/workspace.js`, `frontend/js/workspace.js`).** A folder
separate from `/config` for anything worth keeping — default `/data/workspace`,
but the root is **chosen in the Workspace panel** ("Folder…", persisted in
`/data/workspace-config.json`; `validateRoot()` only accepts folders inside
/config, /data, /share or /media, never `.storage` or `/data/secrets`). Its
top-level folders are **projects** (chips in the panel; "+ Project" creates
one; double-click / the Cowork selector marks the active one). Served
read-only at `/workspace/<relPath>` by a small middleware that rebuilds the
`express.static` handler when the root changes; listed at `/api/workspace`
(bounded walk, dot-entries and node_modules skipped, `MAX_ENTRIES` cap). The
socket carries the rest: `workspace_state` ({root, defaultRoot, activeProject,
projects, sync}) in the greeting and on change; `workspace_set_root`,
`workspace_create_project`, `workspace_set_active` from the panel. **Sync
status:** when `WORKSPACE_SYNC_LOG` (default `/data/tools/drive-sync.log`, an
rclone bisync log) exists, `parseSyncLog()` reports the last
`Bisync successful` line and any later ERROR, plus a count of `*.conflict*`
files. rclone logs nothing at NOTICE on success, so the sync script writes
that marker line itself. The app never runs the sync.
`run-query.js` re-broadcasts the listing after every turn, and the system
prompt names the current root (modes.js `workspacePrompt()`), so Claude writes
where the user is looking.

**Artifact viewer (`frontend/js/artifacts.js`).** A pane beside the chat (full
screen under 1000px) previewing a workspace file: HTML in an iframe with
`sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"`
and **no `allow-same-origin`** (opaque origin: the page cannot touch the app,
its cookies or its socket — verified in Chromium); Markdown rendered by marked
into a script-less sandboxed `srcdoc`; images/SVG via `<img>`; PDF via the
browser viewer; CSV/TSV as a table; text as `<pre>`. After each reply, files
whose mtime is newer than the prompt (`S.runStartedAt`, set in composer.js)
get an "Artifacts" card in the transcript and the newest previewable one opens
(Settings → "Open artifacts automatically").

**Modes: Chat / Code / Cowork (`server/lib/modes.js`, `frontend/js/modes.js`).**
A switch in the header (a select in the composer under 700px) sent with every
prompt as `mode` (+ `project` for Cowork). `modeOptions()` returns the SDK
overrides: **code** — unchanged agent, plus the workspace note appended to the
`claude_code` preset; **chat** — `tools: ['WebSearch','WebFetch']`,
`plugins: []`, `settingSources: []` and a plain-string system prompt
(no files, shell, HA or CLAUDE.md); **cowork** — `additionalDirectories:
[project]`, a preset append telling Claude to build/test inside the project,
and `coworkWriteGuard()` as a PreToolUse hook that denies Write/Edit/
MultiEdit/NotebookEdit outside the project (or /tmp) **in every permission
mode**. Bash is not fenced (documented to the user). The cwd stays `WORK_DIR` in
all modes on purpose — the transcript store is keyed on cwd, so switching modes
must not split the Sessions list. Each session's last mode/project is kept in
`/data/session-modes.json` and pushed as `session_modes`; opening a session
restores its mode. A Cowork prompt with no valid project is refused before
anything is aborted. A chat turn does not overwrite the cached slash commands.

**Conversations (`server/lib/session-tools.js`, `frontend/js/sessions.js`).**
Custom titles and pins live in `/data/session-meta.json` (the transcript is not
touched; `decoratedSessions()` overlays them, pins first). Search is a
case-insensitive scan of every conversation's prompts and replies
(`parseSession`), with a snippet. Export writes Markdown to
`<workspace>/Conversations/`. Duplicate uses the SDK's `forkSession(id, {dir:
WORK_DIR})` (the stub implements it as a copy). The ⋯ menu holds these; ✕ stays
a direct delete (a browser test clicks `.session-del`).

**Changes and restore (`session-tools.js` listTurns/rewindTo, `frontend/js/changes.js`).**
Every non-chat turn runs with `enableFileCheckpointing: true`. `listTurns()`
pairs each human prompt (its transcript `uuid`) with the Write/Edit/MultiEdit/
NotebookEdit calls made answering it, which the panel shows as a simple
before/after. "Restore files to before this message" calls `rewindTo()`: a
**promptless Query that resumes the session** with checkpointing on and calls
`rewindFiles(uuid, {dryRun})` — verified live to work on a finished
conversation, spending no tokens. Dry run first (files, ±lines), then the real
one after confirmation; refused while that conversation is running. Only
file-tool changes are tracked, not Bash; conversations from before 0.4.0 have
no checkpoints.

**File editor (`workspace.js` writeWorkspaceFile/deleteWorkspaceFile, `artifacts.js`).**
Text formats only (`EDITABLE_EXT`), 2 MB max, never dot-paths or outside the
root. The editor records the file's mtime when it opens (`workspace_stat`) and
a save with a stale mtime returns `conflict` (Claude or the Drive sync changed
it) — the user can overwrite. "+ File" creates with `create: true` (refuses to
replace). Plain `<textarea>` (no build step, no CDN): Ctrl/⌘+S saves, Tab
indents.

**Live previews (`server/lib/previews.js`).** `/preview/<port>/…` reverse-proxies
to `127.0.0.1:<port>` for ports `PREVIEW_PORT_MIN..MAX` (8100–8199) only;
anything else is a 404, so it is not an open proxy. Cookies/Authorization are
not forwarded, `X-Frame-Options`/CSP are dropped, redirects to absolute paths
are rewritten under the preview prefix (using `X-Ingress-Path`), and responses
get `Access-Control-Allow-Origin: *` with preflights answered locally — the
viewer iframe has no `allow-same-origin`, so the page's own `fetch()`es come
from an opaque origin. WebSockets are not proxied. Running previews are read
from `/proc/net/tcp{,6}` LISTEN sockets; Stop SIGTERMs the owning pid (found via
`/proc/<pid>/fd`). The Cowork prompt tells Claude the port range and to use
relative URLs. `/preview/<port>` (no slash) redirects — an exact regex route,
because Express's non-strict routing would otherwise loop.

**Outside clicks.** Panels close on a click outside them, but a click that
re-renders the panel detaches its own target — handlers return early on
`!e.target.isConnected` (that bug closed the Workspace panel on a project-chip
click in 0.3.0).

**Skills panel (`server/lib/skills.js`, `server/lib/zip.js`, `frontend/js/skills.js`).**
Discovers SKILL.md files from three sources: **account** (`~/.claude/skills/
synced/<bucket>/` — claude.ai-enabled skills the CLI syncs down; last sync from
the bucket's `manifest.json`), **plugin** (the loaded plugins' `skills/`), and
**local** (`~/.claude/skills/<name>/`, editable). Switching one off is applied
per run as inline `settings.skillOverrides: {name: 'off'}` — keyed by the bare
name *and* the invocation name the CLI reported in the init slash commands
(e.g. `anthropic-skills:pptx`); unmatched keys are ignored, so a wrong guess
can never hide a different skill. The SDK's `skills` allow-list option was
deliberately not used: a wrong name there would hide skills. Local skills are
created/edited/deleted from the panel (`skill_save` / `skill_delete`);
`/api/skills/export?id=` zips any skill (STORE method, no dependency) for
upload at claude.ai → Settings → Capabilities — there is no public API to push
a skill to an account; once uploaded it syncs back down as an account skill.

**Scheduled tasks (`server/lib/scheduler.js`, `server/lib/cron.js`).** A
persisted list (`/data/scheduled-tasks.json`) of `{name, cron, prompt,
enabled}`, ticked every `SCHEDULER_TICK_MS` against `cron.js` — a small,
dependency-free 5-field matcher in the spirit of `ha-time.cjs`/`ha-trace.cjs`
(own the small pieces of logic rather than pulling in a package for this).

Deliberately **not** run through `run-query.js` / the single shared
conversation this app otherwise models (see **Conversation Persistence**
below): a scheduled prompt firing into whatever the user happens to be
chatting about right now — or `abortActive()`-ing a run already in progress —
would be exactly wrong. A firing instead calls the SDK's `query()` directly,
as its own run with its own (resumable) session id, and never touches
`runtime.activeSessionId` or broadcasts into the visible transcript — only
`anyRunning()` (runs.js) is checked, and only to skip a tick while something
else is running (a manual "run now" instead reports `scheduled_run_busy`).
It resumes the *same* session id on every firing (`entry.lastSessionId`), so
a daily check-in genuinely continues yesterday's rather than starting cold.
Nobody is there to answer a prompt, so its `canUseTool` allows every ordinary
tool automatically (still behind `ADDON_CONFIGS_HOOKS`, same as every other
mode) and **denies** `AskUserQuestion` with a message telling the model to
use its own judgement — consistent with how every other mode here intercepts
that tool via `canUseTool` rather than the SDK's own (non-functional, see
**Interactive Tools** above) dialog transport. A hard `AbortController`
timeout (`SCHEDULED_RUN_TIMEOUT_MS`, default 15 min) guarantees one stuck
unattended prompt can never block every later firing. The run still writes to
Claude Code's ordinary on-disk session store, so it is inspectable from the
Sessions panel afterwards; the result reaches the user only through
`notify.js` (a short summary kept on the entry, not the full transcript) and
the Scheduled-tasks panel's own last-run line.

`frontend/js/scheduled.js` is the panel: list, an inline add/edit form,
run-now/edit/delete per entry. There is deliberately no tool for Claude to
create one of these on its own behalf mid-conversation — an unattended prompt
that runs with every tool pre-approved is something a person should set up
deliberately from the panel, not something reached for in the middle of a
chat; the skill tells Claude to say so if asked.

**Team panel (`server/lib/team.js`, `scripts/team-notes.cjs`).** A persisted
list (`/data/team.json`) of `{id, name, role, notes, lastOneOnOne,
createdAt}` — a lightweight 1:1/roster tracker for a project or team lead.
Unlike the task list (Claude-driven only) or scheduled tasks (UI-driven
only), **both sides write to the same state**: the person edits a card
directly from the Team panel (`frontend/js/team.js` — list, inline add/edit
form, a one-tap "1:1 today" stamp, delete), and Claude can log a dated note
via the `team-notes` CLI (same shape as `claude-tasks` — a plain Node http
client against the loopback-only `/internal/team`, guarded by
`internal.js`). Both paths converge on `team.js`'s `upsert()`/`addNote()`/
`remove()`, which broadcast one `{type:'team_members', members}` update —
there is no separate reconciliation step. `addNote()` matches an existing
member case-insensitively by name (so "log a note about Bernard" updates the
same card rather than creating a duplicate), creates one if none matches, and
appends a `[YYYY-MM-DD] ...` line to `notes` rather than overwriting it. The
skill instructs Claude to log only what the user actually said, and to leave
out health/HR/disciplinary detail entirely rather than writing a softened
version of it.

**Usage panel (`frontend/js/usage-panel.js`, `server/lib/plan-usage.js`).** A
permanently-visible header button with two sections, plus a badge on the button
showing the 5-hour session % (coloured: normal < 75 % ≤ warn < 90 % ≤ high).

1. **Plan limits** — the claude.ai subscription meters Claude Desktop shows: the
   5-hour session window, the weekly window(s) (overall, and per model when the
   plan has one), and the monthly extra-usage budget when enabled, each with a
   bar and a "resets in …" countdown. Source: the SDK's **experimental**
   structured `/usage` control request
   (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, called with
   `skip_behaviors: true`). The method name lives in one constant
   (`USAGE_METHOD`) and `normalizePlanUsage()` turns any unknown shape into
   "unavailable" rather than throwing — expect to touch this when the SDK
   stabilizes the API. Fetched from the active run's Query when there is one,
   otherwise from a **probe**: a Query that is never sent a prompt, asked the
   control request, then closed — no tokens spent (~4 s on a Green). Refreshed
   after every `result`, on any non-`allowed` `rate_limit_event`, when the panel
   opens (`plan_usage_refresh`), when a tab connects, and every 5 min while a tab
   is connected and nothing is running; never more than once a minute and never
   concurrently. API-key logins never fetch (`isSubscriptionAuth()`). There is no
   monthly *token* limit on claude.ai plans — the only monthly figure is the
   extra-usage budget. The probe sets `SOUFASSISTANT_USAGE_PROBE=1` in its env:
   the real CLI ignores it, the test stub uses it so a probe never consumes a
   scripted run.
2. **This conversation** — `S.usage`, the per-session totals accumulated from
   `result` events (`connection.js`'s `result` case, `transcript.js`'s
   `renderHistory`), resetting on New chat.

## Notifications

"Tell me when Claude needs me" is **server-delivered through Home Assistant**, not
a browser feature: a phone that has backgrounded the page drops the WebSocket and
suspends JS, so only the server (which outlives the socket) can reach it. The cues
are the SDK's own, not heuristics:

- **needs permission** — `canUseTool` being invoked (`permissions.js`);
- **asks a question** — `askQuestion()` (`dialogs.js`), which covers the
  `canUseTool` and auto-mode hook paths;
- **reply finished** — `system/session_state_changed` with `state: 'idle'`, the
  SDK's "authoritative turn-over signal". The CLI only emits it when
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, which `run-query.js` passes via
  `opts.env`. If a CLI never sends it, the run's genuine end (the `finally`) stands
  in. **Not** `result`: one run can emit several.

`server/lib/notify.js` owns settings (`/data/notify.json`, server-owned like
auto-continue), the pure `shouldPush()` rule (service chosen, kind enabled, no
visible tab, 10 s per-kind cooldown), the `notify.<service>` call (tag
`claude-code-ui`, `url`/`clickAction` = the ingress panel), a matching
`claude_code_ui_attention` bus event, and `clear_notification` once nothing is
pending. Tabs report `presence` (`visibilityState` + focus); a dropped socket
counts as not watching. `frontend/js/notify.js` adds the title badge / optional
`Notification` for desktop. Wire: `presence`, `set_notify`, `test_notify` →
`notify_state`, `notify_test`.

## Logging & the "chat hangs" symptom

Reported symptom: a response stops coming, then resumes minutes later (not a true hang — usually long silent thinking, a slow tool, a retry/backoff, or auto-compaction). Instrumentation added for it:
- **Server** (`server/index.js`): milestone logs always at INFO — query start (mode/effort/model/resume), result (duration/turns/cost), compaction, errors. A **stall watchdog** logs a WARN when no SDK event arrives for ≥20s during a run. Context usage is logged each turn (WARN ≥90%). The `verbose_logging` app option (`VERBOSE_LOGGING`) adds per-event DEBUG logs (each text/tool_use/tool_result). All go to the app log.
- **Frontend**: the Working indicator shows **elapsed seconds** (restarts each quiet stretch) and the context indicator turns amber→red with a `/compact` nudge as the window fills.
- **/compact echo**: slash-command runs are recorded in the transcript as user messages wrapped in `<command-name>…`/`<local-command-stdout>…`. `isCommandEcho()` in `lineToItems` filters them so `/compact` doesn't pollute the chat.

**Live mid-prompt switching:** ask/acceptEdits/bypass all route through a single `canUseTool` that reads the module-level `activePermMode` at call time, so changing the dropdown mid-run takes effect immediately (the client sends `set_perm_mode`). Switching to bypass/acceptEdits also auto-resolves any pending permission prompt (server emits `permission_resolved` so the UI dismisses the card). **Caveat:** `auto` is SDK-native with no `canUseTool`, so a run *started* in auto can't be live-switched — the change applies to the next prompt. `canUseTool` is also not invoked for external MCP server tools (none are configured now).

## Interactive Tools & Context Usage

- **AskUserQuestion** is intercepted before the tool runs, and never executes. The SDK's own dialog transport is not the route it takes: the tool call completes inside the CLI subprocess with a canned "The user did not answer the questions." and no `request_user_dialog` is ever sent, whatever `supportedDialogKinds`/`toolConfig` declare. (That silent failure is why the tool used to be in `disallowedTools`.) Instead:
  - `canUseTool` short-circuits `AskUserQuestion`, emits the existing `user_dialog` message, and turns the answer into a **`deny` whose message is the user's answer** — `canUseTool` has no "succeeded with this result" shape, and a denial's message is what reaches the model as the tool result. See `formatQuestionDenial()`.
  - `auto` mode has no `canUseTool`, so there the same interception runs as a **PreToolUse hook** (`askQuestionHook`), registered only for `auto` and scoped to `matcher: 'AskUserQuestion'` — every other tool call in `auto` mode skips it rather than round-tripping through it for nothing. `hooksFor(mode)` composes it with the (unmatched, sees every call) `/addon_configs` guard.
  - Because the answer arrives as `is_error: true`, both the live stream and `parseSession` correlate `tool_use` id → tool name and flag it `answered` so the UI renders it as an answer, not a failure (`isQuestionAnswer()`).
  - Pending questions live in a **module-level** `pendingDialogs` map, not per-connection, and **wait indefinitely** — a tab disconnecting (backgrounded app, phone asleep, closed browser) does *not* cancel one, however long it's been. A question belongs to the run, not to the socket that happened to be open when it was asked: any tab can answer it, and one that connects later — in ten minutes or tomorrow — is shown every entry still in `pendingDialogs` and can answer it then. The only things that end the wait are an actual answer, Skip, or the run itself ending (the tool call's own abort signal — Stop, a new prompt, a session switch). This used to auto-cancel on the last disconnect on the theory that nobody would come back; a phone backgrounding its browser drops the WebSocket routinely, so that read as the question silently vanishing while you were away. **Permission prompts now get the same treatment.** `permissions.js`'s `pendingPermissions` is module-level too — a prompt is `broadcast()` to every connected tab (not just the one that triggered it), replayed to a tab that connects afterwards (`greet()`), and answerable from any of them; answering on one dismisses it on the rest via `permission_resolved`. It is **not** denied just because nobody is connected at the moment it's raised (including a headless auto-continue resume with no browser open) — it waits, exactly like a question. Only an abort (Stop, a new prompt, a session switch, or the run itself ending) ends it. **More than one can be pending at once** — a main agent and a background subagent can each have a tool call waiting on an answer simultaneously (see Background Tasks above). The frontend (`dialogs.js`) queues them in `pendingPerms`: `showPermissionPrompt` only opens a card when none is already showing, `closePermission(id)` removes whichever one just resolved — even if it was never shown, because it was answered elsewhere before its turn came — and opens the next queued one, and `laterPermission` sets aside only the one on screen, never jumping the queue. The strip's count (`refreshQuestionStrip`) reflects every pending one, shown or not.
  - `onUserDialog` + `supportedDialogKinds` + `toolConfig` are still registered — the documented contract, harmless, and it feeds the same map should a future CLI build start using it. If it ever does, remove the by-hand path rather than leaving the two racing.
- **Questions and permission prompts can be set aside.** ✕ (or a backdrop tap) hides the card without answering; the request stays pending server-side and `#question-strip` above the composer is the way back. A dismissed question is not re-opened by the reconnect replay.
- **Context indicator** uses `query.getContextUsage()` (cache-inclusive `totalTokens` / `maxTokens` / `autoCompactThreshold` / `isAutoCompactEnabled`), broadcast as `context_usage` after each result and after compaction. The frontend shows tokens and **% toward auto-compaction**. The old input+output math undercounted because it ignored `cache_read_input_tokens`.
- **Compaction** is handled by the SDK (auto + `/compact`); the server forwards the `system`/`compact_boundary` event as `compacted` so the UI shows a divider and refreshes the indicator.

## Chat UI notes

- **Tool-call runs fold as they arrive**, not at the end of the turn — `refreshToolGroup()` runs on every call *and* every result, collapsing at ≥2 calls unless the user has opened the group (`_st.touched`, which a search hit also sets). The folded header carries the running call's name+argument, then the tool names and any failure count, so folding costs no information that was being watched.
- **Layout is a fixed frame with one scroller.** `html, body { overflow: hidden; overscroll-behavior: none }` and `#app` sized by `js/viewport.js`; `.messages` adds `overscroll-behavior: contain`. Without these, on a *mobile browser* (not the HA app) a swipe past the end of the transcript chained to the Home Assistant page behind the ingress iframe and scrolled its header — and the app's own — out of reach.
- **The frame is measured, not assumed — `js/viewport.js`.** `100dvh` is the wrong height inside the ingress iframe: `dvh` resolves against the *iframe's* viewport, and HA sizes that iframe against the large viewport, so on a mobile browser it hangs below the bottom of the screen while the URL bar is showing. The composer went with it, `overscroll-behavior` meant nothing in the app could scroll it back, and dragging HA's own toolbar to reach it took the app's header off the top instead. Ingress is same-origin (the access `links.js` already uses for more-info dialogs), so the module walks the frame chain, intersects the iframe's box with the topmost `visualViewport`, and publishes `--app-top` / `--app-height`; `#app` and the overlays position against those, and remeasure on resize, orientation change, visual-viewport moves and any ancestor scroll. The on-screen keyboard shrinks the same visual viewport, so the composer stays above it for free.
  - **The `100dvh` fallback must stay reachable.** When the parent can't be read (cross-origin, no `frameElement`) the custom properties go unset, the CSS falls back to `100dvh`, and `html.viewport-unmeasured` puts `overscroll-behavior` back to `auto`. If we can't guarantee the whole app is on screen, the user has to be able to scroll the page behind us to reach it — being stranded is much worse than a swipe nudging HA.
  - Dialogs are `position: absolute` inside `#app`, not `fixed`. Fixed would size them to the iframe again and put a centred dialog's buttons below the fold. Anything else reaching for `vh` wants `var(--app-height, 100dvh)` for the same reason.
  - **Fitting the band has a sting in its tail, and `keepChromeOnScreen()` is the answer.** It works just as well when the page *above* us has been scrolled away: HA's panel page is over-tall for the same URL-bar reason, so dragging its toolbar scrolls it off the top, we re-fit into the space it vacated, and the app looks completely normal with HA's menu button gone. Before we measured, the app's own header vanished at the same time, which at least announced what had happened — the fix turned a self-correcting annoyance into a stable, invisible one. So we scroll the ancestor back to the top ourselves, **after a 200ms settle** (correcting mid-gesture wrestles the finger still on the screen), and only when the panel really is the page's whole content — an ancestor with scrolling of its own to do is left alone. Both halves are asserted in `ui.test.mjs`.
- **`.chat-scroll` exists solely to anchor the ↑/↓ prompt arrows.** They can't be children of `.messages`: absolutely-positioned children of a scroll container scroll with its content.
- Prompt-arrow visibility is driven by real scroll gestures only — `markProgrammaticScroll()` fences off the app's own scrolling (streaming, jumps) so a streamed token can't flash them on.

## Key Files

| File | Purpose |
|------|---------|
| `config.yaml` | App manifest, options schema |
| `build.yaml` | Docker build args (base image) |
| `Dockerfile` | Image build: Node, Agent SDK binary, the `ha-tools`/`claude-tasks` symlinks, plugins |
| `run.sh` | Entrypoint: env init, packages, HA context, start server |
| `server/index.js` | Composition root — wires `server/lib/` and listens |
| `server/lib/` | The server proper, one module per concern (see **Server layout**) |
| `frontend/index.html` | Chat UI shell |
| `frontend/app.js` | Browser composition root |
| `frontend/js/` | The UI modules (see **Frontend layout**) |
| `frontend/styles.css` | Dark theme styles |
| `package.json` | Dev/test manifest — **not** shipped in the image |
| `test/` | Unit, integration, CLI, browser and live suites (see **Testing**) |
| `plugins/homeassistant-config/PLUGIN.md` | Plugin manifest |
| `plugins/homeassistant-config/skills/homeassistant-config/SKILL.md` | HA YAML patterns + tool docs |
| `plugins/productivity-tools/skills/productivity-tools/SKILL.md` | `claude-tasks` / workspace / scheduled-tasks / `team-notes` instructions |
| `scripts/claude-tasks.cjs` / `.sh` | The task-list CLI (see **Task List, Workspace, Scheduled Tasks, Team panel, and Usage panel**) |
| `scripts/team-notes.cjs` / `.sh` | The Team-panel notes CLI (same section) |
| `server/lib/tasks.js`, `workspace.js`, `scheduler.js`, `cron.js`, `team.js`, `internal.js` | See **Task List, Workspace, Scheduled Tasks, Team panel, and Usage panel** |
| `frontend/js/usage-panel.js` | The live Usage panel (same section) |
