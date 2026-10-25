/*
 * Live previews — a web app Claude starts inside a Cowork project (a dev
 * server, a small API) shown in the artifact viewer through the ingress.
 *
 * Convention (told to Claude in Cowork mode, modes.js): serve on 127.0.0.1,
 * on a port in PREVIEW_PORT_MIN..MAX (8100–8199), with relative URLs. The app
 * is then reachable at `<ingress>/preview/<port>/…` through a small reverse
 * proxy here — only for that port range and only to localhost, so it cannot
 * be turned into a proxy to anything else.
 *
 * The viewer shows it in an iframe *without* allow-same-origin (like any
 * artifact), so the page cannot reach this app; for its own fetch() calls to
 * still work from that opaque ("null") origin, proxied responses carry
 * `Access-Control-Allow-Origin: *` and CORS preflights are answered here.
 * WebSocket upgrades (e.g. hot reload) are not proxied.
 *
 * Which ports are up is read from /proc/net/tcp{,6} (LISTEN sockets); "Stop"
 * finds the owning process through /proc/<pid>/fd and sends it SIGTERM.
 */
import http from 'http';
import { readFileSync, readdirSync, readlinkSync } from 'fs';
import { PREVIEW_PORT_MIN, PREVIEW_PORT_MAX } from './config.js';
import { log } from './log.js';

export function inPreviewRange(port) {
  const p = Number(port);
  return Number.isInteger(p) && p >= PREVIEW_PORT_MIN && p <= PREVIEW_PORT_MAX;
}

/**
 * LISTEN sockets in a /proc/net/tcp-format table. Pure — unit-tested.
 * Returns [{ port, inode }].
 */
export function parseProcNetTcp(text) {
  const out = [];
  for (const line of String(text).split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;           // 0A = LISTEN
    const port = parseInt(f[1].split(':').pop(), 16);
    if (Number.isFinite(port)) out.push({ port, inode: f[9] });
  }
  return out;
}

function listening() {
  const all = [];
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { all.push(...parseProcNetTcp(readFileSync(f, 'utf8'))); } catch {}
  }
  return all;
}

/** Ports in the preview range that something is listening on. */
export function listPreviews() {
  const seen = new Set();
  return listening()
    .filter((s) => inPreviewRange(s.port) && !seen.has(s.port) && seen.add(s.port))
    .map((s) => ({ port: s.port, command: commandForInode(s.inode) }))
    .sort((a, b) => a.port - b.port);
}

function pidForInode(inode) {
  const target = `socket:[${inode}]`;
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    let fds;
    try { fds = readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) {
      try { if (readlinkSync(`/proc/${pid}/fd/${fd}`) === target) return Number(pid); } catch {}
    }
  }
  return null;
}

function commandForInode(inode) {
  const pid = pidForInode(inode);
  if (!pid) return null;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 120); }
  catch { return null; }
}

export function stopPreview(port) {
  if (!inPreviewRange(port)) return { ok: false, error: 'Not a preview port.' };
  const sock = listening().find((s) => s.port === Number(port));
  if (!sock) return { ok: false, error: 'Nothing is running on that port.' };
  const pid = pidForInode(sock.inode);
  if (!pid || pid === process.pid) return { ok: false, error: 'Could not find the process.' };
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: e.message }; }
  log('INFO', `preview on port ${port} stopped (pid ${pid})`);
  return { ok: true };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

/** Express handler for /preview/:port/* */
export function previewProxy(req, res) {
  const port = Number(req.params.port);
  if (!inPreviewRange(port)) { res.status(404).end('Not a preview port'); return; }
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  const rest = req.originalUrl.replace(/^.*?\/preview\/\d+/, '') || '/';
  const ingress = String(req.headers['x-ingress-path'] || '').replace(/\/+$/, '');
  const headers = { ...req.headers, host: `127.0.0.1:${port}` };
  delete headers.cookie;          // the ingress session cookie is not the app's business
  delete headers.authorization;
  delete headers['x-ingress-path'];
  const up = http.request({ host: '127.0.0.1', port, method: req.method, path: rest.startsWith('/') ? rest : `/${rest}`, headers }, (r) => {
    const h = { ...r.headers, ...CORS };
    delete h['x-frame-options'];
    delete h['content-security-policy'];
    delete h['set-cookie'];
    // A redirect to an absolute path would leave /preview/<port>/; keep it inside.
    if (h.location && h.location.startsWith('/') && !h.location.startsWith('//')) h.location = `${ingress}/preview/${port}${h.location}`;
    res.writeHead(r.statusCode || 502, h);
    r.pipe(res);
  });
  up.on('error', (e) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...CORS });
    res.end(`Nothing answered on port ${port} (${e.code || e.message}). Is the app still running?`);
  });
  req.pipe(up);
}
