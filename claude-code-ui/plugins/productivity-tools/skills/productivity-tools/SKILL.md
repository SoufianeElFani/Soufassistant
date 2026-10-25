---
name: productivity-tools
description: Use the task list for multi-step work, the /data/workspace folder for files worth keeping, the team-notes CLI for 1:1/team notes the user tells you about, and be aware of scheduled prompts. Use when a request has several distinct steps, when producing a file/report/dashboard the user will want to reopen, when the user mentions a 1:1 or team conversation worth logging, when turning meeting notes into action items, or when discussing recurring/scheduled prompts.
---

# Productivity tools

This app runs you (Claude Code, via the Claude Agent SDK) inside a Home
Assistant app rather than inside Claude's own hosted chat apps, so a few
things those apps give you for free have to be reconstructed locally. They
are not as capable as the hosted versions — say so plainly if the user asks
why something isn't exactly like it is elsewhere — but they cover the same
everyday need.

## Task list (`claude-tasks`)

A small CLI, run with Bash like any other tool here, that drives a checklist
widget in the chat UI (separate from the message transcript). Use it for a
request with **several distinct steps** the user would otherwise have to
infer from your prose — not for a single quick edit, and not as a substitute
for narrating what you're doing in your reply text; it's a supplement, not a
replacement.

```bash
claude-tasks set '[{"id":"1","description":"Read the current automation","status":"in_progress"},{"id":"2","description":"Add the new trigger","status":"pending"},{"id":"3","description":"Reload and verify","status":"pending"}]'
claude-tasks update 2 completed
claude-tasks update 3 in_progress
claude-tasks clear   # once the whole request is done — don't leave a stale list showing
```

Statuses: `pending`, `in_progress`, `completed`. Keep `id`s short and stable
across calls for the same task (so `update` edits the existing row instead of
creating a new one). `claude-tasks --help` has the full reference, and
`claude-tasks get` prints the current list if you need to check what's there.

Typical shape: `set` the whole plan once you know the steps, `update` each
one as you finish it, `clear` at the end. Don't bother for a one- or two-step
request — the list itself would be more overhead than the work.

## Workspace (`/data/workspace` by default)

The user can point the workspace at another folder from the Workspace panel
(e.g. one synced with their cloud drive); **the system prompt names the current
workspace folder — use that path**, and the `/data/workspace` examples below
then mean that folder. Its top-level folders are projects; in Cowork mode you
work inside one of them. Files written there open in the artifact viewer next
to the chat (HTML, Markdown, images/SVG, PDF, CSV, text).

A folder outside `/config` (the live Home Assistant configuration) for
anything the user will want to **download, reopen, or revisit** — a
generated report, an exported chart or image, a data dump, a self-contained
HTML page. Files there show up in the chat UI's Workspace panel (folder icon
in the header) with a direct link to open or download each one, and that
panel refreshes automatically after every reply.

- Write there instead of `/config` unless the user specifically asked you to
  edit a Home Assistant configuration file — `/config` is HA's config
  directory, not a general scratch space, and the Workspace panel only looks
  under `/data/workspace`.
- Feel free to create subfolders (e.g. `/data/workspace/reports/2026-10-24.html`).
- For a one-page report or a small dashboard, write **one self-contained
  `.html` file** — inline all CSS and JS, no external script/stylesheet
  references (there's nothing to load them from) — rather than several
  linked files. That's the closest local equivalent to a Claude "Artifact":
  a page the user can reopen from this Home Assistant instance and send to
  someone else on their network, but — unlike a hosted Artifact — it has no
  claude.ai URL and nothing to share outside this home. Say so if the user
  asks for a "shareable link"; what you can offer is a file, not a URL.
- It is **not** cleaned up automatically (unlike `/data/uploads`, which drops
  attachments after a week) — if a task was clearly one-off scratch work,
  mention that the user may want to delete the file later, or do it yourself
  if asked.

## Team / 1:1 tracker (`team-notes`)

A roster the user manages from the **Team panel** (people icon): one card per
team member with a name, role, free-text notes, and a "last 1:1" date they
can stamp themselves with one tap. You can also **log a note on their
behalf** when they tell you about a conversation, with the `team-notes` CLI
(same shape as `claude-tasks` — a Bash call, so it goes through the ordinary
permission system):

```bash
team-notes note Bernard "1:1: roadmap pricing still undecided, follow up next week"
team-notes note "Erkan" --1on1 "Discussed dev budget constraints, he'll scope a small POC"   # also stamps today as the last 1:1
team-notes list   # see the current roster and notes
```

- `<name>` matches an existing member case-insensitively, or creates a new
  one — you don't need to check first.
- Only log something the user **actually told you** — this is a factual log
  of a real conversation, never your own inference, summary embellishment, or
  something you'd guess they'd want recorded.
- Keep it to what's operationally useful (what was discussed, a follow-up, a
  concern raised) — never health, HR, disciplinary, or other sensitive
  personal detail about someone, even if the user mentions it in passing;
  leave that part out of the note entirely rather than writing a softened
  version of it.
- Don't reach for this unprompted mid-conversation about an unrelated topic —
  it's for when the user is clearly telling you about a 1:1/team interaction,
  or explicitly asks you to note something about someone on their team.

## Meeting notes → action items

When the user pastes in notes or a summary from a team meeting and asks for
action items (or it's clearly what they want), extract concrete action items
and put them on the **task list** (`claude-tasks`, above) with the owner
named in the description, e.g.:

```bash
claude-tasks set '[{"id":"1","description":"[Erkan] Relancer le fournisseur pour le devis","status":"pending"},{"id":"2","description":"[Soufiane] Envoyer le compte-rendu a l'\''equipe","status":"pending"}]'
```

This reuses the task list rather than a separate mechanism — it's still
per-conversation and not persisted as a standing project tracker, so say so
if the user wants something that survives across many meetings over time.

## Scheduled tasks

The user can define prompts that fire on a schedule (a cron-style expression)
from the Settings panel's **Scheduled** section — e.g. "every morning, check
if any entity has been unavailable for more than an hour and tell me." Each
firing is its own unattended turn: nobody is there to answer a permission
prompt or a question, so those runs have every ordinary tool allowed
automatically and treat an `AskUserQuestion` call as something to make your
best guess about rather than wait on. If you are asked to **set one up**,
tell the user to add it from the Settings panel themselves (name, schedule,
prompt) — you have no tool to create one on your own behalf, by design: an
unattended prompt that runs with every tool pre-approved is exactly the kind
of thing a person should set up deliberately, not something you reach for
mid-conversation.

A scheduled run's own conversation does not appear in the main chat (it would
be confusing for an unattended prompt to suddenly interject something into
whatever the user is chatting about) — it shows up in the **Sessions** panel
afterwards like any other conversation, and a short summary plus a Home
Assistant notification (if one is configured) are how the user actually finds
out what happened.
