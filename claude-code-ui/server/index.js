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
import {
  ensureWorkspaceDir, listWorkspaceEntries, loadWorkspaceConfig, workspaceRoot, resolveInWorkspace,
} from './lib/workspace.js';
import { previewDocument, renderedFile, previewCapabilities } from './lib/doc-preview.js';
import { loadSkillsConfig, skillDirFor, importSkills, bundleDirs, listSkills } from './lib/skills.js';
import { documentModel, saveDocument, saveBinary } from './lib/office-edit.js';
import { broadcast } from './lib/broadcast.js';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { loadSessionModes } from './lib/modes.js';
import { zipDirectory, makeZip, readZip } from './lib/zip.js';
import { loadSessionMeta } from './lib/session-tools.js';
import { previewProxy } from './lib/previews.js';
import { requireLoopback } from './lib/internal.js';
import * as tasks from './lib/tasks.js';
import * as scheduler from './lib/scheduler.js';
import * as team from './lib/team.js';
import { refreshHaLinks } from './lib/ha-links.js';
import { registerDiagRoutes } from './lib/diag.js';
import { transcribe, sttAvailable } from './lib/stt.js';
import { synthesize, ttsEngine } from './lib/tts.js';
import { attach } from './lib/ws-protocol.js';
import { runQuery } from './lib/run-query.js';
import * as autoContinue from './lib/auto-continue.js';
import * as notifier from './lib/notify.js';
import * as planUsage from './lib/plan-usage.js';

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(FRONTEND_DIR));

ensureUploadDir();
app.use('/uploads', express.static(UPLOAD_DIR));

loadWorkspaceConfig();
ensureWorkspaceDir();
// Read-only: files land here only because Claude (or the user, via Bash/Write)
// put them there, same trust level as everything else under /config. The root
// is chosen in the Workspace panel, so the static handler follows it.
let wsStatic = { root: null, handler: null };
app.use('/workspace', (req, res, next) => {
  const root = workspaceRoot();
  if (wsStatic.root !== root) wsStatic = { root, handler: express.static(root, { dotfiles: 'deny' }) };
  // Artifacts render in a sandboxed iframe; also stop a workspace page from
  // framing the app or being treated as same-origin script.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  wsStatic.handler(req, res, next);
});
app.get('/api/workspace', (_req, res) => res.json({ root: workspaceRoot(), entries: listWorkspaceEntries() }));

// Document previews (doc-preview.js): a PDF or Office file in the workspace as
// page images for the artifact viewer. The first call renders (can take a
// while for a big deck); later ones are served from the cache.
app.get('/api/preview/capabilities', (_req, res) => res.json(previewCapabilities()));
app.get('/api/preview', async (req, res) => {
  const abs = resolveInWorkspace(String(req.query.path || ''));
  if (!abs || abs === workspaceRoot()) return res.status(400).json({ ok: false, error: 'Bad path.' });
  res.json(await previewDocument(abs));
});
app.get('/api/preview/:key/:name', (req, res) => {
  const file = renderedFile(req.params.key, req.params.name);
  if (!file) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(file);
});

// Editing documents in the viewer (office-edit.js): the text of a Word or
// PowerPoint file, the cells of an Excel one, a PDF's page order; and binary
// writes for the image editor. Same rules as the text editor: never a
// dot-path, never outside the workspace, a stale mtime is a conflict.
function editTarget(rel) {
  rel = String(rel || '');
  if (!rel || rel.split('/').some((seg) => seg.startsWith('.'))) return null;
  const abs = resolveInWorkspace(rel);
  return abs && abs !== workspaceRoot() ? abs : null;
}
const workspaceChanged = () => broadcast({ type: 'workspace', entries: listWorkspaceEntries() });
app.get('/api/doc', async (req, res) => {
  const abs = editTarget(req.query.path);
  if (!abs) return res.status(400).json({ ok: false, error: 'Bad path.' });
  res.json(await documentModel(abs));
});
app.post('/api/doc', express.json({ limit: '8mb' }), async (req, res) => {
  const abs = editTarget(req.body?.path);
  if (!abs) return res.status(400).json({ ok: false, error: 'Bad path.' });
  const r = await saveDocument(abs, req.body);
  if (r.ok) workspaceChanged();
  res.json(r);
});
const IMAGE_SAVE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
app.post('/api/workspace-binary', express.raw({ type: 'application/octet-stream', limit: '30mb' }), (req, res) => {
  const rel = String(req.query.path || '');
  const abs = editTarget(rel);
  if (!abs || !IMAGE_SAVE_EXT.has(path.extname(abs).slice(1).toLowerCase())) return res.status(400).json({ ok: false, error: 'Only images can be saved this way.' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ ok: false, error: 'Empty file.' });
  if (req.query.create === '1' && existsSync(abs)) return res.json({ ok: false, error: 'A file with that name already exists.' });
  try {
    const r = saveBinary(abs, req.body, { mtime: Number(req.query.mtime) || null, force: req.query.force === '1' });
    if (r.ok) workspaceChanged();
    res.json({ ...r, path: rel });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Live previews of an app running in a Cowork project (previews.js): only the
// preview port range, only to localhost.
// Exact match (a regex): Express's non-strict routing would also send
// "/preview/8100/" here, and the redirect would loop.
app.all(/^\/preview\/(\d+)$/, (req, res) => res.redirect(301, `${req.headers['x-ingress-path'] || ''}/preview/${req.params[0]}/`));
app.all('/preview/:port/*', previewProxy);

// A skill folder as a .zip — to upload to claude.ai (Settings → Capabilities),
// since there is no public API to push a skill to an account.
// Voice (the spoken call, dictation): speech to text via the Whisper app,
// text to speech via Home Assistant — for browsers without their own.
app.get('/api/voice/status', async (_req, res) => {
  const [stt, tts] = await Promise.all([sttAvailable(), ttsEngine()]);
  res.json({ stt, tts: !!tts });
});
app.post('/api/stt', express.raw({ type: 'application/octet-stream', limit: '6mb' }), async (req, res) => {
  try {
    res.json({ text: await transcribe(req.body, { language: String(req.query.lang || 'fr') }) });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.post('/api/tts', express.json({ limit: '16kb' }), async (req, res) => {
  try {
    const { body, contentType } = await synthesize(req.body?.text, req.body?.lang);
    res.set('Content-Type', contentType).set('Cache-Control', 'no-store').send(body);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get('/api/skills/export', (req, res) => {
  const found = typeof req.query.id === 'string' ? skillDirFor(req.query.id) : null;
  if (!found) return res.status(404).json({ error: 'No such skill' });
  try {
    const zip = zipDirectory(found.dir, found.folder);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${found.folder}.zip"`);
    res.end(zip);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Sharing skills: import a .zip (or a SKILL.md), a bundle of several, and a
// shared folder in the workspace — which the Drive sync turns into a shared
// Drive folder: drop a .zip there and it shows up under "Import" everywhere.
const skillsChanged = () => broadcast({ type: 'skills', ...listSkills() });
function sharedSkillsDir() {
  const root = workspaceRoot();
  return existsSync(path.join(root, '01_Templates')) ? path.join(root, '01_Templates', 'Skills') : path.join(root, 'Skills');
}
const relToRoot = (abs) => path.relative(workspaceRoot(), abs).split(path.sep).join('/');
app.post('/api/skills/import', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
  const r = importSkills(req.body, { replace: req.query.replace === '1', readZip });
  if (r.installed?.length) skillsChanged();
  res.json(r);
});
app.get('/api/skills/shared', (_req, res) => {
  const dir = sharedSkillsDir();
  let files = [];
  try {
    files = readdirSync(dir).filter((n) => /\.(zip|skill)$/i.test(n) && !n.startsWith('.'))
      .map((n) => ({ name: n, path: relToRoot(path.join(dir, n)), mtime: statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { /* no shared folder yet */ }
  res.json({ dir: relToRoot(dir), files });
});
app.post('/api/skills/import-shared', express.json({ limit: '16kb' }), (req, res) => {
  const abs = editTarget(req.body?.path);
  if (!abs || !abs.startsWith(sharedSkillsDir() + path.sep)) return res.status(400).json({ ok: false, error: 'Bad path.' });
  let buf;
  try { buf = readFileSync(abs); } catch { return res.json({ ok: false, error: 'File not found.' }); }
  const r = importSkills(buf, { replace: !!req.body.replace, readZip });
  if (r.installed?.length) skillsChanged();
  res.json(r);
});
const idsOf = (q) => (typeof q === 'string' && q ? q.split(',') : null);
app.get('/api/skills/bundle', (req, res) => {
  const dirs = bundleDirs(idsOf(req.query.ids));
  if (!dirs.length) return res.status(404).json({ error: 'No skills to export' });
  try {
    const files = dirs.flatMap((d) => readZip(zipDirectory(d.dir, d.folder)));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="skills-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.end(makeZip(files, { deflate: true }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// One .zip per skill (the shape claude.ai's upload wants) into the shared folder.
app.post('/api/skills/share', express.json({ limit: '64kb' }), (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const dirs = bundleDirs(ids);
  if (!dirs.length) return res.json({ ok: false, error: 'No skills to share.' });
  const dir = sharedSkillsDir();
  try {
    mkdirSync(dir, { recursive: true });
    const written = dirs.map((d) => {
      const out = path.join(dir, `${d.folder}.zip`);
      writeFileSync(out, zipDirectory(d.dir, d.folder));
      return relToRoot(out);
    });
    workspaceChanged();
    res.json({ ok: true, dir: relToRoot(dir), written });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

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
loadSkillsConfig();
loadSessionModes();
loadSessionMeta();
autoContinue.load();
notifier.load();
tasks.load();
scheduler.load();
team.load();
cleanupUploads();          // drop attachments older than a week
refreshHaLinks();          // populate entity/automation link targets
planUsage.startPolling();  // plan limits for the Usage panel while a tab is open
autoContinue.rearmOnBoot();
scheduler.start();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Claude Code UI listening on port ${PORT}`);
  console.log(`  Working dir: ${WORK_DIR}`);
  console.log(`  Workspace:   ${workspaceRoot()}`);
  console.log(`  Plugin dir:  ${PLUGIN_DIR}`);
  console.log(`  /addon_configs access: ${ALLOW_ADDON_CONFIGS ? 'enabled' : 'blocked'}`);
  console.log(`  ESPHome capability: ${ENABLE_ESPHOME ? `on (${ESPHOME_CONFIG_DIR || 'no config dir'})` : 'off'}`);
  console.log(`  Auto-continue on limit: ${autoContinue.autoContinue.enabled ? 'on' : 'off'} ` +
    `(${isSubscriptionAuth() ? 'subscription' : 'api-key'} auth)`);
  console.log(`  Verbose logging: ${VERBOSE_LOGGING ? 'on' : 'off'}`);
});
