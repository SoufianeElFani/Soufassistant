/*
 * Claude Code UI — Home Assistant app.
 *
 * A browser-based Claude Code interface: an Express + WebSocket server that
 * drives the Claude Agent SDK and streams the result to a chat UI, with direct
 * access to the Home Assistant configuration and live state.
 *
 * This file is the composition root and nothing else — it wires the modules in
 * server/lib together, loads the persisted state, and listens. Anything with
 * behaviour of its own lives in a module; if you are looking for something:
 *
 *   config.js         every environment variable and derived path
 *   state.js          the mutable values that span the whole process
 *   broadcast.js      connected sockets, send() and broadcast()
 *   auth.js           credentials and the device-login flow
 *   sessions.js       Claude Code's on-disk transcript store
 *   dialogs.js        AskUserQuestion interception
 *   permissions.js    the /addon_configs guard and canUseTool
 *   auto-continue.js  resuming after a usage limit resets
 *   run-query.js      one turn: SDK options in, wire events out
 *   ws-protocol.js    what a browser is told, and what it may ask for
 *   diag.js           the /diag routes (debug option only)
 *   ha-auth.js        the HA admin-token guard those routes sit behind
 *   uploads.js        attachments
 *   ha-links.js       entity/automation link targets
 *   notify.js         pushing "needs attention" through Home Assistant
 *   mcp.js            stripping persisted MCP servers at startup
 *   tasks.js          the task-list widget's state, fed by the claude-tasks CLI
 *   workspace.js      the /data/workspace scratch folder Claude writes files to
 *   scheduler.js      persisted cron-like prompts, ticked and fired unattended
 *   team.js            the Team panel's state, fed by the UI and the team-notes CLI
 *   internal.js       the loopback guard in front of /internal/* routes
 */
import { createServer } from 'http';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';

import {
  PORT, WORK_DIR, PLUGIN_DIR, FRONTEND_DIR, UPLOAD_DIR, DEBUG_MODE,
  ALLOW_ADDON_CONFIGS, ENABLE_ESPHOME, ESPHOME_CONFIG_DIR, VERBOSE_LOGGING, WORKSPACE_DIR,
} from './lib/config.js';
import { isSubscriptionAuth } from './lib/auth.js';
import { loadActive } from './lib/sessions.js';
import { sanitizeMcpState } from './lib/mcp.js';
import { ensureUploadDir, cleanupUploads } from './lib/uploads.js';
import { ensureWorkspaceDir, listWorkspaceEntries } from './lib/workspace.js';
import { requireLoopback } from './lib/internal.js';
import * as tasks from './lib/tasks.js';
import * as scheduler from './lib/scheduler.js';
import * as team from './lib/team.js';
import { refreshHaLinks } from './lib/ha-links.js';
import { registerDiagRoutes } from './lib/diag.js';
import { attach } from './lib/ws-protocol.js';
import { runQuery } from './lib/run-query.js';
import * as autoContinue from './lib/auto-continue.js';
import * as notifier from './lib/notify.js';

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(FRONTEND_DIR));

ensureUploadDir();
app.use('/uploads', express.static(UPLOAD_DIR));

ensureWorkspaceDir();
// Read-only: files land here only because Claude (or the user, via Bash/Write)
// put them there, same trust level as everything else under /config.
app.use('/workspace', express.static(WORKSPACE_DIR));
app.get('/api/workspace', (_req, res) => res.json({ entries: listWorkspaceEntries() }));

// The claude-tasks CLI (a Bash tool call, so it goes through the ordinary
// permission system) posts here to update the task-list widget. Loopback-only
// — see lib/internal.js for why that is a real boundary, not just an honor code.
app.get('/internal/tasks', requireLoopback, (_req, res) => res.json({ tasks: tasks.taskState.tasks }));
app.post('/internal/tasks', express.json({ limit: '256kb' }), requireLoopback, (req, res) => {
  try {
    const body = req.body || {};
    if (body.action === 'clear') {
      tasks.clearTasks();
    } else if (body.action === 'update') {
      tasks.updateTask(body.id, body.status, body.description);
    } else if (Array.isArray(body.tasks)) {
      tasks.setTasks(body.tasks);
    } else {
      return res.status(400).json({ error: 'expected {action:"clear"} | {action:"update", id, status} | {tasks:[...]}' });
    }
    res.json({ ok: true, tasks: tasks.taskState.tasks });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The team-notes CLI (also a Bash tool call) logs a dated note on a team
// member from this loopback endpoint — same boundary as /internal/tasks.
// The Team panel itself edits the same state over the WebSocket protocol
// (ws-protocol.js's set_team_member/delete_team_member), both converging on
// server/lib/team.js.
app.get('/internal/team', requireLoopback, (_req, res) => res.json({ members: team.list() }));
app.post('/internal/team', express.json({ limit: '256kb' }), requireLoopback, (req, res) => {
  try {
    const body = req.body || {};
    if (body.action === 'note') {
      team.addNote(body.member, body.note, { touchOneOnOne: !!body.touchOneOnOne });
    } else {
      return res.status(400).json({ error: 'expected {action:"note", member, note, touchOneOnOne?}' });
    }
    res.json({ ok: true, members: team.list() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Only when the `debug` app option is on. Otherwise these routes do not exist
// and the requests fall through to the SPA below.
if (DEBUG_MODE) registerDiagRoutes(app);

// Single-page app: every other path serves the shell, so ingress deep links work.
app.get('*', (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

attach(wss);

// ── Startup ──────────────────────────────────────────────────────────────────
// run-query imports auto-continue (to schedule a resume when a limit stops a
// run); auto-continue needs to call back into run-query when that resume fires.
// Injecting it here keeps the module graph one-way.
autoContinue.setResumeRunner(runQuery);

sanitizeMcpState();
loadActive();
autoContinue.load();
notifier.load();
tasks.load();
scheduler.load();
team.load();
cleanupUploads();          // drop attachments older than a week
refreshHaLinks();          // populate entity/automation link targets
autoContinue.rearmOnBoot();
scheduler.start();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code UI listening on port ${PORT}`);
  console.log(`  Working dir: ${WORK_DIR}`);
  console.log(`  Workspace:   ${WORKSPACE_DIR}`);
  console.log(`  Plugin dir:  ${PLUGIN_DIR}`);
  console.log(`  /addon_configs access: ${ALLOW_ADDON_CONFIGS ? 'enabled' : 'blocked'}`);
  console.log(`  ESPHome capability: ${ENABLE_ESPHOME ? `on (${ESPHOME_CONFIG_DIR || 'no config dir'})` : 'off'}`);
  console.log(`  Auto-continue on limit: ${autoContinue.autoContinue.enabled ? 'on' : 'off'} ` +
    `(${isSubscriptionAuth() ? 'subscription' : 'api-key'} auth)`);
  console.log(`  Verbose logging: ${VERBOSE_LOGGING ? 'on' : 'off'}`);
});
