<img src="claude-code-ui/icon.png" width="84" align="right" alt="Soufassistant">

# Soufassistant

Soufiane's personal AI assistant for Home Assistant: a **Claude-powered chat**
in your browser, with direct access to your Home Assistant configuration and
live state, extended with a task list, a reusable workspace, scheduled
unattended prompts, and a team / 1:1 tracker. It's a self-contained chat UI
backed by the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk),
running inside HA.

Ask it to build an automation, explain why the heating fired at 3am, tidy up a
dashboard, or track a 1:1 with a teammate — it can read your config and entity
states, and supports auto or manual approvals.

This is a personal fork, forked and extended from the open-source
[`xionic/home-assistant-claude-code`](https://github.com/xionic/home-assistant-claude-code)
project — see **Credits** below. The rebrand, the Team panel, the always-on
Usage panel, and the full-width desktop layout are new in this fork; the
underlying chat engine, Home Assistant tools, task list, workspace, and
scheduled-tasks mechanism were built in that upstream project and carried
over largely as-is.

[![Add app repository to My Home Assistant.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FSoufianeElFani%2Fsoufassistant)

|              Chat              |            Permissions             |           Settings            |
| :----------------------------: | :--------------------------------: | :---------------------------: |
| ![Chat](docs/images/chat.png)  | ![Permissions](docs/images/permission.png) | ![Settings](docs/images/settings.png) |
| Entity names link into HA      | Approve once, or always            | Model, effort, auto-continue  |

<sub>Screenshots use invented demo entities, not a real home.</sub>

## Features

- 📱 **Mobile-first chat UI** — clean vanilla-JS interface (no build step), works well in the Home Assistant companion app on Android/iOS
- 🔗 **Links into Home Assistant** — entity names in replies are clickable: tap one to open its normal more-info dialog (a switch gets its toggle, a thermostat its controls, a sensor its history); automations open their editor. Opens in-place, without leaving Home Assistant
- 💬 **Multi-session** — browse, resume, and delete past conversations. Built directly on Claude Code's own on-disk session store (`~/.claude/projects`), so sessions are interchangeable with the Claude CLI
- 🔐 **Permission modes** — Ask / Plan / Auto (model classifier) / Accept edits / Bypass, switchable mid-response. On a prompt, **Always** stops it asking again for that kind of call
- 🧠 **HA-aware context** — auto-loads your HA version, entities, apps, and recent errors into Claude's context each session
- 🔌 **ESPHome support** *(optional)* — turn on `enable_esphome` and Claude can validate, compile, OTA-flash, and stream logs for your ESPHome devices. It uses **its own bundled ESPHome toolchain** (installed inside this app), not the ESPHome app's, while working on the same device configs in `/config/esphome`
- 🔧 **Live HA tools** — one command, `ha-tools`: states, service calls, templates and registries; history and statistics; automation **and script** traces (what is running right now, which step a run is waiting on); dashboards; logs — all authenticated automatically with `$SUPERVISOR_TOKEN`, **no token setup required**
- 🤖 **Model & effort** — switch between Fable / Opus / Sonnet / Haiku and trade speed for depth (Low → Max). The list comes from Claude Code itself, so it shows the models your account can actually run
- ⏳ **Live feedback** — a working indicator with elapsed seconds, a stop button, message timestamps, and a real context-usage meter showing progress toward auto-compaction
- ♻️ **Auto-continue on usage limit** *(optional)* — if a subscription 5-hour limit interrupts a response, resume automatically when it resets. Survives an app/HA restart
- 🔎 **Find in chat** — header search, `/find`, or Ctrl/Cmd+F, with match count and highlighting
- ⌨️ **Slash commands** with autocomplete — `/new`, `/clear`, `/usage`, `/resume`, `/find`, `/help`, plus Claude's own (e.g. `/compact`) and any plugin commands
- 🔒 **HA ingress auth** — protected by Home Assistant; no separate login. Claude credentials (subscription or API key) persist across restarts
- 🏗️ **Multi-arch** — aarch64 and amd64, installed from a **prebuilt image** (no building on your Pi)
- ✅ **Task list** — a `claude-tasks` command Claude drives for multi-step work, shown as a checklist widget separate from the chat
- 🗂️ **Workspace panel** — a `/data/workspace` folder (separate from `/config`) for files Claude produces that you'll want to keep — a report, an export, a self-contained HTML page — with a direct open/download link, refreshed after every reply. This app's local, honest stand-in for a hosted "Artifact": no claude.ai URL, nothing to share outside this home, but a page you can genuinely reopen
- ⏰ **Scheduled tasks** — define a prompt that fires on a cron-style schedule (e.g. a daily check-in); it runs unattended, continues the same thread each time, and reaches you through a Home Assistant notification without interrupting whatever you're chatting about
- 👥 **Team panel** — a lightweight roster for a project/team lead: one card per teammate (name, role, free-text notes, a "last 1:1" stamp). Edit it directly from the panel, or tell Claude about a 1:1/team conversation and it can log a dated note itself via `team-notes` — see **Productivity tools** below
- 📊 **Usage panel** — a permanent header button showing this session's running token counts and estimated cost, live, instead of only on request via `/usage`. Session-scoped, not an Anthropic account-wide billing figure — subscription auth doesn't expose that
- 🖥️ **Full-width desktop layout** — the app fills the whole browser window on a laptop/desktop (no side letterboxing); message bubbles still cap their own width for readability on a very wide screen

## Installation

Requires **Home Assistant OS** (or Supervised) — apps aren't available on Core or
Container installs — with **Supervisor 2026.07 or newer**.

This fork has **no `image:` key** in `claude-code-ui/config.yaml` and no CI
publishing a prebuilt image (yet), so every install **builds from source** —
it takes several minutes the first time instead of pulling an image. Simplest
path: put `claude-code-ui/` under `/local_apps/` on the Home Assistant host
(as a **local app**) and install it from there; it then shows up under "Local
apps" in the App store. If you add a GitHub Actions workflow to publish an
image (see the upstream project this was forked from for the exact
workflow), add the `image:` key back to pull it instead of building locally.

1. Get `claude-code-ui/` onto the Home Assistant host, under `/local_apps/claude-code-ui/` (Samba share, the Terminal & SSH app, or any other way to reach the filesystem)
2. In Home Assistant, go to **Settings → Apps → Add-on Store** (or **App store**) → the ⋮ menu → **Check for updates** (or reload the page) so the new local app is picked up
3. Find **Soufassistant** under "Local apps" and install it — this builds the image locally, so expect it to take a while the first time
4. Start it, open the UI, and sign in with your Anthropic account (or set an API key in the options)

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `anthropic_api_key` | `""` | Optional. Use an API key instead of signing in with a Claude subscription |
| `default_permission_mode` | `ask` | Permission mode for new chats — `ask`, `auto`, `acceptEdits`, or `bypass`. You can still change it per-chat |
| `ha_smart_context` | `true` | Generate a context file each session (HA version, entity summary, apps, recent errors, tool reference) so Claude understands your setup |
| `allow_addon_configs` | `false` | Let Claude read/edit **other apps'** config folders under `/addon_configs`. While off, any tool call touching that path is blocked |
| `enable_esphome` | `false` | Bundle **this app's own** ESPHome CLI so Claude can validate / compile / OTA-flash / stream logs, working on your device configs in `/config/esphome`. Separate install from the ESPHome app (see note below). First enable installs the toolchain in the background (a few minutes) |
| `verbose_logging` | `false` | Per-event logs (each text chunk, tool call, result, context usage) in the app log, for diagnosing a chat that seems to hang. Milestone logs — query start/end, compaction, stalls, errors — are always recorded |
| `debug` | `false` | Exposes `/diag` troubleshooting endpoints on the app network, including one that runs arbitrary prompts with tools auto-approved. They require a Home Assistant long-lived access token belonging to an **admin** user (`Authorization: Bearer <token>`). Leave off unless you're debugging |

> **Note on ESPHome:** `enable_esphome` installs a **separate, self-contained ESPHome toolchain inside this app** (in `/data`) — it does **not** use, drive, or depend on the official ESPHome app's installation. Both simply read and write the same device YAML in `/config/esphome`, so you can keep editing in the ESPHome dashboard while Claude compiles/flashes with its own copy. Because it's a separate install, it has its own compile cache (the first build is slow) and its own version, which can drift from the ESPHome app's over time.

## How Claude talks to Home Assistant

Claude uses pre-installed CLI tools (via Bash) plus the Supervisor REST API, all
authenticated automatically with `$SUPERVISOR_TOKEN`:

- **`ha-tools`** — this app's one command-line tool; `ha-tools --help` lists everything and each command has its own `--help` with examples:
  - `ha-tools state` / `states-filter` / `entities` / `template` / `call` — entity states, registry search, Jinja templates and service calls over the HA WebSocket API.
  - `ha-tools running` shows what is executing right now and for how long, `ha-tools trace-stuck script.x` shows which step an unfinished run is waiting on, and `traces` / `trace-timeline` / `trace-summary` read the traces of **automations and scripts** alike.
  - `ha-tools timeline` — several entities' state changes merged onto one clock (`--between 22:00-07:00`), which is how most automation timing bugs get found.
  - `ha-tools history` / `ha-tools stats` — history and long-term statistics over any window (`history x 6`, `--days`, `--from`, `--to`).
  - `ha-tools automation` — what HA currently has loaded, and the matching block in `automations.yaml` with line numbers.
  - `ha-tools config-check` / `ha-tools reload` — validate config before reloading, then reload without restarting HA.
  - `ha-tools trace-watch` — wait for an automation to actually fire and report what happened, including runs its conditions blocked.
  - `ha-tools lovelace` — Lovelace dashboards: `create`, `list`, `get`, `save`, `delete` over the WebSocket API (the REST `/api/lovelace/*` endpoints don't exist on modern HA).
  - `ha-tools logs` — the Core, Supervisor, host, or any app's log, straight from the journal.
- **YAML editing** — Claude can read and edit your `/config` files directly.

These run as ordinary Bash calls, so they authenticate cleanly **and** respect
your chosen permission mode. There is no MCP server: an earlier `ha-mcp`
experiment was removed because its WebSocket auth was unreliable with the app
token and MCP tool calls bypassed the permission UI.

**Safety:** Claude is instructed never to edit `/config/.storage/*` or the
recorder database without asking first — those bypass HA's validation and corrupt
easily.

## Productivity tools

A few things Claude's own hosted apps (including "Cowork") offer natively have
a local, self-hosted equivalent here, built on the same Claude Agent SDK —
there is no public API to embed those hosted products' own UI or backend
inside a third-party page, so these are deliberately honest approximations,
not a re-skin of them:

- **Task list** — `claude-tasks` (run via Bash, so it goes through the
  ordinary permission system like everything else) drives a checklist widget,
  separate from the transcript. A header button (checklist icon) appears only
  once something is on the list.
- **Workspace** — `/data/workspace`, separate from `/config`, is where Claude
  is told to put a file you'll want to download or reopen — a report, an
  export, a self-contained HTML page. The Workspace panel (folder icon) lists
  it with a direct link, refreshed after every reply.
- **Scheduled tasks** — add a name, a 5-field cron schedule, and a prompt from
  the Scheduled-tasks panel (clock icon); it fires unattended (every tool
  pre-approved — nobody is there to answer a prompt), resuming the same
  thread each time so a recurring check-in has genuine memory of the last
  one. A firing never touches the live chat — it shows up afterwards in
  Sessions, and reaches you through a Home Assistant notification plus a
  short summary in the panel.
- **Team panel** — a card per team member (name, role, free-text notes, last
  1:1 date) from the Team panel (people icon). Edit it yourself, or tell
  Claude about a 1:1/team conversation and it can log a dated note on your
  behalf with `team-notes`, the same Bash-driven pattern as `claude-tasks`.
  Nothing here is pre-seeded — it starts empty, and Claude is instructed to
  log only what you actually tell it, never health/HR/disciplinary detail.

See `plugins/productivity-tools/skills/productivity-tools/SKILL.md` for the
exact instructions Claude is given for all of these.

## Architecture

```
browser  ⇄  WebSocket  ⇄  server/index.js  (Node + @anthropic-ai/claude-agent-sdk)
                                 ├── ha-tools                      (states, services, traces, running work)
                                 ├── ha-tools timeline             (multi-entity event timeline)
                                 ├── ha-tools history / stats      (date-range history & stats)
                                 ├── ha-tools automation           (loaded config, YAML, traces)
                                 ├── ha-tools lovelace             (dashboards)
                                 ├── ha-tools logs                 (journald, via Supervisor)
                                 ├── claude-tasks                  (task-list widget, via /internal/tasks)
                                 ├── team-notes                    (Team panel notes, via /internal/team)
                                 ├── plugins/homeassistant-config  (skill + YAML validation hook)
                                 ├── plugins/productivity-tools    (task list / workspace / scheduler / team skill)
                                 ├── scheduler.js                  (persisted cron-like prompts, own SDK calls)
                                 ├── team.js                       (Team panel state, UI + CLI)
                                 └── Claude Code session store     (~/.claude/projects/*.jsonl)

HA Supervisor → Ingress proxy → port 7681 → chat UI (+ /workspace, /api/workspace)
```

## Credits

- [xionic/home-assistant-claude-code](https://github.com/xionic/home-assistant-claude-code) — the project this fork is based on: the chat engine, Home Assistant tool integration, task list, workspace, and scheduled-tasks mechanism are built on that work (AGPL-3.0, see [LICENSE](LICENSE) — this fork keeps the same license, as required)
- [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons) — the original Claude Terminal app and HA integration patterns the context generation is adapted from (MIT)
- [schoolboyqueue](https://github.com/schoolboyqueue/home-assistant-blueprints) — the `ha-ws-client` Go binary this app used to download; its commands were ported into `ha-tools` (MIT, see `claude-code-ui/scripts/commands/NOTICE`)
- [Anthropic](https://www.anthropic.com) — Claude and the Claude Agent SDK

## License

See [LICENSE](LICENSE). HA integration scripts in `claude-code-ui/scripts/` are
adapted from [heytcass/home-assistant-addons](https://github.com/heytcass/home-assistant-addons)
under the MIT license; original copyright remains with that project.
