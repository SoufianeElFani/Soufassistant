/*
 * WhatsApp (Meta's Cloud API): the settings, the contacts allowed to talk to
 * the assistant, and the Graph API calls — sending text, buttons, documents,
 * marking a message read, downloading a voice note or a picture.
 *
 * Settings live in CONNECTORS_DIR/whatsapp.json (mode 600) and never reach the
 * browser as such: status() says what is set, not what it is.
 *
 *   phoneNumberId  the bot's number id (Meta's free test number works: it may
 *                  message up to five numbers the owner verified in Meta's console)
 *   accessToken    a permanent System User token (whatsapp_business_messaging)
 *   appSecret      the Meta app's secret: every webhook call is signed with it
 *   verifyToken    generated here, pasted in Meta's console once
 *   contacts       [{ number, name, profile: 'owner' | 'family', person }]
 *
 * The conversations themselves are whatsapp-bridge.js; how Meta reaches this
 * app (through Home Assistant, the only thing the internet sees) is
 * whatsapp-relay.js. The helpers marked "pure" are unit-tested.
 *
 *   transport      'cloud' (Meta's Cloud API, the fields above) or 'web': the
 *                  bot's number linked by QR code (whatsapp-web.js, no Meta
 *                  account). Every send below goes the chosen way; reply buttons
 *                  become a numbered list on 'web' (applyButtonReply maps "1" back).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import path from 'path';
import { CONNECTORS_DIR } from './config.js';
import { log } from './log.js';
import * as web from './whatsapp-web.js';

export const GRAPH_URL = process.env.WHATSAPP_GRAPH_URL || 'https://graph.facebook.com/v23.0';
export const MAX_CONTACTS = 5;          // what Meta's test number allows
export const MAX_CONTACTS_WEB = 20;     // a linked number has no such list
export const TRANSPORTS = ['cloud', 'web'];
export const TEXT_LIMIT = 3900;         // WhatsApp's cap is 4096; leave room for "(1/3)"
export const PROFILES = ['owner', 'family'];

const FILE = () => path.join(CONNECTORS_DIR, 'whatsapp.json');

export function readConfig() { try { return JSON.parse(readFileSync(FILE(), 'utf8')); } catch { return {}; } }
export const isWeb = () => readConfig().transport === 'web';
export const maxContacts = () => (isWeb() ? MAX_CONTACTS_WEB : MAX_CONTACTS);
function writeConfig(d) {
  mkdirSync(CONNECTORS_DIR, { recursive: true });
  writeFileSync(FILE(), JSON.stringify(d, null, 2));
  try { chmodSync(FILE(), 0o600); } catch {}
}

/** The verify token Meta must echo back when the webhook is registered — made once. */
export function verifyToken() {
  const d = readConfig();
  if (d.verifyToken) return d.verifyToken;
  d.verifyToken = randomBytes(18).toString('hex');
  writeConfig(d);
  return d.verifyToken;
}

export const whatsappReady = () => {
  const d = readConfig();
  if (d.enabled === false) return false;
  return d.transport === 'web' ? web.linked() : !!(d.phoneNumberId && d.accessToken && d.appSecret);
};

/** What the Hub shows: never a secret. */
export function status() {
  const d = readConfig();
  return {
    transport: d.transport === 'web' ? 'web' : 'cloud',
    web: web.status(),
    maxContacts: maxContacts(),
    configured: !!(d.phoneNumberId && d.accessToken && d.appSecret),
    enabled: d.enabled !== false,
    phoneNumberId: d.phoneNumberId || '',
    hasToken: !!d.accessToken,
    hasSecret: !!d.appSecret,
    verifyToken: verifyToken(),
    publicUrl: d.publicUrl || '',
    contacts: contacts(),
  };
}

/** Empty fields keep what is saved — the form never shows the secrets again. */
export function setConfig(input = {}) {
  const d = readConfig();
  const id = String(input.phoneNumberId ?? '').trim();
  if (id && !/^\d{6,20}$/.test(id)) return { ok: false, error: 'L\'identifiant du numéro (Phone number ID) est une suite de chiffres.' };
  if (id) d.phoneNumberId = id;
  const token = String(input.accessToken ?? '').trim();
  if (token) d.accessToken = token;
  const secret = String(input.appSecret ?? '').trim();
  if (secret && !/^[a-f0-9]{16,64}$/i.test(secret)) return { ok: false, error: 'La clé secrète de l\'app (App secret) est une suite de 32 caractères hexadécimaux.' };
  if (secret) d.appSecret = secret;
  if (input.publicUrl !== undefined) {
    const u = String(input.publicUrl || '').trim().replace(/\/+$/, '');
    if (u && !/^https:\/\/[^\s/]+$/.test(u)) return { ok: false, error: 'L\'adresse publique est du type https://homeassistant.xxxx.ts.net (sans chemin).' };
    d.publicUrl = u;
  }
  if (input.enabled !== undefined) d.enabled = !!input.enabled;
  if (input.transport !== undefined) {
    if (!TRANSPORTS.includes(input.transport)) return { ok: false, error: 'Mode de connexion inconnu.' };
    d.transport = input.transport;
  }
  writeConfig(d);
  return { ok: true };
}

export function forget() {
  const d = readConfig();
  writeConfig({ verifyToken: d.verifyToken, contacts: d.contacts || [], publicUrl: d.publicUrl || '', ...(d.transport ? { transport: d.transport } : {}) });
  return { ok: true };
}

/** Pure. A number as WhatsApp writes it (`wa_id`): digits with the country code. */
export function normalizeNumber(raw, defaultCountry = '32') {
  let n = String(raw || '').replace(/[^\d+]/g, '');
  if (n.startsWith('+')) n = n.slice(1);
  else if (n.startsWith('00')) n = n.slice(2);
  else if (n.startsWith('0') && n.length >= 9 && n.length <= 10) n = defaultCountry + n.slice(1);
  n = n.replace(/\D/g, '');
  return n.length >= 8 && n.length <= 15 ? n : '';
}

export function contacts() {
  return (readConfig().contacts || []).filter((c) => c && c.number);
}

export function findContact(number) {
  const n = normalizeNumber(number);
  return n ? contacts().find((c) => c.number === n) || null : null;
}

/** By name (case/accents ignored) or number — how the agent names a recipient. */
export function resolveRecipient(who) {
  const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const w = plain(who);
  if (!w) return null;
  return contacts().find((c) => plain(c.name) === w || plain(c.name).split(/\s+/)[0] === w) || findContact(who);
}

export function setContacts(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'Liste attendue.' };
  const out = [];
  for (const c of list) {
    const number = normalizeNumber(c?.number);
    const name = String(c?.name || '').trim().slice(0, 40);
    if (!number) return { ok: false, error: `Numéro invalide : ${c?.number || '(vide)'}` };
    if (!name) return { ok: false, error: `Un prénom est nécessaire pour ${number}.` };
    if (out.some((x) => x.number === number)) return { ok: false, error: `${number} est en double.` };
    const profile = PROFILES.includes(c?.profile) ? c.profile : 'family';
    const person = /^person\.[a-z0-9_]+$/.test(String(c?.person || '')) ? c.person : '';
    out.push({ number, name, profile, person });
  }
  const max = maxContacts();
  if (out.length > max) return { ok: false, error: max === MAX_CONTACTS ? `${max} numéros au maximum (limite du numéro de test de Meta).` : `${max} numéros au maximum.` };
  const d = readConfig();
  d.contacts = out;
  writeConfig(d);
  return { ok: true, contacts: out };
}

// ── Webhook payloads (pure) ──────────────────────────────────────────────────

/** Pure. Meta signs the raw body: `X-Hub-Signature-256: sha256=<hex HMAC>`. */
export function verifySignature(raw, header, secret) {
  if (!secret || !header || !Buffer.isBuffer(raw)) return false;
  const m = /^sha256=([a-f0-9]{64})$/i.exec(String(header).trim());
  if (!m) return false;
  const want = createHmac('sha256', secret).update(raw).digest();
  const got = Buffer.from(m[1], 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Pure. The messages in one webhook call, flattened:
 * { id, from, name, ts, type, text, mediaId, mime, filename, buttonId, location }.
 * Delivery statuses come back separately (only failures matter).
 */
export function parseWebhook(body) {
  const messages = [];
  const failures = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'messages') continue;
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name || '']));
      for (const m of v.messages || []) {
        const out = { id: m.id, from: m.from, name: names[m.from] || '', ts: Number(m.timestamp) * 1000 || Date.now(), type: m.type, text: '' };
        if (m.type === 'text') out.text = m.text?.body || '';
        else if (m.type === 'interactive') {
          const r = m.interactive?.button_reply || m.interactive?.list_reply || {};
          out.type = 'button';
          out.buttonId = r.id || '';
          out.text = r.title || '';
        } else if (m.type === 'button') { out.buttonId = m.button?.payload || ''; out.text = m.button?.text || ''; }
        else if (['audio', 'image', 'document', 'video', 'sticker'].includes(m.type)) {
          const media = m[m.type] || {};
          out.mediaId = media.id;
          out.mime = media.mime_type || '';
          out.filename = media.filename || '';
          out.text = media.caption || '';
          out.voice = !!media.voice;
        } else if (m.type === 'location') {
          const l = m.location || {};
          out.location = { lat: l.latitude, lon: l.longitude, name: l.name || '', address: l.address || '' };
        }
        messages.push(out);
      }
      for (const s of v.statuses || []) {
        if (s.status === 'failed') failures.push({ to: s.recipient_id, code: s.errors?.[0]?.code, title: s.errors?.[0]?.title || s.errors?.[0]?.message || '' });
      }
    }
  }
  return { messages, failures };
}

// ── Formatting (pure) ────────────────────────────────────────────────────────

/** Pure. Claude writes Markdown; WhatsApp has its own small syntax. */
export function toWhatsApp(md) {
  const fences = [];
  let t = String(md || '').replace(/```[\s\S]*?```/g, (f) => { fences.push(f.replace(/^```[^\n]*\n?/, '```').replace(/\n?```$/, '```')); return `\u0002${fences.length - 1}\u0002`; });
  const bolds = [];
  const bold = (s) => { bolds.push(s); return `\u0001${bolds.length - 1}\u0001`; };
  t = t.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, (_, h) => bold(h.replace(/\*\*/g, '')));
  t = t.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => bold(a || b));
  t = t.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1_$2_');
  t = t.replace(/~~(.+?)~~/g, '~$1~');
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => (a ? `${a} (${u})` : u));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, a, u) => (a === u ? u : `${a} (${u})`));
  // tables: the separator row goes, cells are joined by " · "
  t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$\n?/gm, '');
  t = t.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map((c) => c.trim()).filter(Boolean).join(' · '));
  t = t.replace(/^(\s*)[*+]\s+/gm, '$1- ');
  t = t.replace(/^\s*(---+|\*\*\*+)\s*$/gm, '');
  t = t.replace(/\u0001(\d+)\u0001/g, (_, i) => `*${bolds[i]}*`);
  t = t.replace(/\u0002(\d+)\u0002/g, (_, i) => fences[i]);
  return t.replace(/\n{3,}/g, '\n\n').trim();
}

/** Pure. Split a long reply on paragraph, then line, then word boundaries. */
export function chunkText(text, limit = TEXT_LIMIT) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= limit) return [s];
  const parts = [];
  let rest = s;
  while (rest.length > limit) {
    const slice = rest.slice(0, limit);
    let cut = slice.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = slice.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = slice.lastIndexOf(' ');
    if (cut < limit * 0.3) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.length > 1 ? parts.map((p, i) => `${p}\n\n(${i + 1}/${parts.length})`) : parts;
}

/** Pure. A button title is 20 characters at most. */
export const buttonTitle = (s) => { const t = String(s || '').trim(); return t.length > 20 ? `${t.slice(0, 19)}…` : t || '…'; };

// ── Graph API ────────────────────────────────────────────────────────────────

/** Why a send failed, in words the user can act on. */
export function explainError(code, fallback) {
  if (code === 131047) return 'hors de la fenêtre de 24 h : cette personne doit d\'abord écrire au bot (WhatsApp n\'autorise pas un premier message libre).';
  if (code === 131030) return 'ce numéro n\'est pas dans la liste des destinataires autorisés du numéro de test (Meta › WhatsApp › API Setup › To).';
  if (code === 190) return 'le jeton d\'accès Meta a expiré ou est invalide — collez un jeton permanent (System User) dans Hub › WhatsApp.';
  if (code === 131056) return 'trop de messages envoyés à ce numéro en peu de temps.';
  return fallback || `erreur ${code}`;
}

async function graph(route, { method = 'POST', body, raw, headers = {} } = {}) {
  const d = readConfig();
  if (!d.accessToken) throw new Error('WhatsApp n\'est pas configuré.');
  const init = { method, headers: { Authorization: `Bearer ${d.accessToken}`, ...headers } };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  if (raw !== undefined) init.body = raw;
  const res = await fetch(route.startsWith('http') ? route : `${GRAPH_URL}/${route}`, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(explainError(e.code, e.error_data?.details || e.message || `HTTP ${res.status}`));
    err.code = e.code;
    throw err;
  }
  return json;
}

const phone = () => readConfig().phoneNumberId;

export async function sendText(to, text) {
  const parts = chunkText(toWhatsApp(text));
  if (isWeb()) { for (const body of parts) await web.sendText(to, body); return parts.length; }
  for (const body of parts) {
    await graph(`${phone()}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } } });
  }
  return parts.length;
}

/** Up to three reply buttons: [{ id, title }]. */
export async function sendButtons(to, text, buttons) {
  if (isWeb()) {
    // a personal account cannot send buttons: a numbered list, mapped back by applyButtonReply
    const list = buttons.slice(0, 3);
    webButtons.set(to, list);
    await sendText(to, `${text}\n\n${list.map((b, i) => `${i + 1}. ${b.title}`).join('\n')}\n\nRéponds par le numéro.`);
    return;
  }
  const body = chunkText(toWhatsApp(text), 1000)[0] || '…';
  await graph(`${phone()}/messages`, {
    body: {
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
      interactive: { type: 'button', body: { text: body }, action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: buttonTitle(b.title) } })) } },
    },
  });
}

/** The blue ticks, and "typing…" while the reply is being written. */
export async function markRead(messageId) {
  if (isWeb()) return web.markRead(messageId);
  try {
    await graph(`${phone()}/messages`, { body: { messaging_product: 'whatsapp', status: 'read', message_id: messageId, typing_indicator: { type: 'text' } } });
  } catch (e) { log('INFO', `whatsapp: mark read failed: ${e.message}`); }
}

/** A voice note or a picture someone sent: { buf, mime }. */
export async function downloadMedia(mediaId) {
  if (isWeb()) {
    if (!mediaId) throw new Error('fichier non reçu');
    return { buf: web.takeMedia(mediaId), mime: '' };
  }
  const meta = await graph(encodeURIComponent(mediaId), { method: 'GET' });
  if (!meta.url) throw new Error('Média introuvable.');
  const d = readConfig();
  const res = await fetch(meta.url, { headers: { Authorization: `Bearer ${d.accessToken}` } });
  if (!res.ok) throw new Error(`Téléchargement du média : HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error('Fichier trop gros.');
  return { buf, mime: meta.mime_type || res.headers.get('content-type') || '' };
}

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain', md: 'text/plain', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const mimeFor = (name) => MIME[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';

/** A workspace file as a document (or a picture, shown inline). */
export async function sendFile(to, abs, caption = '') {
  const name = path.basename(abs);
  const mime = mimeFor(name);
  const buf = readFileSync(abs);
  if (buf.length > 90 * 1024 * 1024) throw new Error('Fichier trop gros pour WhatsApp (100 Mo).');
  if (isWeb()) return web.sendFile(to, abs, { name, mime, caption: caption.slice(0, 1000) });
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([buf], { type: mime }), name);
  const up = await graph(`${phone()}/media`, { raw: form });
  const image = /^image\/(png|jpeg)$/.test(mime);
  const media = image ? { id: up.id, caption: caption.slice(0, 1000) } : { id: up.id, filename: name, caption: caption.slice(0, 1000) };
  await graph(`${phone()}/messages`, { body: { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: image ? 'image' : 'document', [image ? 'image' : 'document']: media } });
}

/** Test button: is the token good, and which number is it? */
export async function checkNumber() {
  if (isWeb()) {
    const w = web.status();
    return w.state === 'open' ? { ok: true, number: w.me ? `+${w.me}` : '', name: '' } : { ok: false, error: 'WhatsApp n\'est pas connecté : scanne le QR code dans Hub › WhatsApp.' };
  }
  try {
    const r = await graph(`${phone()}?fields=display_phone_number,verified_name,quality_rating`, { method: 'GET' });
    return { ok: true, number: r.display_phone_number || '', name: r.verified_name || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Linked device ('web') ────────────────────────────────────────────────────

const webButtons = new Map();   // number → the buttons last sent as a numbered list

/**
 * Pure. A typed answer to a numbered list of buttons ("2", or the title
 * itself) becomes the button reply the bridge waits for; anything else is
 * left as it is.
 */
export function applyButtonReply(m, buttons) {
  if (!buttons?.length || m?.type !== 'text') return m;
  const t = String(m.text || '').trim();
  const n = /^\d$/.test(t) ? Number(t) : 0;
  const b = (n >= 1 && n <= buttons.length) ? buttons[n - 1] : buttons.find((x) => x.title.toLowerCase() === t.toLowerCase());
  return b ? { ...m, type: 'button', buttonId: b.id, text: b.title } : m;
}

/** A message from the linked number, in the shape parseWebhook gives. */
export function fromWeb(m) {
  const buttons = webButtons.get(m.from);
  const out = applyButtonReply({ ...m, mediaId: m.mediaPath || null }, buttons);
  if (buttons && m.type === 'text') webButtons.delete(m.from);
  return out;
}
