/*
 * HTTP routes behind the Hub panel and the 1.0.0 features: memory, agents,
 * project knowledge, the Google connector, shared links, published apps and
 * the browser's live view. Registered by the composition root (index.js).
 * Every change is broadcast so all open tabs stay in step.
 */
import express from 'express';
import path from 'path';
import { broadcast } from './broadcast.js';
import { workspaceRoot, resolveInWorkspace, projectDir, listWorkspaceEntries } from './workspace.js';
import * as memory from './memory.js';
import * as agents from './agents.js';
import * as knowledge from './knowledge.js';
import * as google from './google.js';
import * as shares from './shares.js';
import * as apps from './apps.js';
import { lastFrame, browserAvailable } from './browser.js';
import { decoratedSessions, sessionToMarkdown } from './session-tools.js';
import { parseSession } from './sessions.js';

const json = express.json({ limit: '1mb' });
const wrap = (fn) => async (req, res) => {
  try { res.json(await fn(req, res)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
};

function inWorkspace(rel) {
  rel = String(rel || '');
  if (!rel || rel.split('/').some((s) => s.startsWith('.'))) return null;
  const abs = resolveInWorkspace(rel);
  return abs && abs !== workspaceRoot() ? abs : null;
}

export function registerHubRoutes(app) {
  // ── Memory ──
  app.get('/api/memory', wrap(() => memory.listMemory()));
  app.post('/api/memory', json, wrap((req) => memory.saveFact(req.body || {})));
  app.post('/api/memory/delete', json, wrap((req) => memory.deleteFact(req.body?.file)));
  app.post('/api/memory/clean', json, wrap(() => memory.cleanDangling()));

  // ── Agents ──
  const agentsChanged = (r) => { if (r.ok) broadcast(agents.agentsMessage()); return r; };
  app.get('/api/agents', wrap(() => agents.agentsMessage()));
  app.post('/api/agents', json, wrap((req) => agentsChanged(agents.saveAgent(req.body || {}))));
  app.post('/api/agents/delete', json, wrap((req) => agentsChanged(agents.deleteAgent(req.body?.id))));
  app.post('/api/agents/session', json, wrap((req) => {
    if (agents.setSessionAgent(req.body?.sessionId, req.body?.agent || null)) broadcast(agents.agentsMessage());
    return { ok: true };
  }));

  // ── Project knowledge ──
  const proj = (req) => projectDir(req.params.name);
  app.get('/api/projects/:name/knowledge', wrap((req) => {
    const dir = proj(req);
    if (!dir) return { ok: false, error: 'No such project.' };
    const k = knowledge.projectKnowledge(dir);
    return { ok: true, instructions: k.instructions, files: k.files.map(({ abs, ...f }) => ({ ...f, path: path.relative(workspaceRoot(), abs) })) };
  }));
  app.post('/api/projects/:name/instructions', json, wrap((req) => {
    const dir = proj(req);
    return dir ? knowledge.saveInstructions(dir, req.body?.instructions) : { ok: false, error: 'No such project.' };
  }));
  app.post('/api/projects/:name/knowledge', express.raw({ type: '*/*', limit: '30mb' }), wrap((req) => {
    const dir = proj(req);
    if (!dir) return { ok: false, error: 'No such project.' };
    const r = knowledge.addKnowledge(dir, req.query.file, req.body);
    if (r.ok) broadcast({ type: 'workspace', entries: listWorkspaceEntries() });
    return r;
  }));
  app.post('/api/projects/:name/knowledge/delete', json, wrap((req) => {
    const dir = proj(req);
    return dir ? knowledge.removeKnowledge(dir, req.body?.file) : { ok: false, error: 'No such project.' };
  }));

  // ── Google connector ──
  app.get('/api/connectors', wrap(() => ({ google: google.googleStatus(), browser: browserAvailable(), redirectUri: google.REDIRECT_URI })));
  app.post('/api/connectors/google/client', json, wrap((req) => google.setClient(req.body || {})));
  app.get('/api/connectors/google/auth-url', wrap(() => google.authUrl()));
  app.post('/api/connectors/google/finish', json, wrap((req) => google.finish(req.body?.url)));
  app.post('/api/connectors/google/disconnect', json, wrap(() => google.disconnect()));
  app.post('/api/connectors/google/forget', json, wrap(() => google.forgetClient()));

  // ── Shared links ──
  app.get('/api/shares', wrap(async () => ({ ok: true, shares: await shares.listShares() })));
  app.post('/api/shares/file', json, wrap(async (req) => {
    const abs = inWorkspace(req.body?.path);
    return abs ? shares.shareFile(abs, req.body.path) : { ok: false, error: 'Bad path.' };
  }));
  app.post('/api/shares/conversation', json, wrap(async (req) => {
    const s = decoratedSessions().find((x) => x.id === req.body?.id);
    if (!s) return { ok: false, error: 'No such conversation.' };
    return shares.shareMarkdown(s.title || 'Conversation', sessionToMarkdown(s.title || 'Conversation', parseSession(s.id)), `conversation:${s.id}`);
  }));
  app.post('/api/shares/revoke', json, wrap((req) => shares.revokeShare(req.body?.token)));

  // ── Published apps ──
  const appsChanged = (r) => { if (r.ok) broadcast({ type: 'published_apps', apps: apps.listApps() }); return r; };
  app.get('/api/apps', wrap(() => ({ ok: true, apps: apps.listApps() })));
  app.post('/api/apps', json, wrap((req) => appsChanged(apps.publishApp(req.body || {}))));
  app.post('/api/apps/unpublish', json, wrap((req) => appsChanged(apps.unpublishApp(req.body?.slug))));
  app.all(/^\/apps\/([^/]+)$/, (req, res) => res.redirect(301, `${req.headers['x-ingress-path'] || ''}/apps/${req.params[0]}/`));
  app.all('/apps/:slug/*', apps.appsHandler);

  // ── Browser live view ──
  app.get('/api/browser/frame', (req, res) => {
    const f = lastFrame(String(req.query.key || ''));
    if (!f) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Browser-Url', encodeURI(f.url || ''));
    res.type('jpeg').send(f.jpeg);
  });
}

export function startHub() {
  apps.startApps((name) => projectDir(name));
}
