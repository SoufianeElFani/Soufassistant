## 0.5.3
- **Fixed: Claude's follow-up after a background task was cut short.** When something Claude had left running in the background (watching a build, a long command) finished, the app considered the conversation over at that very moment — just as Claude was starting to read the result — so its first action was refused with "The user doesn't want to take this action right now", and nothing more happened. The app now waits for that short follow-up to finish.

## 0.5.2
- **Your phone's dictionary works in the message box.** The box used to tell the keyboard to switch off suggestions, autocorrect and spell-checking, so on a phone you typed without word suggestions or your own dictionary. They are now on, in whatever language you type (on a computer, misspelt words are underlined in your browser's languages).

## 0.5.1
- **The header panels behave as one.** Opening a panel closes the one already open, so they never pile up; **Esc** closes it; and opening a document — from the Workspace panel, the Artifacts menu or a card in the chat — closes any open panel. Before, the panel stayed on top of the document, and since the viewer moves the header (or covers it on a narrower window or a phone), the button that would have closed it was no longer there. A click inside the document closes the panel too.
- **The Artifacts menu is no longer empty.** It now lists the files of older replies as well — conversations from before 0.5.0, and files written by a shell command (a copy, a converted deck), which were never recorded — and "Recent in the workspace" is filled as soon as the app opens, instead of only after a reply or once the Workspace panel had been opened.

## 0.5.0
- **Several conversations at once.** Switching to another conversation, or starting a new one, no longer stops the one that is working: it carries on out of sight, and you can start something else meanwhile — two Cowork projects side by side, a Code fix while a deck is being built. The Sessions button shows how many other conversations are running; in the list they are marked with a pulsing dot, can be stopped from there (■), and a new conversation shows up at once, before its first reply. When one finishes out of sight a small notice says so, with an **Open** button. A permission prompt or question from a conversation that is not on screen still pops up, and says which conversation it comes from.
- **Chat, Code and Cowork conversations are told apart.** Every conversation in Sessions carries its mode — a coloured badge (Chat violet, Code teal, Cowork amber) and edge, plus the project for Cowork — and the chips above the list (All / Chat / Code / Cowork, with counts) show just one kind. Search follows the chosen chip.
- **An Artifacts menu.** A new header button (layers icon, with a count) lists every file the current conversation produced, newest first, plus the latest files in the workspace — one click opens it in the viewer. In the viewer, a drop-down at the top hops between this conversation's artifacts.
- **Fixed: artifacts disappearing.** The "Artifacts" card after a reply only existed on screen, so anything that redrew the conversation — the phone waking up and reconnecting, switching away and back — made it vanish. The app now remembers each reply's files with its conversation: the cards come back in place, after the reply that wrote them, and the menu above lists them. (Files deleted since are left out.)
- **PowerPoint, Word, Excel and PDF previews in the side pane.** `.pptx`, `.docx`, `.xlsx` (and `.ppt`, `.doc`, `.xls`, OpenDocument, RTF) now open as page images right beside the chat — no download — with "Open as PDF" for the converted version. PDFs open in the browser's own viewer where there is one, with a **Pages** button for the image view; in the Home Assistant phone app, which has no PDF viewer, they show as pages directly. The first preview of a file takes a little while (about 20 s for a 7-slide deck on a Home Assistant Green); after that it is instant until the file changes. The app image now includes LibreOffice and poppler for this — so it is larger to download — and Claude can use them too, e.g. to check a deck it built.
- **Fixed:** reopening the app did not put the mode switch back to the open conversation's mode.
- **Fixed:** an error that ended a conversation's run could fail to show in that conversation.
- **Sturdier saved settings.** The app's small state files (auto-continue, sessions, pins and titles, workspace, skills, schedules, tasks, team, notifications) are now written atomically, so a crash or a reader at the wrong moment can never leave one empty or half-written.

## 0.4.0
- **See and undo what Claude changed.** A new **Changes** view (Sessions → "Changes…", or ⋯ → Changes on any conversation) lists each message you sent and the files Claude changed while answering it, with a before/after of every edit. **"Restore files to before this message"** shows what would change, then puts those files back as they were — handy after a Code-mode edit of your Home Assistant config that went wrong. It covers changes made through Claude's file tools from this version on (not changes made by shell commands, nor older conversations).
- **Live previews of what Cowork builds.** When Claude builds something that needs a server (a small web app with an API, a dashboard with live data), it starts it on a port between 8100 and 8199 and it shows up under **Live previews** in the Workspace panel: click to use it right in the viewer, **Stop** to shut it down. It stays isolated from the app like any other artifact.
- **Conversations: search, rename, pin, duplicate, export.** The Sessions panel has a search box that looks through what was said in every conversation, not just titles. Each conversation's ⋯ menu can pin it to the top, rename it, **duplicate** it (to try another direction without losing the original), or **export** it as a Markdown file in the workspace (`Conversations/`).
- **Edit workspace files yourself.** Text files (Markdown, HTML, CSS/JS, JSON, YAML, CSV, SVG…) have an ✎ button in the viewer: edit, then Save (Ctrl+S). If Claude or the Drive sync changed the file meanwhile, you are asked before anything is overwritten. **+ File** in the Workspace panel creates a new one, and 🗑 deletes a file.
- **Updates no longer show up before they can be installed.** Releases are now built on a staging branch and only published to Home Assistant once their images exist, so "update failed — manifest unknown" (as happened briefly with 0.3.0) cannot recur.
- **Fixed:** clicking a project chip in the Workspace panel closed the panel.

## 0.3.0
- **Chat, Code and Cowork modes, like Claude Desktop.** A switch at the top of the screen (a menu next to the attachment button on a phone) picks how Claude works for your next message. **Chat** is a plain conversation like claude.ai: Claude can search and read the web but has no access to your files, Home Assistant or the workspace. **Code** is the app as before, with full Home Assistant access. **Cowork** works inside one project folder of your workspace: Claude creates, edits and tests things there — documents, web pages, small apps — and everything it writes shows up next to the chat. Writing anywhere else is blocked in Cowork, whatever the permission mode. Each conversation remembers its mode, so reopening it puts the switch back where it was.
- **Artifacts.** Pages, images, SVG, Markdown, PDF, CSV and text files that Claude creates now open in a viewer beside the chat (full screen on a phone), and each reply that created files ends with an "Artifacts" card listing them. Web pages run in an isolated sandbox, so a page cannot touch the app itself. You can turn off the automatic opening in Settings.
- **A real Workspace.** The Workspace panel now shows which folder the workspace is and lets you change it (for example to a folder synced with Google Drive). It lists the folder's projects (create one with "+ Project", click to filter, double-click or use the Cowork selector to make it the current project), and, when a sync log is present, when the folder last synced, the last error and any conflicting copies. Clicking a file opens it in the viewer; ↗ still opens it in a new tab.
- **Skills panel.** A new Skills button (star icon, or Settings → "Manage skills…" on a phone) lists every skill Claude can use: the ones from your claude.ai account (synced automatically), the ones built into the app, and your own. You can switch any of them off, read what a skill says, create, edit and delete your own, and export any skill as a .zip to upload it to your claude.ai account (claude.ai offers no way for an app to add a skill to your account directly; once uploaded there, it syncs back here by itself).

## 0.2.0
- **Plan limits in the Usage panel, like Claude Desktop.** The Usage panel now shows your claude.ai subscription meters: the 5-hour session limit, the weekly limit (and per-model weekly limits when your plan has them) and the monthly extra-usage budget when it is enabled — each as a bar with the percentage used and a "resets in 2 h 14 min · 14:40" countdown. The Usage button itself shows the current session % (turning amber at 75 % and red at 90 %), so you can see where you stand without opening anything. The numbers refresh after every reply and every few minutes, and fetching them spends no tokens. The panel keeps its second section with this conversation's own token counts. (Plans have no monthly token limit — the only monthly figure is the extra-usage budget.)

## 0.1.0
- **Renamed to Soufassistant.** This is now Soufiane's personal fork (`slug`/`name` in `config.yaml`), rebranded in blue-green/white, forked and extended from `xionic/home-assistant-claude-code` (AGPL-3.0 — see the README's Credits section). No `image:` key — every install builds from source until/unless CI is set up to publish one
- **Full-width desktop layout.** The app used to cap at 860px wide and center itself, which left the dark background showing as bars on anything wider than a phone. It now fills the whole window; message bubbles cap their own width on a wide screen instead, so replies stay readable without the app looking like a narrow card
- **Team panel.** A new Team panel (people icon) for a project/team lead: one card per teammate (name, role, free-text notes, a "last 1:1" stamp). Edit it directly, or tell Claude about a 1:1/team conversation and it can log a dated note itself via a new `team-notes` command — the same Bash-driven pattern as `claude-tasks`. Starts empty; Claude is instructed to log only what you actually tell it, never health/HR/disciplinary detail
- **Usage panel.** A new permanent header button (gauge icon) shows this session's running token counts and estimated cost live, instead of only via `/usage` on request. Session-scoped, not an Anthropic account-wide figure — subscription auth doesn't expose that
- **Task list.** A new `claude-tasks` command (alongside `ha-tools`) lets Claude drive a checklist widget — separate from the chat transcript — for a request with several distinct steps. A header button (checklist icon) shows it only once something is on the list, with each row's status (pending/in progress/done) at a glance
- **Workspace panel.** A new `/data/workspace` folder (separate from `/config`) for anything Claude produces that you'll want to download or reopen later — a report, an export, a self-contained HTML page. Files there show up in a new Workspace panel (folder icon) with a direct open/download link, refreshed automatically after every reply. This is this app's local, honest stand-in for a hosted "Artifact": a page saved to disk and reopenable from the browser, with no claude.ai-hosted URL and nothing to share outside this Home Assistant instance
- **Scheduled tasks.** A new Scheduled-tasks panel (clock icon) lets you define prompts that fire on a cron-style schedule — e.g. "every morning, check for unavailable entities and tell me." Each firing is its own unattended turn (every tool pre-approved, since nobody's there to answer a prompt) that continues the same thread each time it runs, so a recurring check genuinely remembers what it found last time. A firing never interrupts whatever you're chatting about — it's invisible to the live chat, shows up afterwards in Sessions, and reaches you through a Home Assistant notification plus a short summary in the panel itself
- These task-list/workspace/scheduled-tasks/team features are all local approximations of things Claude's own hosted apps (including "Cowork") offer natively — built on the same Claude Agent SDK this app already used, since there is no public way to embed those hosted products' own UI or backend inside a third-party page. Signing in with a Claude subscription (rather than setting an API key) was already supported before this change — see **Installation** in the README

## 1.17.0
- **Notifications.** Settings has a new **Notify** section: pick one of Home Assistant's `notify.*` services (e.g. your phone's companion app) and choose whether to be told when a reply finishes and/or when Claude needs you (a permission prompt or a question). The server sends the push, so it reaches a phone whose browser has gone to sleep; tapping it opens the app, and it clears itself once answered. Nothing is sent while a tab is open and visible. Each alert also fires a `claude_code_ui_attention` event for your own automations. Desktop tabs get a title badge and, if allowed, a browser notification.
- **Script traces, and "what is running right now".** Claude can now read the trace of a *script* the same way it always could an automation's — every trace command takes `--domain script` or just a qualified name like `script.nick_blind_creep_open` — including steps nested inside `parallel`, `choose` and `if`, which it can place back in the script (`sequence[1] › parallel branch 0 › sequence[2]`). Two new commands: **`ha-tools running`** lists every automation and script executing right now, how long each has been going, its run mode and when it last triggered — so a `mode: single` script that is quietly swallowing every new trigger is obvious at a glance — and **`ha-tools trace-stuck script.x`** shows which step an unfinished run is on and what it is waiting for (a delay and how much of it is left, a `wait_template` and whether it would pass right now, or another script it called, which it follows into)
- **One command-line tool, one name: `ha-tools`.** Claude's Home Assistant commands were spread over six names (`ha-ws-client`, `ha-history`, `ha-stats`, `ha-timeline`, `ha-lovelace`, `ha-logs`) that behaved differently; they are now one tool, so every command takes `--help` with examples and the same flags in any position, and `--json` means the same thing everywhere: one line, `{"success":…,"data":…}`, where `success` always agrees with the exit code (an invalid `config-check`, or a `reload --expect` that missed, now says `success:false` as well as exiting 1). `ha-ws-client` used to be a separate downloaded program; it is built in now and the app downloads nothing for it. **This is a clean break — the old names are gone:** `ha-history sensor.x` is `ha-tools history sensor.x`, and so on for `stats`, `timeline`, `lovelace` and `logs`. Four duplicate commands were removed (`trace-debug` is `trace`, `history-full` is `history --full`, `watch` is `monitor`, `states-json` is `states-filter '*'`). What changes in practice:
  - `history`, `stats` and `timeline` accept either a date range or a plain "last N hours" (`ha-tools history sensor.x 6`)
  - **JSON shapes changed:** `history` and `stats` used to print Home Assistant's raw object by default and with `--format json` — the default is now readable text and `--json` gives the envelope (the raw points are in `data`); `timeline --format json` and `automation list` use the same envelope (their zone moved to `timezone`, their rows into `data`)
  - a command refuses an option it would ignore (`--max-items`, `--from`/`--to`, `--show-age` exist only where they do something), and `--no-timestamps`, which nothing honoured, is gone
  - `--compact` never drops fields, and the help marks the commands that change Home Assistant (`call`, `fire-event`, `reload`, dashboard `save`/`create`/`delete`)
  - `trace-watch` now waits 100 seconds by default instead of 15 minutes — a command that runs in the foreground is cut off after about two minutes, so the longer wait never got to report. Pass `--timeout` and run it in the background for a longer one
  - fixed along the way: the "latest" trace was the *oldest* stored one, trace timelines and variables came out in random order, `trace-actions` found nothing for a script, and `stats-multi` would occasionally crash


## 1.16.0
- **Claude Haiku 5.5 is here** — it takes Haiku 4.5's place in the menu; if you'd already picked Haiku 4.5 it keeps working and still shows by name
- **Updated to the current Claude Code engine** (Agent SDK 0.3.302, from 0.3.284)
- **A background agent can now deliver its report after Claude's own reply has already finished.** When Claude spawned a background subagent and moved on, a real conversation could end up where the subagent's hand-off and every tool call after it were silently refused — reported as if the user had declined, with no indication anything had gone wrong. The underlying cause: the app was telling the engine the turn was a one-shot exchange, so once Claude's own reply ended, the engine closed its side of the connection to the background work — even though it was still running. The app now keeps that connection open until everything it started has actually finished, in every permission mode
- **A background task finishing no longer shows up as a stray message from "you".** The system's own note that a background task completed could appear in the chat as if you had typed it — confusing on its own, and worse if the one ending with "the task was not delivered" looked like your own words. It's now a plain "Background agent finished: …" line, and a delivered report is clearly labelled as coming from the background agent, not from you
- **A "background task running" note appears above the message box** while a subagent or a backgrounded command is still finishing up, and the app log no longer claims the conversation is stuck quiet while that's all that's happening
- **A permission prompt survives closing the tab it appeared on.** Backgrounding the app or losing the connection while a tool call is waiting on you used to mean it gave up and refused that call; it now waits, exactly like a question Claude asks you, and any tab you open afterwards can still answer it. The one exception: an unattended auto-continue resume with nobody around will now wait for someone to open the app, rather than refusing and ending the run on its own

## 1.15.0
- **Claude Sonnet 5.5 is here** — it takes Sonnet 5's place in the menu; if you'd already picked Sonnet 5 it keeps working and still shows by name
- The Home Assistant suggestions subagent now runs on Sonnet 5.5
- **Updated to the current Claude Code engine** (Agent SDK 0.3.284, from 0.3.282)

## 1.14.0
- **The diagnostic endpoints now require a Home Assistant admin token.** With **Debug mode** switched on, the app exposed a set of `/diag` endpoints that anything else on Home Assistant's internal app network could call with no credential at all — including one that runs a prompt with every tool auto-approved, and others that hand back your conversation transcripts. They now need a long-lived access token belonging to an **admin** user (`Authorization: Bearer <token>`), checked against Home Assistant itself, and refuse everything else. Nothing on your home network could ever reach them, and Debug mode is off by default, so a normal install was never exposed — but if you have it on, or you script `/diag`, you now need the header

## 1.13.0
- **Claude Opus 5.5 is here** — Anthropic's new default Opus, with a 1M-token context window. It takes Opus 5's place in the menu; if you'd already picked Opus 5 it keeps working and still shows by name
- **Updated to the current Claude Code engine** (Agent SDK 0.3.282, from 0.3.274)

## 1.12.0
- **Claude Fable 5.1 is now in the model picker** — Anthropic's most capable model, for the hardest and longest-running jobs. It sits above Opus, and costs accordingly, so it's there when you want it rather than as the default
- **The model list now follows Claude Code instead of going stale.** It used to be a list written into this app by hand, which meant every new Anthropic model needed an app update before you could pick it — and it would happily offer you models your account can't actually run. The app now asks Claude Code which models *your* account may use and builds the menu from that, with the same names and descriptions you'd see in the terminal. A model you'd already picked is kept, by name, even if it's no longer on the list
- **Updated to the current Claude Code engine** (Agent SDK 0.3.274, from 0.3.237 — about two months of fixes and model updates)
- **Your claude.ai connectors no longer load into Home Assistant.** The newer engine brings the Gmail, Drive and Calendar connectors from your claude.ai account into every session automatically. That's welcome in a terminal and wrong here: this app is for your house, their tools would have appeared with no permission prompt at all — not even in Ask mode — and reached your mailbox. They're now switched off for this app; nothing else about your claude.ai account changes

## 1.11.0
- **The message box no longer sits below the bottom of the screen on a phone browser.** Opened in Safari or Chrome rather than the Home Assistant app, the chat was laid out against the full height of the page Home Assistant gives it — which, while the browser's address bar is showing, is taller than the screen. The message box and send button fell off the bottom, nothing you could swipe would bring them back, and dragging Home Assistant's own toolbar to reach them pushed this app's header off the top instead. It now measures how much of the screen it can actually see and fits itself to that, following along as the address bar comes and goes. Permission prompts and questions do the same, so their buttons can't end up out of reach either — and the on-screen keyboard no longer covers what you're typing. Home Assistant's own toolbar stays put too: if its page gets scrolled and the menu button disappears off the top, the app puts it back rather than quietly spreading into the gap
- **Switching to another chat while Claude is working now asks first.** Picking a past conversation from Sessions silently stopped the turn in progress, which looked exactly like the reply having been lost. It now says what will happen and waits for you — and the same warning covers the new-chat button and `/new`, which could previously slip past it
- **`ha-tools config-check` catches the errors it used to miss.** It reported "valid" for a config Home Assistant would load *without* the entity you had just written: a bad option in a `template:` or platform entry doesn't stop the config loading, it just makes Home Assistant drop that entity and carry on — and the endpoint the check relied on never mentioned it. Claude followed the tool's own advice, reloaded, and moved on believing a blind was set up that did not exist. The check now reads what Home Assistant logs *while it is checking*, names the file, line and key, and fails
- **`ha-tools reload` verifies the reload instead of the phone call.** It used to report success whenever the request went through. It now surfaces the same errors, and `--expect <entity_id>` will fail if the entity you just wrote doesn't actually appear

## 1.10.0
- **Updated to the current Claude Code engine** (Agent SDK 0.3.237, from 0.3.165 — about two and a half months of fixes and model updates). Nothing changes in how the app is used
- **The slash-command menu only lists commands that do something here.** Commands that exist to control a terminal — `/exit`, `/statusline` and the like — were being offered in the browser, where there is no terminal to exit; they are now filtered out
- **Claude can ask you questions properly again.** When it needs a decision it now puts the options on screen — one question per screen, with an "Other" box for when none of them fit — instead of burying the question in a paragraph of text. It had been switched off because the question never actually reached the browser; it's now intercepted before it runs, so the answer reliably gets back to Claude. A question **waits indefinitely** — backgrounding the app or letting your phone sleep no longer answers it "closed without answering" behind your back; it's still there, on the strip above the message box, whenever you come back
- **A question or permission prompt can be set aside without answering it.** Close it with ✕ and the chat is yours to read; a bar above the message box keeps the request and takes you back to it when you've worked out the answer. Nothing is decided for you, and the turn stays paused
- **Usage limits now say what happens next, where you'll actually see it — and actually get detected.** A limit can throw its own error *after* falsely reporting the turn as successful, which was slipping past detection entirely: no notice, nothing scheduled, and the conversation wrongly marked stale (so the next message started a new chat instead of continuing it — nothing was lost, but it looked like it). The chat now gets a note at the exact point it stopped — when the limit resets, and whether anything is going to pick it up — and if auto-continue is off, the bar above the message box offers to switch it on for *this* limit rather than only the next one
- **Runs of tool calls fold away as they happen**, not once the turn ends — a long turn no longer unfurls into a wall of tool calls before tidying itself up. The folded row names the call that's running right now, and afterwards which tools ran and whether any failed
- **↑ / ↓ arrows to step through your own messages** in a long chat, at the top and bottom right. They appear when you scroll and fade again when you stop
- **Fixed the controls scrolling out of reach on a mobile browser** — scrolling the chat past its end no longer drags the Home Assistant page (and this app's own header) away with it
- **Claude can read your Home Assistant logs again.** Home Assistant 2025.11 stopped writing `home-assistant.log` and removed the API this app used to read it, so the "Recent Errors" section of Claude's startup context had quietly been showing `404: Not Found` instead of your actual errors. It now reads the real log
- **New `ha-logs` tool** — Claude can pull the Core, Supervisor, host, or any app's log on demand (`ha-logs --errors`, `ha-logs self`, `ha-logs app_core_mosquitto`), so "why did my automation fail last night?" can actually be answered. Previously it had no way to reach the logs at all
- A failed log fetch now says so plainly in Claude's context rather than passing the error text off as log content
- **Claude can now debug automations properly.** New `ha-timeline` merges several entities' state changes onto one clock (`ha-timeline light.hall binary_sensor.stairs --days 3 --between 22:00-07:00`) — the "what happened, in what order?" question behind most automation timing bugs, which previously meant Claude writing a throwaway script every time
- **Safe automation edits end to end** — `ha-tools config-check` checks your config's syntax and structure before a reload (and fails loudly if it won't load at all), `ha-tools reload` applies it without restarting HA, and `ha-tools automation show` / `yaml` show what HA actually has loaded versus what's in your `automations.yaml`
- **`ha-tools trace-watch` waits for an automation to genuinely fire** and reports what happened — including runs that its conditions blocked, which is usually the answer when "it just doesn't work". Previously the only way to test a changed trigger was to physically trigger it and hope Claude was still watching
- **Times are consistent everywhere now.** Every helper prints your Home Assistant timezone with an explicit offset (`2026-08-12 23:27:42+01:00`) instead of a mix of raw epoch numbers and UTC — Claude was converting between three different formats by hand, one arithmetic slip away from quietly telling you the wrong time
- **All of Claude's Home Assistant helpers are now one `ha-tools` command** — `ha-tools history / stats / lovelace / logs`, plus `ha-tools ws` for entity states and service calls. `ha-tools --help` lists everything in one place, so Claude can check what it has instead of guessing. Nothing you or Claude already use changes: `ha-history`, `ha-stats`, `ha-lovelace` and `ha-logs` still work exactly as before, as names for the same command

## 1.9.3
- Model picker updated to the current Claude models: **Opus 5** and **Sonnet 5** replace Opus 4.8 and Sonnet 4.6 (Haiku 4.5 is unchanged). If you'd already picked an older model it keeps working and still shows by name — switch in **Settings → Model** to move up
- The Home Assistant suggestions subagent now runs on Sonnet 5

## 1.9.2
- Wording brought in line with Home Assistant's current terminology — add-ons are **apps**, and the install steps in the README now match the real path (**Settings → Apps → Install app → ⋮ → Repositories**). Thanks to Sir_Goodenough on the community forum for flagging it
- Folder mappings updated to Home Assistant's current names (`homeassistant_config` and `all_app_configs`), replacing the deprecated `config` / `all_addon_configs`. Nothing moves inside the app — Home Assistant's config stays at `/config` and other apps' configs at `/addon_configs`. **Now requires Supervisor 2026.07 or newer**
- Fixed the chat jumping to the bottom while you were reading it — a background reconnect replayed the whole conversation, which lost your scroll position and dragged the view down
- Removed the scroll-to-bottom animation when the chat loads; it now opens at the bottom instantly instead of visibly racing down from the top

## 1.9.1
- Composer redesigned so the attach and send buttons sit on their own row below the text — the typing area now spans the full width, like the Claude app
- Fixed attaching **multiple** photos silently failing on mobile (files the picker reported as zero-size were being dropped)
- Attached images are now downscaled before sending, so photos upload far faster and many fit at once (also normalizes formats like HEIC)

## 1.9.0
- **Attach images, photos, and files** to a message — via the paperclip button, pasting a screenshot, or drag-and-drop. Claude reads them (it sees images/PDFs and reads text/code). On mobile the picker offers the camera and photo library

## 1.8.3
- Fixed: after re-authenticating in a long chat, typing "continue" started a new empty session instead of resuming — an auth failure no longer discards the current session

## 1.8.2
- Fixed the sign-in code box vanishing when you switch to the browser and back during (re-)authentication — an in-progress login is now restored on reconnect, and login success is detected only when fresh credentials are written

## 1.8.1
- When your Claude sign-in expires, the chat now shows a "Session expired" screen with a Sign-in button to re-authenticate, instead of just failing with an error

## 1.8.0
- ESPHome build dependencies (patch, compilers, etc.) now install automatically when ESPHome is enabled and reinstall after app upgrades, so compiles keep working without manual apt installs

## 1.7.2
- Fixed the mobile header jittering up and down when scrolling near the bottom of a long chat

## 1.7.1
- App option descriptions trimmed to one or two sentences

## 1.7.0
- **Fixed a host-crash risk from ESPHome builds:** ESPHome/PlatformIO write multi-GB, tens-of-thousands-of-files build caches under `/data`, which the nightly backup was tarring — the tiny-file IO storm starved the host watchdog and hard-reset the Pi. Those caches are now **excluded from backups** (`backup_exclude`), and compiles run at **idle CPU/IO priority** (`nice`/`ionice`) so a build can't starve the host. Caches still persist under `/data` for fast rebuilds
- **Copy button on code blocks and tool output** — hover (or tap on mobile) any code block or tool result to copy it
- **Auto-hiding header on mobile** — on small screens the top bar slides away as you scroll down a long chat and reappears the moment you scroll up, so you don't have to scroll to the very top to reach settings. On larger screens it stays pinned

## 1.6.0
- **ESPHome support** (new `enable_esphome` option, off by default): bundles the ESPHome CLI so Claude can validate, compile, OTA-flash, and stream device logs for boards you manage with the ESPHome app — working directly on that app's config folder. Ships as an opt-in capability module (its own skill + the `esphome` tool); the toolchain installs in the background on first enable, and compilers download on the first build
- The app now runs on a **Debian base** (was Alpine) — required so the ESPHome/PlatformIO compilers can run. No user-visible change beyond that

## 1.5.2
- Fixed: **Plan** can now be set as the default permission mode in the app options. It was offered in the app's dropdown but rejected by the options schema, so you could pick it per-chat but never default to it

## 1.5.1
- Entity links now open **inside** Home Assistant instead of bouncing you out to a web page — clicking an entity opens its usual more-info dialog (a switch gets its toggle, a thermostat its controls, a sensor its history), and automations/dashboards navigate the app without a page reload

## 1.5.0
- **"Always" on permission prompts** — Allow now only covers that one call; the new **Always** button makes the decision stick to the tool so it stops asking (uses the SDK's own suggested permission rules, shown on the prompt so you can see exactly what you're allowing)
- **Home Assistant deep links in replies** — entity ids Claude mentions become links: automations open their editor, other entities open their history. Links open the real HA page outside the app's frame, and only real entities are linked (YAML blocks are left alone)

## 1.4.0
- **Auto-continue on usage limit** (new Settings toggle): when you're signed in with a Claude subscription and hit the 5-hour usage limit mid-response, the app can automatically resume the conversation once the limit resets — no need to come back and nudge it. A banner shows the countdown (with a Cancel), the scheduled resume survives an app/HA restart, and it's off by default. Only offered on subscription sign-in (an API key has no reset time to schedule against); the 7-day limit is not auto-resumed.

## 1.3.1
- Chat no longer auto-scrolls to the bottom when you've scrolled up to read or copy something — incoming responses only pull the view down if you're already at the bottom (sending a prompt re-pins you there)

## 1.3.0
- **Plan mode** added to the permission dropdown — Claude researches read-only and proposes a plan before making changes; you approve the plan to proceed
- **Reasoning effort** selector in Settings (Low → Max) so you can trade speed for depth per chat
- **Message timestamps** — a compact time now appears on each message (live and after a reload)
- **Working indicator shows elapsed seconds** on long turns, so a quiet stretch (deep thinking, a slow tool, or compaction) reads as "still going" rather than stuck
- **Context warning** — the token indicator turns amber, then red with a "run /compact" nudge as the window fills
- **New-dashboard support** — `ha-lovelace create`/`delete` let Claude make and remove Lovelace dashboards (previously it could only edit existing ones)
- **/compact no longer clutters the chat** — the slash-command echo (`<command-name>…`) is filtered from the transcript
- **App logging** — query start/end (with duration), compaction, errors, and a stall watchdog now log to the app log; a new **Verbose logging** option adds per-event detail for diagnosing hangs

## 1.2.0
- New **Allow access to other app configs** option (off by default): when enabled, Claude can read and edit other apps' config folders under `/addon_configs`; while disabled, any tool call touching that path is blocked at the tool layer (enforced in every permission mode, including Auto)

## 1.1.0
- AskUserQuestion no longer fails with a red X: the tool is disabled at the SDK level so Claude asks questions in conversational text instead
- Context indicator now shows real, cache-inclusive usage and **% toward auto-compaction** (from `query.getContextUsage()`) rather than an undercounted input+output figure
- Compaction is now visible — a "Context compacted" divider appears when `/compact` or auto-compaction runs, and the context indicator updates immediately
- CLAUDE.md is now user-editable and persistent: generated HA context moves to `~/.claude/ha-context.md` (refreshed each start) and is `@`-imported by a `~/.claude/CLAUDE.md` that the app seeds once and never overwrites

## 1.0.4
- Context token indicator above the input box shows how many tokens the next send will consume and what % of the model's context window that represents

## 1.0.3
- /usage now shows token counts (input, output, cache read/write, total) and explains what turns means

## 1.0.2
- Typed-but-not-submitted text is preserved when navigating away and back

## 1.0.1
- Markdown rendering in chat responses — tables, code blocks, headers, bold/italic, lists, and inline code now display correctly

## 1.0.0
- Multi-session support, find-in-chat, model/permission persistence, and UX improvements
