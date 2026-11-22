/*
 * WhatsApp as a linked device — the way Hermes Agent does it: the bot's number
 * is linked once by scanning a QR code (WhatsApp › Linked devices), with no
 * Meta Business account, app or webhook.
 *
 * Baileys needs Node 20+, the app server runs on Node 18: this file is run by
 * /opt/node22 as a child of the server (server/lib/whatsapp-web.js) and talks
 * to it in JSON lines.
 *
 *   stdout (to the server)
 *     { ev: 'state', state: 'starting'|'qr'|'open'|'closed'|'loggedOut', qr?, me?, error? }
 *     { ev: 'message', m: { id, from, name, ts, type, text, mediaPath, mime, filename, voice, location } }
 *     { ev: 'reply', id, ok, error? }
 *     { ev: 'log', level, msg }
 *   stdin (from the server)
 *     { id, op: 'send', to, text } · { id, op: 'file', to, path, name, mime, caption }
 *     { id, op: 'read', msgId } · { id, op: 'logout' }
 *
 * `from` and `to` are phone numbers in digits (country code first), as in
 * Hub › WhatsApp. Messages from groups, statuses, channels and the bot's own
 * number are dropped here; who may talk to the assistant is decided by the
 * server.
 */
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import QRCode from 'qrcode';
import * as B from '@whiskeysockets/baileys';

const makeWASocket = B.makeWASocket || B.default;
const AUTH_DIR = process.env.WA_AUTH_DIR;
const MEDIA_DIR = process.env.WA_MEDIA_DIR;
const MAX_MEDIA = 25 * 1024 * 1024;

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (level, msg) => out({ ev: 'log', level, msg });
const digits = (jid) => String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
const isPn = (jid) => /@s\.whatsapp\.net$/.test(String(jid || ''));

let sock = null;
let stopping = false;
const keys = new Map();   // message id → key, for the blue ticks

/** The sender's phone number: WhatsApp now often names people by a LID. */
async function phoneOf(key) {
  for (const j of [key.remoteJid, key.remoteJidAlt, key.senderPn]) if (isPn(j)) return digits(j);
  const lid = [key.remoteJid, key.remoteJidAlt].find((j) => /@lid$/.test(String(j || '')));
  if (lid) {
    try { const pn = await sock.signalRepository?.lidMapping?.getPNForLID(lid); if (pn) return digits(pn); } catch {}
  }
  return '';
}

async function saveMedia(msg, id, filename) {
  const buf = await B.downloadMediaMessage(msg, 'buffer', {}, { logger: sock.logger, reuploadRequest: sock.updateMediaMessage });
  if (buf.length > MAX_MEDIA) throw new Error('Fichier trop gros.');
  mkdirSync(MEDIA_DIR, { recursive: true });
  const file = path.join(MEDIA_DIR, `${String(id).replace(/[^A-Za-z0-9]/g, '')}${path.extname(filename || '') || ''}`);
  writeFileSync(file, buf);
  return file;
}

async function toMessage(msg) {
  const k = msg.key || {};
  const jid = String(k.remoteJid || '');
  if (k.fromMe || !jid || B.isJidGroup(jid) || B.isJidStatusBroadcast(jid) || B.isJidNewsletter?.(jid) || B.isJidBroadcast?.(jid)) return null;
  const c = B.normalizeMessageContent(msg.message);
  if (!c || c.protocolMessage || c.reactionMessage) return null;
  const from = await phoneOf(k);
  if (!from) { log('WARN', `numéro introuvable pour ${jid.replace(/^\d+(?=\d{4})/, '…')}`); return null; }
  const m = { id: k.id, from, name: msg.pushName || '', ts: Number(msg.messageTimestamp) * 1000 || Date.now(), type: 'text', text: '' };
  if (c.conversation || c.extendedTextMessage) m.text = c.conversation || c.extendedTextMessage.text || '';
  else if (c.buttonsResponseMessage || c.listResponseMessage) {
    m.text = c.buttonsResponseMessage?.selectedDisplayText || c.listResponseMessage?.title || '';
  } else if (c.locationMessage || c.liveLocationMessage) {
    const l = c.locationMessage || c.liveLocationMessage;
    m.type = 'location';
    m.location = { lat: l.degreesLatitude, lon: l.degreesLongitude, name: l.name || '', address: l.address || '' };
  } else {
    const kind = c.audioMessage ? 'audio' : c.imageMessage ? 'image' : c.documentMessage ? 'document' : c.videoMessage ? 'video' : c.stickerMessage ? 'sticker' : null;
    if (!kind) { m.type = 'unsupported'; return m; }
    const media = c[`${kind}Message`];
    m.type = kind;
    m.mime = media.mimetype || '';
    m.filename = media.fileName || '';
    m.text = media.caption || '';
    m.voice = !!media.ptt;
    if (['audio', 'image', 'document'].includes(kind)) {
      if (Number(media.fileLength || 0) > MAX_MEDIA) m.error = 'Fichier trop gros.';
      else try { m.mediaPath = await saveMedia(msg, k.id, m.filename || (kind === 'audio' ? 'voice.ogg' : '')); } catch (e) { m.error = e.message; }
    }
  }
  return m;
}

async function start() {
  out({ ev: 'state', state: 'starting' });
  mkdirSync(AUTH_DIR, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await B.useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await B.fetchLatestBaileysVersion()); } catch { /* the bundled one */ }
  sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    browser: B.Browsers.ubuntu('Soufassistant'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) out({ ev: 'state', state: 'qr', qr: await QRCode.toDataURL(qr, { margin: 2, width: 300 }) });
    if (connection === 'open') out({ ev: 'state', state: 'open', me: digits(sock.user?.id) });
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === B.DisconnectReason.loggedOut) {
        rmSync(AUTH_DIR, { recursive: true, force: true });
        out({ ev: 'state', state: 'loggedOut' });
        process.exit(0);
      }
      out({ ev: 'state', state: 'closed', error: lastDisconnect?.error?.message || `code ${code}` });
      // restartRequired (515) right after pairing, and ordinary drops: reconnect
      if (!stopping) setTimeout(() => start().catch(fatal), code === B.DisconnectReason.restartRequired ? 500 : 5000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        const m = await toMessage(msg);
        if (!m) continue;
        keys.set(m.id, msg.key);
        if (keys.size > 500) keys.delete(keys.keys().next().value);
        out({ ev: 'message', m });
      } catch (e) { log('WARN', `message illisible : ${e.message}`); }
    }
  });
}

async function handle(req) {
  const jid = (to) => `${digits(to)}@s.whatsapp.net`;
  if (!sock?.user && req.op !== 'logout') throw new Error('WhatsApp n\'est pas connecté (Hub › WhatsApp).');
  if (req.op === 'send') { await sock.sendMessage(jid(req.to), { text: String(req.text) }); return; }
  if (req.op === 'file') {
    const buf = readFileSync(req.path);
    const image = /^image\/(png|jpeg)$/.test(req.mime);
    await sock.sendMessage(jid(req.to), image
      ? { image: buf, caption: req.caption || undefined }
      : { document: buf, mimetype: req.mime, fileName: req.name, caption: req.caption || undefined });
    return;
  }
  if (req.op === 'read') {
    const key = keys.get(req.msgId);
    if (key) {
      await sock.readMessages([key]);
      await sock.sendPresenceUpdate('composing', key.remoteJid).catch(() => {});
    }
    return;
  }
  if (req.op === 'logout') {
    stopping = true;
    try { await sock?.logout(); } catch {}
    rmSync(AUTH_DIR, { recursive: true, force: true });
    out({ ev: 'state', state: 'loggedOut' });
    setTimeout(() => process.exit(0), 200);
    return;
  }
  throw new Error(`unknown op ${req.op}`);
}

function fatal(e) { log('ERROR', e?.stack || String(e)); process.exit(1); }

createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  handle(req).then(() => out({ ev: 'reply', id: req.id, ok: true }), (e) => out({ ev: 'reply', id: req.id, ok: false, error: e.message }));
}).on('close', () => { stopping = true; process.exit(0); });

if (!AUTH_DIR || !MEDIA_DIR) fatal(new Error('WA_AUTH_DIR and WA_MEDIA_DIR are required'));
start().catch(fatal);
