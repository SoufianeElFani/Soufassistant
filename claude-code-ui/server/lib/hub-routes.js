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
import * as vault from './vault.js';
import * as redact from './redact.js';
import { sensitivePassages } from './sensitive.js';
import * as lexicon from './lexicon.js';
import { readFileSync, statSync as statS, readdirSync as readdirS } from 'fs';

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
  registerVaultRoutes(app);
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

// ── Confidential mode (vault.js) — every answer here goes to the browser only, never to the model ──
const vaultChanged = (r) => { broadcast({ type: 'vault_map', map: vault.revealMap() }); return r; };
const statusChanged = (r) => { broadcast({ type: 'vault_status', ...vault.vaultStatus() }); return vaultChanged(r); };
export function registerVaultRoutes(app) {
  app.get('/api/vault', wrap(() => ({ ok: true, ...vault.vaultStatus(), entities: vault.listEntities(), exempt: vault.exemptList(), reels: vault.listReels(), ignored: vault.isLocked() ? [] : vault.ignoredList(), images: vault.imagesToCheck(workspaceRoot()), docs: vault.docsToCheck(workspaceRoot()) })));
  // encryption: the passphrase only ever travels browser → server, and is never stored
  app.post('/api/vault/unlock', json, wrap((req) => (vault.unlock(String(req.body?.pass || '')) ? statusChanged({ ok: true }) : { ok: false, error: 'Phrase de passe incorrecte.' })));
  // erasing everything needs the word typed in the Hub (an accidental call does nothing)
  app.post('/api/vault/wipe', json, wrap((req) => (req.body?.confirm === 'EFFACER' ? statusChanged({ ok: vault.wipe() }) : { ok: false, error: 'Confirmation manquante.' })));
  app.post('/api/vault/lock', json, wrap(() => statusChanged((vault.lock(), { ok: true }))));
  app.post('/api/vault/passphrase', json, wrap((req) => {
    const r = vault.setPassphrase(String(req.body?.pass || ''), String(req.body?.old || ''));
    return r.ok ? statusChanged(r) : r;
  }));
  // the pre-send check: what looks like a name and is not in the vault (nothing is learnt or sent)
  app.post('/api/vault/preview', express.json({ limit: '5mb' }), wrap(async (req) => {
    if (vault.isLocked()) return { ok: true, locked: true };
    await lexicon.ready();   // the dictionaries (loaded in the background at boot)
    const text = String(req.body?.text || '');
    // names the vault does not know, and the sentences touching GDPR or business confidentiality
    return { ok: true, ...vault.suspects(text), passages: sensitivePassages(text) };
  }));
  // the redaction editor: pages + proposed boxes, computed here (the original never reaches the model)
  app.post('/api/vault/redact', express.json({ limit: '80mb' }), wrap((req) => redact.analyze(req.body || {})));
  app.post('/api/vault/redact/save', express.json({ limit: '80mb' }), wrap((req) => {
    const rel = String(req.body?.path || '');
    if (!inWorkspace(rel)) return { ok: false, error: 'Bad path.' };
    const out = vault.saveRedacted(workspaceRoot(), rel, Buffer.from(String(req.body?.data || '').replace(/^data:image\/png;base64,/, ''), 'base64'));
    if (!out) return { ok: false, error: 'Fichier introuvable.' };
    broadcast({ type: 'workspace', entries: listWorkspaceEntries() });
    return { ok: true, path: out };
  }));
  // the pictures inside an Office attachment, for the redaction editor (nothing is kept or sent)
  // an attachment (`data`) or a workspace document (`path`); an old format is converted first
  app.post('/api/vault/office-media', express.json({ limit: '80mb' }), wrap(async (req) => {
    if (vault.isLocked()) return { ok: true, locked: true };
    const rel = req.body?.path ? String(req.body.path) : null;
    const abs = rel ? inWorkspace(rel) : null;
    if (rel && !abs) return { ok: false, error: 'Bad path.' };
    let buf = abs ? readFileSync(abs) : Buffer.from(String(req.body?.data || '').replace(/^data:[^;]+;base64,/, ''), 'base64');
    const k = path.extname(rel || String(req.body?.name || '')).slice(1).toLowerCase();
    try {
      if (vault.LEGACY[k]) buf = await vault.convertLegacy(buf, k);
      return { ok: true, ...vault.officeMedia(buf) };
    } catch { return { ok: false, error: 'Fichier Office illisible.' }; }
  }));
  // a workspace document's pictures, checked in the editor (or all blanked, or « rien de sensible »)
  app.post('/api/vault/office-save', express.json({ limit: '120mb' }), wrap((req) => {
    const rel = String(req.body?.path || '');
    if (!inWorkspace(rel)) return { ok: false, error: 'Bad path.' };
    const m = req.body?.media && typeof req.body.media === 'object' ? new Map(Object.entries(req.body.media).map(([p, d]) => [p, Buffer.from(String(d).replace(/^data:[^;]+;base64,/, ''), 'base64')])) : null;
    if (!vault.saveDocMedia(workspaceRoot(), rel, m, !!req.body?.blank)) return { ok: false, error: 'Fichier introuvable.' };
    broadcast({ type: 'workspace', entries: listWorkspaceEntries() });
    return { ok: true };
  }));
  app.post('/api/vault/ignore', json, wrap((req) => ((Array.isArray(req.body?.list) ? vault.setIgnored(req.body.list) : vault.addIgnored([].concat(req.body?.words || []))), { ok: true })));
  app.post('/api/vault/entity', json, wrap((req) => vaultChanged({ ok: !!vault.addEntity(req.body || {}) })));
  app.post('/api/vault/entity/delete', json, wrap((req) => vaultChanged({ ok: vault.removeEntity(req.body?.alias) })));
  app.post('/api/vault/exempt', json, wrap((req) => vaultChanged((vault.setExempt(req.body?.list || []), { ok: true }))));
  // candidates found locally in a workspace folder (nothing is added until the user picks them)
  app.post('/api/vault/scan', json, wrap((req) => {
    const root = workspaceRoot();
    const base = path.resolve(root, String(req.body?.rel || ''));
    if (!base.startsWith(root)) return { ok: false, error: 'Bad path.' };
    const found = new Map();
    const walk = (d, depth = 0) => {
      for (const n of readdirS(d)) {
        if (n.startsWith('.') || n === '__pycache__') continue;
        const p = path.join(d, n);
        const st = statS(p);
        if (st.isDirectory()) { if (depth < 6) walk(p, depth + 1); continue; }
        if (!/\.(md|txt|csv|json|ya?ml|py|html?)$/i.test(n) || st.size > 2e6) continue;
        for (const c of vault.detect(readFileSync(p, 'utf8') + '\n' + n)) found.set(c.real.toLowerCase(), { ...c, count: (found.get(c.real.toLowerCase())?.count || 0) + 1 });
      }
    };
    walk(base);
    return { ok: true, candidates: [...found.values()].sort((a, b) => b.count - a.count).slice(0, 300) };
  }));
  app.post('/api/vault/anonymize', json, wrap(async (req) => {
    const rel = String(req.body?.rel || '');
    if (!rel || rel.includes('..')) return { ok: false, error: 'Choose a folder of the workspace.' };
    const r = await vault.anonymizeTree(workspaceRoot(), rel, { dryRun: !!req.body?.dryRun });
    if (!req.body?.dryRun) { vaultChanged(); broadcast({ type: 'workspace', entries: listWorkspaceEntries() }); }
    return { ok: true, report: r };
  }));
  app.post('/api/vault/particularize', json, wrap(async (req) => {
    const abs = inWorkspace(req.body?.path);
    if (!abs) return { ok: false, error: 'Bad path.' };
    const r = await vault.particularize(abs, req.body.path);
    return r.ok ? { ok: true, reels: vault.listReels() } : { ok: false, error: `Cannot produce a real version of this kind of file (${r.how}).` };
  }));
  app.get('/api/vault/reel', (req, res) => {
    const f = vault.reelFile(req.query.id);
    if (!f) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.attachment(f.name).send(f.data);
  });
}

export function startHub() {
  // the pre-send check's dictionaries, loaded in the background so the first message does not wait
  setTimeout(() => lexicon.ready().catch(() => {}), 10000).unref?.();
  apps.startApps((name) => projectDir(name));
}
