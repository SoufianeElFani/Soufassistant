/*
 * Speech to text for the browsers that have none of their own (the Home
 * Assistant phone app's webview, Firefox): the browser records the microphone,
 * sends 16 kHz 16-bit mono PCM to POST /api/stt, and this module has a Whisper
 * server transcribe it over the Wyoming protocol — the official "Whisper" app
 * (core-whisper:10300 on the Supervisor network), local and private.
 *
 * Wyoming is newline-delimited JSON events, each optionally followed by a JSON
 * `data` block (`data_length` bytes, newer servers) and a binary payload
 * (`payload_length` bytes). Older servers put `data` in the header line itself;
 * the reader accepts both. The Whisper app listens on IPv4 only, hence family 4.
 */
import net from 'net';
import { log } from './log.js';

export const STT_HOST = process.env.WHISPER_HOST || 'core-whisper';
export const STT_PORT = parseInt(process.env.WHISPER_PORT || '10300', 10);
const RATE = 16000;
const MAX_AUDIO_BYTES = RATE * 2 * 120;   // two minutes

/** One Wyoming event as bytes. Exported for the tests. */
export function encodeEvent(type, data = {}, payload = null) {
  const dataBuf = Buffer.from(JSON.stringify(data), 'utf8');
  const header = { type, version: '1.5.2', data_length: dataBuf.length };
  if (payload) header.payload_length = payload.length;
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), dataBuf, ...(payload ? [payload] : [])]);
}

/** Incremental Wyoming reader: feed it bytes, it calls onEvent({type, data}). */
export function makeReader(onEvent) {
  let buf = Buffer.alloc(0);
  let pending = null;   // header waiting for its data/payload bytes
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!pending) {
        const nl = buf.indexOf(0x0a);
        if (nl < 0) return;
        pending = JSON.parse(buf.subarray(0, nl).toString('utf8'));
        buf = buf.subarray(nl + 1);
      }
      const need = (pending.data_length || 0) + (pending.payload_length || 0);
      if (buf.length < need) return;
      let data = pending.data || {};
      if (pending.data_length) data = { ...data, ...JSON.parse(buf.subarray(0, pending.data_length).toString('utf8')) };
      buf = buf.subarray(need);
      const ev = { type: pending.type, data };
      pending = null;
      onEvent(ev);
    }
  };
}

/**
 * Transcribe raw PCM (16 kHz, 16-bit little-endian, mono). Resolves to the
 * text ('' for silence); rejects when no Whisper server answers.
 */
export function transcribe(pcm, { language = 'fr', host = STT_HOST, port = STT_PORT, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!pcm?.length) { resolve(''); return; }
    if (pcm.length > MAX_AUDIO_BYTES) { reject(new Error('Recording too long.')); return; }
    const started = Date.now();
    const sock = net.connect({ host, port, family: 4 });
    let done = false;
    const finish = (err, text) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else {
        log('INFO', `stt: ${(pcm.length / (RATE * 2)).toFixed(1)}s of audio → ${text.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        resolve(text);
      }
    };
    sock.setTimeout(timeoutMs, () => finish(new Error('Speech recognition timed out.')));
    sock.on('error', (e) => finish(new Error(`Speech recognition is not available (${e.code || e.message}). Is the Whisper app running?`)));
    sock.on('data', makeReader((ev) => {
      if (ev.type === 'transcript') finish(null, String(ev.data?.text || '').trim());
      else if (ev.type === 'error') finish(new Error(ev.data?.text || 'Speech recognition failed.'));
    }));
    sock.on('close', () => finish(new Error('Speech recognition closed the connection.')));
    sock.on('connect', () => {
      const fmt = { rate: RATE, width: 2, channels: 1 };
      sock.write(encodeEvent('transcribe', { language: String(language).split('-')[0] }));
      sock.write(encodeEvent('audio-start', fmt));
      for (let i = 0; i < pcm.length; i += 32000) sock.write(encodeEvent('audio-chunk', fmt, pcm.subarray(i, i + 32000)));
      sock.write(encodeEvent('audio-stop', {}));
    });
  });
}

/** Whether a Whisper server answers (the UI offers server-side recognition then). */
export function sttAvailable({ host = STT_HOST, port = STT_PORT } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, family: 4 });
    const end = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => end(false));
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}
