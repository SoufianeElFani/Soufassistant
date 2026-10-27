/*
 * 0.8.0: the voice endpoints a call uses where the browser has no speech
 * services of its own — POST /api/stt (to a Whisper server over Wyoming) and
 * POST /api/tts (Home Assistant's TTS engine) — against a fake Whisper and a
 * fake Supervisor.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import http from 'http';
import { startServer } from '../helpers/server-harness.mjs';
import { makeReader, encodeEvent } from '../../server/lib/stt.js';

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

describe('voice endpoints', () => {
  let h, whisper, ha;
  const seen = { language: null, ttsBody: null };
  before(async () => {
    whisper = net.createServer((sock) => {
      sock.on('data', makeReader((ev) => {
        if (ev.type === 'transcribe') seen.language = ev.data.language;
        if (ev.type === 'audio-stop') sock.write(encodeEvent('transcript', { text: ' Bonjour Claude ' }));
      }));
    });
    const wPort = await listen(whisper);
    ha = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.url === '/core/api/states') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([{ entity_id: 'tts.google_translate_en_com', state: 'unknown', attributes: {} }])); return; }
        if (req.url === '/core/api/tts_get_url') { seen.ttsBody = JSON.parse(body); res.end(JSON.stringify({ path: '/api/tts_proxy/abc.mp3' })); return; }
        if (req.url === '/core/api/tts_proxy/abc.mp3') { res.setHeader('Content-Type', 'audio/mpeg'); res.end(Buffer.from('ID3fakeaudio')); return; }
        res.statusCode = 404; res.end('{}');
      });
    });
    const haPort = await listen(ha);
    h = await startServer({ env: {
      WHISPER_HOST: '127.0.0.1', WHISPER_PORT: String(wPort),
      HA_SUPERVISOR_URL: `http://127.0.0.1:${haPort}`, SUPERVISOR_TOKEN: 'test-token',
    } });
  });
  after(async () => { await h.stop(); whisper.close(); ha.close(); });

  test('status says both are available', async () => {
    const r = await fetch(`${h.baseUrl}/api/voice/status`);
    assert.deepEqual(await r.json(), { stt: true, tts: true });
  });

  test('speech to text: PCM in, the transcript out', async () => {
    const pcm = Buffer.alloc(16000 * 2);   // one second of silence
    const r = await fetch(`${h.baseUrl}/api/stt?lang=fr-BE`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm,
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { text: 'Bonjour Claude' });
    assert.equal(seen.language, 'fr');
  });

  test('text to speech: the audio Home Assistant rendered', async () => {
    const r = await fetch(`${h.baseUrl}/api/tts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Bonjour !', lang: 'fr-FR' }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal(Buffer.from(await r.arrayBuffer()).toString(), 'ID3fakeaudio');
    assert.deepEqual(seen.ttsBody, { engine_id: 'tts.google_translate_en_com', message: 'Bonjour !', language: 'fr' });
  });

  test('no Whisper: a clear 503, not a hang', async () => {
    const h2 = await startServer({ env: { WHISPER_HOST: '127.0.0.1', WHISPER_PORT: '1' } });
    try {
      const st = await (await fetch(`${h2.baseUrl}/api/voice/status`)).json();
      assert.equal(st.stt, false);
      const r = await fetch(`${h2.baseUrl}/api/stt`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(32000) });
      assert.equal(r.status, 503);
      assert.match((await r.json()).error, /Whisper/);
    } finally { await h2.stop(); }
  });
});
