/*
 * Published apps — what is built in a Cowork project, kept online for good
 * (like Lovable / Bolt "publish"), at <app>/apps/<slug>/ behind Home
 * Assistant's login (the ingress), from the HA app on a phone too.
 *
 *   static   the project folder served as files (entry: index.html)
 *   server   a command started in the project folder with $PORT set (one of
 *            APP_PORTS), restarted if it stops, started again with the app;
 *            /apps/<slug>/ is proxied to it
 *
 * Every response carries `Content-Security-Policy: sandbox …` without
 * allow-same-origin: the page gets an opaque origin, so a published page
 * cannot use this app's session or socket (and has no localStorage/cookies —
 * the publish tool tells Claude so). Registry: APPS_FILE.
 */
import { spawn } from 'child_process';
import express from 'express';
import http from 'http';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { APPS_FILE } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { log } from './log.js';

export const APP_PORTS = [8200, 8299];
const SANDBOX = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const MAX_APPS = 30;
const procs = new Map();   // slug → { child, restarts, startedAt, log: [] }
let registry = null;
let projectDirOf = () => null;

function load() {
  if (registry) return registry;
  try { registry = JSON.parse(readFileSync(APPS_FILE, 'utf8')).apps || []; } catch { registry = []; }
  return registry;
}
function save() { writeFileAtomic(APPS_FILE, JSON.stringify({ apps: registry }, null, 2)); }

/** A URL slug from a name. Pure. */
export function appSlug(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || null;
}

function freePort() {
  const used = new Set(load().map((a) => a.port).filter(Boolean));
  for (let p = APP_PORTS[0]; p <= APP_PORTS[1]; p++) if (!used.has(p)) return p;
  return null;
}

export function listApps() {
  return load().map((a) => ({ ...a, running: a.kind === 'server' ? !!procs.get(a.slug)?.child : true, log: (procs.get(a.slug)?.log || []).slice(-30) }));
}

/** Validate and register (or update) an app. `dirOf(project)` → absolute folder. */
export function publishApp({ name, project, kind = 'static', entry = 'index.html', command = '' }) {
  const slug = appSlug(name || project);
  if (!slug) return { ok: false, error: 'Give the app a name.' };
  const dir = projectDirOf(project);
  if (!dir) return { ok: false, error: `No workspace project "${project}".` };
  if (!['static', 'server'].includes(kind)) return { ok: false, error: 'kind is "static" or "server".' };
  const list = load();
  const prev = list.find((a) => a.slug === slug);
  if (!prev && list.length >= MAX_APPS) return { ok: false, error: `${MAX_APPS} apps at most.` };
  if (kind === 'static') {
    const e = path.normalize(String(entry || 'index.html')).replace(/^(\.\.(\/|$))+/, '');
    if (!existsSync(path.join(dir, e))) return { ok: false, error: `No ${e} in the project.` };
    entry = e;
  } else if (!String(command).trim()) return { ok: false, error: 'A server app needs the command that starts it (it must listen on $PORT, 127.0.0.1).' };
  const port = kind === 'server' ? (prev?.port || freePort()) : null;
  if (kind === 'server' && !port) return { ok: false, error: 'No free port left.' };
  const app = { slug, name: String(name || project).slice(0, 80), project, kind, entry: kind === 'static' ? entry : null, command: kind === 'server' ? String(command).slice(0, 500) : null, port, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
  if (prev) Object.assign(prev, app); else list.push(app);
  save();
  if (kind === 'server') { stopProc(slug); startProc(app); } else stopProc(slug);
  log('INFO', `apps: published "${slug}" (${kind})`);
  return { ok: true, app };
}

export function unpublishApp(slug) {
  const list = load();
  const i = list.findIndex((a) => a.slug === slug);
  if (i < 0) return { ok: false, error: 'No such app.' };
  stopProc(slug);
  list.splice(i, 1);
  save();
  return { ok: true };
}

function startProc(app) {
  const dir = projectDirOf(app.project);
  if (!dir) { log('WARN', `apps: project of "${app.slug}" is gone`); return; }
  const st = procs.get(app.slug) || { restarts: 0, log: [] };
  const child = spawn('bash', ['-lc', app.command], { cwd: dir, env: { ...process.env, PORT: String(app.port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  st.child = child; st.startedAt = Date.now();
  const push = (b) => { st.log.push(...String(b).split('\n').filter(Boolean).map((l) => l.slice(0, 300))); if (st.log.length > 200) st.log.splice(0, st.log.length - 200); };
  child.stdout.on('data', push); child.stderr.on('data', push);
  child.on('exit', (code) => {
    if (st.child !== child) return;
    st.child = null;
    push(`(exited with code ${code})`);
    if (!load().some((a) => a.slug === app.slug)) return;
    // quick crash loops back off; a long-lived server that stops restarts at once
    st.restarts = Date.now() - st.startedAt < 30000 ? st.restarts + 1 : 0;
    if (st.restarts > 5) { log('WARN', `apps: "${app.slug}" keeps stopping — not restarted`); return; }
    setTimeout(() => startProc(app), 2000 * 2 ** st.restarts);
  });
  procs.set(app.slug, st);
}
function stopProc(slug) {
  const st = procs.get(slug);
  if (st?.child) { const c = st.child; st.child = null; c.kill('SIGTERM'); setTimeout(() => c.kill('SIGKILL'), 3000).unref(); }
  procs.delete(slug);
}

/** At startup: remember how to find projects, start the server apps. */
export function startApps(dirOf) {
  projectDirOf = dirOf;
  for (const a of load()) if (a.kind === 'server') startProc(a);
}
export function stopApps() { for (const slug of [...procs.keys()]) stopProc(slug); }

/** Express handler for /apps/:slug/* */
export function appsHandler(req, res, next) {
  const app = load().find((a) => a.slug === req.params.slug);
  if (!app) { res.status(404).type('text').send('No published app here.'); return; }
  res.setHeader('Content-Security-Policy', SANDBOX);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const ingress = String(req.headers['x-ingress-path'] || '').replace(/\/+$/, '');
  const rest = req.originalUrl.replace(/^.*?\/apps\/[^/?]+/, '') || '/';
  if (app.kind === 'static') {
    const dir = projectDirOf(app.project);
    if (!dir) { res.status(404).type('text').send('The project folder is gone.'); return; }
    const pathOnly = rest.split('?')[0];
    if (pathOnly === '/' || pathOnly === '') {
      res.sendFile(path.join(dir, app.entry), { dotfiles: 'deny' });
      return;
    }
    req.url = rest;
    express.static(dir, { dotfiles: 'deny', index: false })(req, res, () => res.status(404).type('text').send('Not found.'));
    return;
  }
  const headers = { ...req.headers, host: `127.0.0.1:${app.port}` };
  delete headers.cookie; delete headers.authorization; delete headers['x-ingress-path'];
  const up = http.request({ host: '127.0.0.1', port: app.port, method: req.method, path: rest, headers }, (r) => {
    const h = { ...r.headers, 'content-security-policy': SANDBOX };
    delete h['set-cookie']; delete h['x-frame-options'];
    if (h.location && h.location.startsWith('/') && !h.location.startsWith('//')) h.location = `${ingress}/apps/${app.slug}${h.location}`;
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`${app.name} is not answering yet (starting, or stopped — see its log in the Apps tab).`); });
  req.pipe(up);
}

