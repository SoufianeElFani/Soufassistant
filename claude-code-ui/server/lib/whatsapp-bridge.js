/*
 * WhatsApp conversations — the assistant reachable from the chat app the
 * household already uses (like Hermes Agent's messaging gateway).
 *
 * Meta → Home Assistant (whatsapp-relay.js) → POST /whatsapp/webhook here. The
 * call is checked against Meta's signature (the app secret), acknowledged at
 * once (Meta retries anything slow). Or, with a number linked by QR code, the
 * messages come from whatsapp-web.js instead. Each message is handled in order
 * per person:
 *
 *   - only the numbers listed in Hub › WhatsApp are answered; others are ignored
 *   - one conversation per person, resumed across messages (a fresh one after
 *     a day of silence, or on /nouveau); a message arriving while a reply is
 *     being written joins that same turn (the streamed input channel)
 *   - voice notes are transcribed by the Whisper app (opusdec → 16 kHz PCM),
 *     pictures and documents are saved like attachments
 *   - nobody is at a screen: what a tool call may do is whatsapp-policy.js —
 *     allowed, refused, or put to the person as Oui / Non buttons; a question
 *     (AskUserQuestion) arrives as buttons or a numbered list, and the next
 *     message is the answer
 *   - profiles: `owner` gets the full assistant (CLAUDE.md, memory, skills, the
 *     app's tools); `family` gets the house only, without the owner's
 *     instructions or memory (settingSources: []), with a memory of their own
 *   - nothing confidential goes this way: Confidentiel folders and the drop
 *     folder are fenced off, on top of the vault guard every run has
 *
 * A run is its own SDK query (like scheduler.js), not a runQuery: it never
 * touches the conversation on screen. Its transcript is an ordinary session,
 * titled "📱 <name> · …", so it can be read later from the Sessions panel.
 */
import express from 'express';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { WORK_DIR, PLUGINS, DATA_DIR, HOME_DIR, UPLOAD_DIR } from './config.js';
import { log } from './log.js';
import { writeFileAtomic } from './atomic.js';
import { makeInputChannel } from './input-channel.js';
import { ADDON_CONFIGS_HOOKS } from './permissions.js';
import { formatQuestionDenial } from './dialogs.js';
import { MCP_FREE_SETTINGS } from './mcp.js';
import { internalTools } from './internal-tools.js';
import { workspaceRoot } from './workspace.js';
import { disabledOverrides } from './skills.js';
import { protectedRoots } from './vault.js';
import { depotDir } from './depot.js';
import { renameSession } from './session-tools.js';
import { describeAttachments } from './uploads.js';
import { transcribe } from './stt.js';
import { afterRun as reviewMemory } from './memory-review.js';
import * as wa from './whatsapp.js';
import * as relay from './whatsapp-relay.js';
import * as web from './whatsapp-web.js';
import { classify, yesNo } from './whatsapp-policy.js';

const execFileP = promisify(execFile);
const SESSIONS_FILE = () => path.join(DATA_DIR, 'whatsapp-sessions.json');
const IDLE_NEW_MS = 24 * 3600 * 1000;
const RUN_TIMEOUT_MS = parseInt(process.env.WHATSAPP_RUN_TIMEOUT_MS || '900000', 10);     // 15 min
const ANSWER_TIMEOUT_MS = parseInt(process.env.WHATSAPP_ANSWER_TIMEOUT_MS || '1800000', 10); // 30 min
const PROGRESS_MS = parseInt(process.env.WHATSAPP_PROGRESS_MS || '60000', 10);

let sessions = {};                  // number → { sessionId, lastRunAt, lastInboundAt }
const convs = new Map();            // number → { queue, run, waiting, uploads }
const seen = [];                    // message ids already handled (Meta redelivers)

export function load() {
  try { if (existsSync(SESSIONS_FILE())) sessions = JSON.parse(readFileSync(SESSIONS_FILE(), 'utf8')) || {}; }
  catch (e) { log('WARN', `whatsapp: sessions unreadable: ${e.message}`); }
  web.onMessage((m) => {
    if (!wa.isWeb() || wa.readConfig().enabled === false) return;
    handleMessages([wa.fromWeb(m)]).catch((e) => log('ERROR', `whatsapp: ${e?.message || e}`));
  });
  if (wa.isWeb() && web.linked()) web.start();
}
function save() { try { writeFileAtomic(SESSIONS_FILE(), JSON.stringify(sessions)); } catch (e) { log('WARN', `whatsapp: ${e.message}`); } }
const sess = (n) => (sessions[n] ||= {});
const masked = (n) => `…${String(n).slice(-4)}`;

/** When each person last wrote — a free-form message only reaches them for 24 h after. */
export const lastInbound = (number) => sessions[number]?.lastInboundAt || null;

function convFor(number) {
  if (!convs.has(number)) convs.set(number, { queue: Promise.resolve(), run: null, waiting: null, uploads: new Set() });
  return convs.get(number);
}

async function reply(number, text) {
  try { await wa.sendText(number, text); } catch (e) { log('WARN', `whatsapp: reply to ${masked(number)} failed: ${e.message}`); }
}

// ── Voice notes ──────────────────────────────────────────────────────────────

/** Pure. A 16-bit WAV → 16-bit mono PCM (stereo averaged). */
export function wavToPcm(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let channels = 1, bits = 16, data = null;
  for (let off = 12; off + 8 <= wav.length;) {
    const id = wav.toString('ascii', off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = wav.readUInt16LE(off + 10); bits = wav.readUInt16LE(off + 22); }
    if (id === 'data') { data = wav.subarray(off + 8, Math.min(wav.length, off + 8 + size)); break; }
    off += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no audio data');
  if (bits !== 16) throw new Error(`${bits}-bit audio`);
  if (channels === 1) return Buffer.from(data);
  const frames = Math.floor(data.length / (2 * channels));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += data.readInt16LE((i * channels + c) * 2);
    out.writeInt16LE(Math.round(sum / channels), i * 2);
  }
  return out;
}

/** A WhatsApp voice note (Ogg Opus) → 16 kHz mono PCM for Whisper. */
async function voiceToPcm(buf) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wa-voice-'));
  try {
    const src = path.join(dir, 'in.ogg');
    const out = path.join(dir, 'out.wav');
    writeFileSync(src, buf);
    await execFileP('opusdec', ['--quiet', '--rate', '16000', '--force-wav', src, out], { timeout: 60000 });
    return wavToPcm(readFileSync(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── Prompts ──────────────────────────────────────────────────────────────────

/** The system-prompt section a WhatsApp turn adds. Pure. */
export function whatsappPrompt(contact) {
  const owner = contact.profile === 'owner';
  return [
    '## WhatsApp',
    `This conversation happens over WhatsApp: you are talking with ${contact.name}${contact.person ? ` (${contact.person} in Home Assistant)` : ''}, ` +
      (owner ? 'the owner of the house and of this assistant.' : 'a member of the household.'),
    'Answer in their language (usually French), briefly, as in a messaging app: a few sentences, no tables or headings,',
    'short lists with "- ", *bold* for what matters. They only see your final replies, never your tools: do not announce',
    'what you are about to do — do it, then say the result.',
    'To act on the house use ha-tools, one command per call, never chained with ; && or |. Sensitive actions (locks,',
    'the alarm, the garage door, restarting Home Assistant) are put to them as a Oui / Non button: just call the tool.',
    '"J\'arrive" / "je rentre": check what matters for arriving home (heating, lights for the time of day, the garage',
    'door, the alarm) and do or offer the essentials, without switching everything on unasked.',
    'Voice messages arrive transcribed (🎤) and may contain recognition mistakes.',
    'WhatsApp goes through Meta\'s servers: never put anything confidential (Equans, the Confidentiel folders, the',
    'confidential drop folder) in this conversation.',
    owner
      ? 'To tell another household member something, use send_whatsapp (they must have written to the assistant in the last 24 hours); send_whatsapp_file sends a workspace document.'
      : 'Household profile: you may look at and control the house and search the web; no files or work documents. If asked for something else, say so simply. Your memory of this person is separate from the owner\'s. ' +
        'Useful commands: `ha-tools entities <word>` (find an entity), `ha-tools state <entity_id>`, `ha-tools areas`, ' +
        '`ha-tools history <entity_id> 6`, `ha-tools call <domain> <service> \'{"entity_id": "…"}\'`.',
    'The person can type /nouveau for a new conversation and /stop to stop you.',
  ].join(' ');
}

const HELP = [
  '*Soufassistant sur WhatsApp*',
  'Écris ou envoie un vocal, comme à une personne : « j\'arrive dans 20 minutes », « la porte du garage est fermée ? », « allume le salon ».',
  '- /nouveau : repartir de zéro',
  '- /stop : arrêter ce qui est en cours',
  'Les actions sensibles (serrure, alarme, garage) te sont demandées avec un bouton Oui / Non.',
].join('\n');

// ── Confidentiality fence (both profiles) ────────────────────────────────────
const CONF_WORD = /(^|[/"'\s])(Confidentiel|Depot_confidentiel)(\/|["'\s]|$)/;
export function confidentialFence(roots) {
  return async (input) => {
    const blob = JSON.stringify(input?.tool_input ?? '');
    let list = [];
    try { list = roots(); } catch {}
    if (CONF_WORD.test(blob) || list.some((r) => r && blob.includes(r))) {
      return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
        permissionDecisionReason: 'Pas de dossier confidentiel par WhatsApp : tout ce qui y passe transite par les serveurs de Meta. Propose de faire ce travail dans l\'app.' } };
    }
    return { continue: true };
  };
}
const fenceRoots = () => { const root = workspaceRoot(); return [...protectedRoots(root), depotDir(root)]; };

// ── Waiting for the person: Oui / Non, and questions ────────────────────────

function waitFor(number, conv, signal, take, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (conv.waiting === w) conv.waiting = null;
      resolve(v);
    };
    const w = { take: (m) => take(m, finish), cancel: () => finish(null) };
    conv.waiting = w;
    const timer = setTimeout(() => { onTimeout?.(); finish(null); }, ANSWER_TIMEOUT_MS);
    signal?.addEventListener('abort', () => finish(null), { once: true });
  });
}

async function askPermission(number, conv, summary, signal) {
  const id = randomUUID().slice(0, 8);
  const answer = waitFor(number, conv, signal, (m, finish) => {
    const fromButton = m.buttonId?.startsWith(`perm:${id}:`) ? m.buttonId.split(':')[2] : null;
    const d = fromButton || yesNo(m.text);
    if (!d) { reply(number, 'Réponds *Oui* ou *Non* (ou /stop).'); return true; }
    finish(d);
    return true;
  }, () => reply(number, '⌛ Pas de réponse : je n\'ai rien fait.'));
  try {
    await wa.sendButtons(number, `🔐 ${summary}\n\nJe peux ?`, [{ id: `perm:${id}:allow`, title: 'Oui' }, { id: `perm:${id}:deny`, title: 'Non' }]);
  } catch (e) {
    log('WARN', `whatsapp: could not ask ${masked(number)}: ${e.message}`);
    conv.waiting?.cancel();
  }
  return (await answer) === 'allow';
}

/** Pure. A typed answer to a numbered list: "2" or "1, 3" → labels; else the text itself. */
export function pickAnswer(text, labels, multi = false) {
  const t = String(text || '').trim();
  const nums = t.match(/^\s*\d+(\s*[,;et&]+\s*\d+)*\s*$/i) ? t.match(/\d+/g).map(Number) : null;
  if (nums && nums.every((n) => n >= 1 && n <= labels.length)) {
    const picked = [...new Set(nums)].map((n) => labels[n - 1]);
    return multi ? picked : picked[0];
  }
  const exact = labels.find((l) => l.toLowerCase() === t.toLowerCase());
  return exact ? (multi ? [exact] : exact) : t;
}

async function askQuestions(number, conv, input, signal) {
  const answers = {};
  for (const q of input.questions || []) {
    const opts = q.options || [];
    const labels = opts.map((o) => o.label);
    const id = randomUUID().slice(0, 8);
    const wait = waitFor(number, conv, signal, (m, finish) => {
      if (m.buttonId?.startsWith(`q:${id}:`)) { finish(labels[Number(m.buttonId.split(':')[2])] ?? m.text); return true; }
      if (!m.text) { reply(number, 'Réponds par écrit (ou /stop).'); return true; }
      finish(pickAnswer(m.text, labels, !!q.multiSelect));
      return true;
    });
    const details = opts.filter((o) => o.description).map((o) => `- *${o.label}* : ${o.description}`).join('\n');
    try {
      if (opts.length && opts.length <= 3 && !q.multiSelect) {
        await wa.sendButtons(number, `❓ ${q.question}${details ? `\n\n${details}` : ''}\n\n(ou réponds en quelques mots)`,
          opts.map((o, i) => ({ id: `q:${id}:${i}`, title: o.label })));
      } else {
        const list = opts.map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n');
        await wa.sendText(number, `❓ ${q.question}\n\n${list}\n\n${q.multiSelect ? 'Réponds par les numéros (ex. 1, 3)' : 'Réponds par le numéro'} ou en quelques mots.`);
      }
    } catch (e) { log('WARN', `whatsapp: question to ${masked(number)} failed: ${e.message}`); conv.waiting?.cancel(); }
    const a = await wait;
    if (a == null) return formatQuestionDenial(input, null);
    answers[q.header] = a;
  }
  return formatQuestionDenial(input, { answers });
}

// ── One run ──────────────────────────────────────────────────────────────────

export const familyMemoryDir = (number) => path.join(HOME_DIR, '.claude', 'whatsapp-memory', number);

function buildOptions(contact, conv, run) {
  const owner = contact.profile === 'owner';
  const opts = {
    cwd: WORK_DIR, abortController: run.abort, plugins: owner ? PLUGINS : PLUGINS.slice(0, 1),
    settings: { ...MCP_FREE_SETTINGS },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: whatsappPrompt(contact) },
    hooks: { PreToolUse: [...ADDON_CONFIGS_HOOKS.PreToolUse, { hooks: [confidentialFence(fenceRoots)] }] },
  };
  let allowedMcp = [];
  if (owner) {
    try {
      const internal = internalTools({ targetDir: () => path.join(workspaceRoot(), 'Images'), workspaceRoot, key: () => `whatsapp:${contact.number}`, chat: false });
      opts.mcpServers = { soufassistant: internal.server };
      allowedMcp = internal.allowed;
    } catch (e) { log('WARN', `whatsapp: app tools unavailable: ${e.message}`); }
    const off = disabledOverrides() || {};
    if (Object.keys(off).length) opts.settings.skillOverrides = off;
  } else {
    // Not the owner's CLAUDE.md, memory or skills: a memory of this person's own.
    opts.settingSources = [];
    const dir = familyMemoryDir(contact.number);
    try { mkdirSync(dir, { recursive: true }); } catch {}
    opts.settings = { ...opts.settings, autoMemoryEnabled: true, autoMemoryDirectory: dir };
    opts.disallowedTools = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task'];
  }
  opts.canUseTool = async (toolName, input, { signal } = {}) => {
    if (toolName === 'AskUserQuestion') return askQuestions(contact.number, conv, input, signal);
    // what they sent us themselves can always be looked at
    if (toolName === 'Read' && conv.uploads.has(path.resolve(String(input.file_path || '')))) return { behavior: 'allow', updatedInput: input };
    const c = classify(toolName, input, contact.profile, { allowedMcp });
    if (c.decision === 'allow') return { behavior: 'allow', updatedInput: input };
    if (c.decision === 'deny') return { behavior: 'deny', message: c.reason };
    const ok = await askPermission(contact.number, conv, c.summary, signal);
    return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `${contact.name} a refusé (ou n'a pas répondu).` };
  };
  return opts;
}

async function startRun(contact, conv, text, { retried = false } = {}) {
  const number = contact.number;
  const s = sess(number);
  const fresh = !s.sessionId || Date.now() - (s.lastRunAt || 0) > IDLE_NEW_MS;
  const run = { channel: makeInputChannel(text), abort: new AbortController(), pushed: 0, results: 0, done: false, sent: false, buffer: '' };
  let finishedResolve;
  run.finished = new Promise((r) => { finishedResolve = r; });
  conv.run = run;
  const opts = buildOptions(contact, conv, run);
  if (!fresh) opts.resume = s.sessionId;
  log('INFO', `whatsapp: run for ${contact.name} (${contact.profile}) ${fresh ? 'new conversation' : 'resumed'} promptLen=${text.length}`);

  const progress = setTimeout(() => { if (!run.sent && !run.done && !conv.waiting) reply(number, '⏳ Je m\'en occupe…'); }, PROGRESS_MS);
  const timeout = setTimeout(() => run.abort.abort(), RUN_TIMEOUT_MS);
  let sessionId = fresh ? null : s.sessionId;
  let failed = null;
  try {
    for await (const ev of query({ prompt: run.channel.iterable, options: opts })) {
      if (ev.type === 'system' && ev.subtype === 'init') {
        if (ev.session_id && ev.session_id !== sessionId) {
          sessionId = ev.session_id;
          s.sessionId = sessionId;
          save();
          if (fresh) try { renameSession(sessionId, `📱 ${contact.name} · ${text.replace(/\s+/g, ' ').slice(0, 70)}`); } catch {}
        }
      } else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        for (const b of ev.message?.content || []) if (b.type === 'text' && b.text?.trim()) run.buffer += `${run.buffer ? '\n\n' : ''}${b.text.trim()}`;
      } else if (ev.type === 'result') {
        const out = run.buffer.trim();
        run.buffer = '';
        if (out) { run.sent = true; await reply(number, out); }
        else if (ev.subtype !== 'success') { run.sent = true; await reply(number, '⚠️ Je n\'ai pas pu terminer cette demande.'); }
        run.results += 1;
        if (run.results > run.pushed) run.channel.close();
      }
    }
  } catch (err) {
    failed = String(err?.message || err);
  } finally {
    clearTimeout(progress);
    clearTimeout(timeout);
    run.done = true;
    run.channel.close();
    if (conv.run === run) conv.run = null;
    conv.waiting?.cancel();
    s.lastRunAt = Date.now();
    save();
    finishedResolve();
  }
  const aborted = run.abort.signal.aborted;
  if (failed && !aborted) {
    // A conversation that cannot be resumed any more: start a fresh one, once.
    if (!fresh && !run.results && !retried) {
      log('WARN', `whatsapp: resume failed (${failed.slice(0, 120)}) — starting a new conversation`);
      s.sessionId = null;
      save();
      return startRun(contact, conv, text, { retried: true });
    }
    log('WARN', `whatsapp: run for ${contact.name} failed: ${failed}`);
    await reply(number, `⚠️ Erreur : ${failed.slice(0, 300)}`);
  } else if (aborted && run.results === 0 && !run.stopped) {
    await reply(number, '⌛ C\'était trop long, j\'ai arrêté. Réessaie en plus simple, ou fais-le depuis l\'app.');
  }
  if (contact.profile === 'owner' && sessionId && run.results) reviewMemory({ sessionId, turns: run.results, source: 'whatsapp' });
}

// ── Incoming messages ────────────────────────────────────────────────────────

async function toPrompt(contact, conv, m) {
  if (m.type === 'text' || m.type === 'button') return m.text;
  if (m.type === 'location' && m.location) {
    const l = m.location;
    return `📍 Position partagée : ${l.lat}, ${l.lon}${l.name ? ` (${l.name})` : ''}${l.address ? ` — ${l.address}` : ''}`;
  }
  if (m.type === 'audio') {
    try {
      const { buf } = await wa.downloadMedia(m.mediaId);
      const said = await transcribe(await voiceToPcm(buf), { language: 'fr' });
      if (!said) { await reply(contact.number, 'Je n\'ai rien entendu dans ce vocal.'); return null; }
      return `🎤 ${said}`;
    } catch (e) {
      log('WARN', `whatsapp: voice note failed: ${e.message}`);
      await reply(contact.number, `Je n'ai pas pu écouter ce vocal (${e.message}). Écris-le-moi plutôt.`);
      return null;
    }
  }
  if (m.type === 'image' || m.type === 'document') {
    try {
      const { buf, mime: got } = await wa.downloadMedia(m.mediaId);
      const mime = got || m.mime || '';
      const ext = (m.filename && path.extname(m.filename)) || (/png/.test(mime) ? '.png' : /pdf/.test(mime) ? '.pdf' : /webp/.test(mime) ? '.webp' : '.jpg');
      const safe = (m.filename || `whatsapp${ext}`).replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
      mkdirSync(UPLOAD_DIR, { recursive: true });
      const abs = path.join(UPLOAD_DIR, `${Date.now()}-wa-${safe}`);
      writeFileSync(abs, buf);
      conv.uploads.add(abs);
      return describeAttachments(m.text, [{ path: abs }]);
    } catch (e) {
      await reply(contact.number, `Je n'ai pas pu récupérer ce fichier (${e.message}).`);
      return null;
    }
  }
  await reply(contact.number, 'Je ne lis pas encore ce type de message : écris-moi ou envoie un vocal.');
  return null;
}

async function onMessage(contact, m) {
  const number = contact.number;
  const conv = convFor(number);
  sess(number).lastInboundAt = Date.now();
  save();
  wa.markRead(m.id);

  const cmd = m.type === 'text' ? m.text.trim().toLowerCase() : '';
  if (/^\/(stop|arrete|arrête)$/.test(cmd)) {
    if (conv.run) { conv.run.stopped = true; conv.run.abort.abort(); await reply(number, '⏹ Arrêté.'); } else await reply(number, 'Rien en cours.');
    return;
  }
  if (/^\/(nouveau|new|reset)$/.test(cmd)) {
    if (conv.run) { conv.run.stopped = true; conv.run.abort.abort(); }
    sess(number).sessionId = null;
    save();
    await reply(number, '🆕 Nouvelle conversation. Je t\'écoute.');
    return;
  }
  if (/^\/(aide|help)$/.test(cmd)) { await reply(number, HELP); return; }
  if (conv.waiting && conv.waiting.take(m)) return;

  const text = await toPrompt(contact, conv, m);
  if (!text) return;
  if (conv.run && !conv.run.done) {
    if (conv.run.channel.push(text)) { conv.run.pushed += 1; return; }
    await conv.run.finished;   // past its last reply: let it close, then start the next
  }
  startRun(contact, conv, text).catch((e) => log('ERROR', `whatsapp: run crashed: ${e?.message || e}`));
}

export async function handleWebhook(body) {
  const { messages, failures } = wa.parseWebhook(body);
  for (const f of failures) log('WARN', `whatsapp: delivery to ${masked(f.to)} failed: ${wa.explainError(f.code, f.title)}`);
  return handleMessages(messages);
}

export async function handleMessages(messages) {
  for (const m of messages) {
    if (!m.id || seen.includes(m.id)) continue;
    seen.push(m.id);
    if (seen.length > 500) seen.shift();
    const contact = wa.findContact(m.from);
    if (!contact) { log('INFO', `whatsapp: message from an unknown number ${masked(m.from)} ignored`); continue; }
    const conv = convFor(contact.number);
    // one person's messages in order; a run itself is never awaited here (it may be waiting for their next message)
    conv.queue = conv.queue.then(() => onMessage(contact, m)).catch((e) => log('ERROR', `whatsapp: ${e?.message || e}`));
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function registerWhatsAppRoutes(app) {
  // Meta's one-time check when the webhook is registered: echo the challenge.
  app.get('/whatsapp/webhook', (req, res) => {
    const ok = req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === wa.verifyToken();
    if (!ok) return res.status(403).type('text/plain').send('forbidden');
    log('INFO', 'whatsapp: webhook verified by Meta');
    res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
  });
  app.post('/whatsapp/webhook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const cfg = wa.readConfig();
    if (!wa.verifySignature(req.body, req.get('x-hub-signature-256'), cfg.appSecret)) {
      log('WARN', 'whatsapp: webhook call with a bad or missing signature refused');
      return res.status(403).type('text/plain').send('bad signature');
    }
    res.type('text/plain').send('ok');
    if (cfg.enabled === false) return;
    let body;
    try { body = JSON.parse(req.body.toString('utf8')); } catch { return; }
    handleWebhook(body).catch((e) => log('ERROR', `whatsapp: ${e?.message || e}`));
  });

  // Hub › WhatsApp
  const json = express.json({ limit: '64kb' });
  const wrap = (fn) => async (req, res) => { try { res.json(await fn(req)); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } };
  app.get('/api/whatsapp', wrap(async () => {
    const st = wa.status();
    return {
      ...st, ready: wa.whatsappReady(), relay: await relay.relayStatus(),
      webhookUrl: st.publicUrl ? `${st.publicUrl}${relay.RELAY_PATH}` : '',
      contacts: st.contacts.map((c) => ({ ...c, lastInboundAt: lastInbound(c.number) })),
    };
  }));
  app.get('/api/whatsapp/recipients', wrap(() => ({ contacts: wa.contacts().map(({ number, name }) => ({ number, name })) })));
  app.post('/api/whatsapp/config', json, wrap((req) => wa.setConfig(req.body || {})));
  app.post('/api/whatsapp/contacts', json, wrap((req) => wa.setContacts(req.body?.contacts)));
  app.post('/api/whatsapp/forget', json, wrap(() => wa.forget()));
  // the linked-device way: show a QR code, unlink
  app.post('/api/whatsapp/web/start', json, wrap(() => {
    const r = wa.setConfig({ transport: 'web' });
    return r.ok ? { ok: true, web: web.start() } : r;
  }));
  app.post('/api/whatsapp/web/logout', json, wrap(() => web.logout()));
  app.post('/api/whatsapp/transport', json, wrap((req) => {
    const r = wa.setConfig({ transport: req.body?.transport });
    if (r.ok && req.body?.transport === 'cloud') web.stop();
    if (r.ok && req.body?.transport === 'web' && web.linked()) web.start();
    return r;
  }));
  app.post('/api/whatsapp/relay/install', json, wrap(() => relay.install()));
  app.post('/api/whatsapp/relay/restart', json, wrap(() => relay.restartHomeAssistant()));
  app.post('/api/whatsapp/test', json, wrap(async (req) => {
    const r = await wa.checkNumber();
    if (!r.ok || !req.body?.to) return r;
    const c = wa.findContact(req.body.to);
    if (!c) return { ok: false, error: 'Numéro inconnu.' };
    try { await wa.sendText(c.number, `👋 Bonjour ${c.name}, c'est Soufassistant. Réponds-moi ici quand tu veux (/aide pour l'aide).`); return { ...r, sent: true }; }
    catch (e) { return { ok: false, error: e.message }; }
  }));
}
