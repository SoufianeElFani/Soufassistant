/*
 * WhatsApp as a linked device (QR code) — the other way in, beside Meta's
 * Cloud API: no Meta Business account, app, token or webhook. The bot's number
 * (a SIM of its own is best: an unofficial client can get a number banned) is
 * linked once from Hub › WhatsApp, like WhatsApp Web.
 *
 * The connection itself is whatsapp-web/sidecar.mjs (Baileys, which needs
 * Node 20+), run by /opt/node22 as a child process. This module starts it,
 * restarts it when it falls, and turns its JSON lines into calls:
 * status(), start(), stop(), logout(), sendText/sendFile/markRead(), onMessage().
 * Its login lives in DATA_DIR/whatsapp-web-auth (mode 700).
 */
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NODE_BIN = process.env.WHATSAPP_NODE || '/opt/node22/bin/node';
export const SIDECAR = process.env.WHATSAPP_SIDECAR
  || [path.join(HERE, '..', 'whatsapp-web', 'sidecar.mjs'), path.join(HERE, '..', '..', 'whatsapp-web', 'sidecar.mjs'), '/opt/whatsapp-web/sidecar.mjs'].find(existsSync)
  || '/opt/whatsapp-web/sidecar.mjs';
const AUTH_DIR = () => path.join(DATA_DIR, 'whatsapp-web-auth');
const MEDIA_DIR = () => path.join(DATA_DIR, 'whatsapp-web-media');
const REQUEST_MS = 60000;

let child = null;
let wanted = false;
let backoff = 2000;
let st = { state: 'stopped', qr: '', me: '', error: '' };
let nextId = 1;
const pending = new Map();
let handler = null;
let unlinking = false;

/** Has a number been linked (a login is saved)? */
export function linked() {
  try { return !!JSON.parse(readFileSync(path.join(AUTH_DIR(), 'creds.json'), 'utf8'))?.me?.id; } catch { return false; }
}

export const status = () => ({ ...st, running: !!child, linked: linked(), available: existsSync(NODE_BIN) && existsSync(SIDECAR) });
export const connected = () => st.state === 'open';
export function onMessage(fn) { handler = fn; }

function onLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.ev === 'state') {
    st = { state: o.state, qr: o.state === 'qr' ? o.qr || '' : '', me: o.me || (o.state === 'open' ? '' : st.me), error: o.error || '' };
    if (o.state === 'open') { backoff = 2000; log('INFO', `whatsapp-web: connected as …${String(o.me).slice(-4)}`); }
    else if (o.state !== 'qr') log('INFO', `whatsapp-web: ${o.state}${o.error ? ` (${o.error})` : ''}`);
    if (o.state === 'loggedOut') {
      // unlinked: from the Hub, or from the phone (WhatsApp › Linked devices)
      wanted = false;
      st = { state: 'stopped', qr: '', me: '', error: unlinking ? '' : 'Le numéro a été délié depuis le téléphone : affiche un nouveau QR code pour le relier.' };
    }
  } else if (o.ev === 'message') {
    try { handler?.(o.m); } catch (e) { log('ERROR', `whatsapp-web: ${e.message}`); }
  } else if (o.ev === 'reply') {
    const p = pending.get(o.id);
    if (p) { pending.delete(o.id); clearTimeout(p.timer); o.ok ? p.resolve() : p.reject(new Error(o.error || 'échec')); }
  } else if (o.ev === 'log') log(o.level || 'INFO', `whatsapp-web: ${o.msg}`);
}

/** Start the connection: shows a QR code if no number is linked yet. */
export function start() {
  wanted = true;
  if (child) return status();
  if (!existsSync(NODE_BIN) || !existsSync(SIDECAR)) {
    st = { state: 'error', qr: '', me: '', error: `Composant WhatsApp absent (${existsSync(NODE_BIN) ? SIDECAR : NODE_BIN}).` };
    return status();
  }
  st = { ...st, state: 'starting', qr: '', error: '' };
  const c = spawn(NODE_BIN, [SIDECAR], {
    env: { ...process.env, NODE_PATH: '', WA_AUTH_DIR: AUTH_DIR(), WA_MEDIA_DIR: MEDIA_DIR() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child = c;
  createInterface({ input: c.stdout }).on('line', onLine);
  createInterface({ input: c.stderr }).on('line', (l) => log('WARN', `whatsapp-web: ${l.slice(0, 300)}`));
  c.on('error', (e) => log('ERROR', `whatsapp-web: ${e.message}`));
  c.on('exit', (code) => {
    if (child === c) child = null;
    for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error('WhatsApp s\'est arrêté.')); pending.delete(id); }
    st = { ...st, state: wanted ? 'closed' : 'stopped', qr: '' };
    if (wanted) {
      log('WARN', `whatsapp-web: stopped (code ${code}), restarting in ${Math.round(backoff / 1000)} s`);
      setTimeout(() => { if (wanted && !child) start(); }, backoff);
      backoff = Math.min(backoff * 2, 300000);
    }
  });
  return status();
}

export function stop() {
  wanted = false;
  if (child) { child.stdin.end(); const c = child; setTimeout(() => c.kill(), 3000); }
  st = { ...st, state: 'stopped', qr: '' };
}

function request(op, payload = {}) {
  if (!child) return Promise.reject(new Error('WhatsApp n\'est pas connecté (Hub › WhatsApp).'));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('WhatsApp ne répond pas.')); }, REQUEST_MS);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`);
  });
}

/** Unlink the number (it disappears from WhatsApp › Linked devices). */
export async function logout() {
  unlinking = true;
  try {
    if (child) { try { await request('logout'); } catch {} }
    stop();
    rmSync(AUTH_DIR(), { recursive: true, force: true });
    st = { state: 'stopped', qr: '', me: '', error: '' };
  } finally { setTimeout(() => { unlinking = false; }, 2000); }
  return { ok: true };
}

export const sendText = (to, text) => request('send', { to, text });
export const sendFile = (to, abs, { name, mime, caption }) => request('file', { to, path: abs, name, mime, caption });
export const markRead = (msgId) => request('read', { msgId }).catch(() => {});

/** A received voice note or file, saved by the sidecar: read it once, then delete it. */
export function takeMedia(file) {
  const abs = path.resolve(String(file || ''));
  if (!abs.startsWith(MEDIA_DIR() + path.sep) || !existsSync(abs)) throw new Error('Média introuvable.');
  const buf = readFileSync(abs);
  rmSync(abs, { force: true });
  return buf;
}
