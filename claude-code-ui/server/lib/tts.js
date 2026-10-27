/*
 * Text to speech through Home Assistant, for the spoken call: the browser asks
 * POST /api/tts for one sentence at a time and plays the audio it gets back.
 * Home Assistant renders it with its own TTS engine (`tts_get_url`, then the
 * file from its tts_proxy) — a natural voice, and one that works where the
 * browser has no speech synthesis of its own (the Android app's webview).
 * The engine is TTS_ENGINE if set, else the first `tts.*` entity.
 */
import { SUPERVISOR_URL } from './config.js';
import { log } from './log.js';

const token = () => process.env.SUPERVISOR_TOKEN;
const core = (route, init = {}) => fetch(`${SUPERVISOR_URL}/core${route}`, {
  ...init,
  headers: { Authorization: `Bearer ${token()}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
});

let engineCache = { at: 0, id: null };

/** The TTS engine to use, or null when Home Assistant has none. Cached a minute. */
export async function ttsEngine() {
  if (process.env.TTS_ENGINE) return process.env.TTS_ENGINE;
  if (!token()) return null;
  if (Date.now() - engineCache.at < 60000) return engineCache.id;
  let id = null;
  try {
    const res = await core('/api/states');
    if (res.ok) id = (await res.json()).map((s) => s.entity_id).find((e) => e.startsWith('tts.')) || null;
  } catch { /* none */ }
  engineCache = { at: Date.now(), id };
  return id;
}

/** One utterance as audio: { body: Buffer, contentType }. */
export async function synthesize(text, lang = 'fr-FR') {
  const message = String(text || '').trim().slice(0, 1500);
  if (!message) throw new Error('Nothing to say.');
  const engine = await ttsEngine();
  if (!engine) throw new Error('Home Assistant has no text-to-speech engine.');
  const started = Date.now();
  // Google Translate wants "fr"; engines that know regions accept "fr-FR" too,
  // but the base language is what every engine understands.
  const language = /google/.test(engine) ? String(lang).split('-')[0] : lang;
  const r = await core('/api/tts_get_url', { method: 'POST', body: JSON.stringify({ engine_id: engine, message, language }) });
  if (!r.ok) throw new Error(`Text-to-speech failed (HTTP ${r.status}).`);
  const { path } = await r.json();
  const audio = await core(path);
  if (!audio.ok) throw new Error(`Text-to-speech audio failed (HTTP ${audio.status}).`);
  const body = Buffer.from(await audio.arrayBuffer());
  log('INFO', `tts: ${message.length} chars → ${body.length} bytes in ${Date.now() - started} ms (${engine})`);
  return { body, contentType: audio.headers.get('content-type') || 'audio/mpeg' };
}
