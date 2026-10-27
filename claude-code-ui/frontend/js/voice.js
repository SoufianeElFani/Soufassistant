/*
 * Voice: dictating into the message box, and calling Claude.
 *
 * Listening has two engines:
 *   browser  the Web Speech API's SpeechRecognition (Chrome, Edge, Safari):
 *            fast, but the audio goes to the browser maker's service, and
 *            it is missing from the Home Assistant phone app's webview.
 *   whisper  the microphone is recorded here (getUserMedia), cut into
 *            utterances by a small voice-activity detector, and sent to
 *            POST api/stt, where the Whisper app on the HA box transcribes it
 *            (server/lib/stt.js): local and private, a few seconds per phrase.
 * Speaking has two as well: Home Assistant's own TTS engine (POST api/tts, a
 * natural voice, played through Web Audio — works in the webview too) and the
 * browser's speechSynthesis. "Auto" picks browser listening where it exists,
 * else Whisper; and Home Assistant's voice where it has one, else the browser's.
 *
 *   🎤 dictation  what you say goes into the box, for you to read and send.
 *   📞 call       a full-screen call: Claude listens, sends what you said when
 *                 you pause, starts speaking its answer from the first finished
 *                 sentence (it does not wait for the whole reply), then listens
 *                 again. Tap the circle to interrupt it or to send now; with
 *                 Whisper listening you can also just talk over it. Prompts
 *                 carry `voice: true` (the server asks for short spoken answers)
 *                 and, with "Fast model during calls", Haiku at low effort.
 *
 * The microphone needs a secure page (HTTPS) and the user's permission.
 */
import { S } from './state.js';
import { inputForm, promptInput, wsBase } from './dom.js';
import { showToast } from './toast.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const synth = window.speechSynthesis || null;
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;

const $ = (id) => document.getElementById(id);
const micBtn = $('mic-btn');
const callBtn = $('talk-btn');
const screen = $('call-screen');
const orb = $('call-orb');
const statusEl = $('call-status');
const logEl = $('call-log');
const timerEl = $('call-timer');
const engineEl = $('call-engine');
const muteBtn = $('call-mute');
const hangupBtn = $('call-hangup');

let server = { stt: false, tts: false };
fetch(`${wsBase}/api/voice/status`).then((r) => r.json()).then((s) => { server = s || server; }).catch(() => {});

const pref = (k, d) => localStorage.getItem(k) || d;
/** French unless chosen otherwise in Settings — Whisper told the wrong language translates instead of transcribing. */
export function voiceLang() {
  return localStorage.getItem('voiceLang') || 'fr-FR';
}

/** Which engine listens: 'browser', 'whisper', or null (none usable here). */
function listenEngine() {
  const p = pref('voiceStt', 'auto');
  if (p === 'browser') return Recognition ? 'browser' : null;
  if (p === 'whisper') return canRecord ? 'whisper' : null;
  return Recognition ? 'browser' : canRecord ? 'whisper' : null;
}
/** Which voice speaks: 'ha' or 'browser'. */
function speakEngine() {
  const p = pref('voiceTts', 'auto');
  if (p === 'browser' && synth) return 'browser';
  if (p === 'ha') return 'ha';
  return server.tts || !synth ? 'ha' : 'browser';
}

function whyNoMic() {
  if (window.isSecureContext === false) return 'The microphone only works over HTTPS — open Home Assistant through its https address (your Tailscale address).';
  return 'This browser has no microphone access. Try Chrome or Edge, or the Home Assistant app over HTTPS.';
}
function explain(error) {
  const e = String(error?.name || error || '');
  if (/NotAllowed|not-allowed|service-not-allowed|Security/.test(e)) {
    return 'The microphone is blocked. Allow it for this page — in the Home Assistant app, allow the microphone for the app in the phone settings.';
  }
  if (/NotFound|audio-capture/.test(e)) return 'No microphone was found.';
  if (/network/.test(e)) return 'Speech recognition needs a network connection.';
  return `The microphone stopped (${e || 'unknown error'}).`;
}

function setInput(text) {
  promptInput.value = text;
  // The box's own listener resizes it, saves the draft and updates Send.
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Audio: one context, the microphone, voice activity ──────────────────────
let actx = null;
function audioCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}

/** 16 kHz 16-bit mono PCM from Float32 chunks at `rate`. Exported for the tests. */
export function toPcm16k(chunks, rate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const ratio = rate / 16000;
  const out = new Int16Array(Math.floor(total / ratio));
  let ci = 0, off = 0;
  const at = (i) => {   // sample i of the concatenation, walking forward only
    while (ci < chunks.length && i - off >= chunks[ci].length) { off += chunks[ci].length; ci++; }
    return ci < chunks.length ? chunks[ci][i - off] : 0;
  };
  for (let o = 0; o < out.length; o++) {
    const start = Math.floor(o * ratio), end = Math.max(start + 1, Math.floor((o + 1) * ratio));
    let sum = 0;
    for (let i = start; i < end; i++) sum += at(i);
    const v = Math.max(-1, Math.min(1, sum / (end - start)));
    out[o] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

async function transcribe(chunks, rate) {
  const pcm = toPcm16k(chunks, rate);
  if (pcm.length < 16000 * 0.3) return '';
  const r = await fetch(`${wsBase}/api/stt?lang=${encodeURIComponent(voiceLang())}`, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm.buffer,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Speech recognition failed (HTTP ${r.status}).`);
  return String(j.text || '').trim();
}

/**
 * The microphone, open for as long as it is needed, feeding a small state
 * machine: `listen(onUtterance)` waits for speech and hands over the
 * utterance once the speaker pauses; `watchBargeIn(fn)` fires when the user
 * talks loudly over the reply; `record()` / `finish()` keep everything
 * (dictation).
 */
async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = audioCtx();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  const frameMs = (4096 / ctx.sampleRate) * 1000;
  const mic = {
    rate: ctx.sampleRate, mode: 'idle', floor: 0.01, calib: 0,
    pre: [], chunks: [], speech: 0, silence: 0, loud: 0, onUtterance: null, onBargeIn: null, onLevel: null,
    close() { proc.disconnect(); src.disconnect(); sink.disconnect(); stream.getTracks().forEach((t) => t.stop()); },
    listen(fn) { Object.assign(mic, { mode: 'listen', onUtterance: fn, chunks: [], speech: 0, silence: 0 }); },
    record() { Object.assign(mic, { mode: 'record', chunks: [] }); },
    finish() { const c = mic.chunks; mic.mode = 'idle'; mic.chunks = []; return c; },
    endNow() { if (mic.mode === 'listen' && mic.speech > 0) done(); },
    watchBargeIn(fn) { Object.assign(mic, { mode: 'barge', onBargeIn: fn, loud: 0 }); },
    idle() { mic.mode = 'idle'; },
  };
  function done() {
    const chunks = mic.chunks;
    mic.mode = 'idle';
    mic.chunks = [];
    mic.onUtterance?.(chunks);
  }
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    let sq = 0;
    for (let i = 0; i < d.length; i++) sq += d[i] * d[i];
    const rms = Math.sqrt(sq / d.length);
    mic.onLevel?.(rms);
    // The room's own noise: learnt during the first half second, then tracked slowly while quiet.
    if (mic.calib < 500) { mic.floor = mic.calib ? (mic.floor + rms) / 2 : rms; mic.calib += frameMs; }
    const talkLevel = Math.max(0.012, mic.floor * 3.5);
    if (rms < talkLevel) mic.floor = mic.floor * 0.98 + rms * 0.02;
    if (mic.mode === 'record') { mic.chunks.push(d); return; }
    if (mic.mode === 'barge') {
      mic.loud = rms > Math.max(0.06, mic.floor * 8) ? mic.loud + frameMs : 0;
      if (mic.loud >= 350) { mic.mode = 'idle'; mic.onBargeIn?.(); }
      return;
    }
    if (mic.mode !== 'listen') return;
    if (rms >= talkLevel) {
      if (!mic.speech) mic.chunks = mic.pre.slice();   // keep the word's start
      mic.speech += frameMs;
      mic.silence = 0;
      mic.chunks.push(d);
    } else if (mic.speech) {
      mic.chunks.push(d);
      mic.silence += frameMs;
      if (mic.silence >= 850 && mic.speech >= 250) done();
      else if (mic.silence >= 850) { mic.speech = 0; mic.chunks = []; }   // a click, not speech
    }
    if (mic.speech && mic.speech + mic.silence > 30000) done();
    mic.pre.push(d);
    if (mic.pre.length > Math.ceil(300 / frameMs)) mic.pre.shift();
  };
  return mic;
}

// ── Dictation ───────────────────────────────────────────────────────────────
let dictation = null;   // { stop() }

function startDictation() {
  if (call.on) return;
  const engine = listenEngine();
  if (!engine) { showToast(whyNoMic(), { kind: 'warn' }); return; }
  const base = promptInput.value.replace(/\s+$/, '');
  const join = (t) => (base ? `${base} ${t}` : t);
  if (engine === 'browser') {
    const rec = new Recognition();
    rec.lang = voiceLang();
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setInput(join(text.trim()));
    };
    rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') showToast(explain(e.error), { kind: 'warn' }); };
    rec.onend = () => { dictation = null; micBtn.classList.remove('listening'); promptInput.focus(); };
    try { rec.start(); } catch { return; }
    dictation = { stop: () => rec.stop() };
  } else {
    dictation = { stop: () => {} };
    openMic().then((mic) => {
      if (!dictation) { mic.close(); return; }
      mic.record();
      dictation.stop = async () => {
        const chunks = mic.finish();
        mic.close();
        micBtn.classList.remove('listening');
        micBtn.classList.add('busy');
        const was = promptInput.placeholder;
        promptInput.placeholder = 'Transcribing…';
        try {
          const text = await transcribe(chunks, mic.rate);
          if (text) setInput(join(text));
        } catch (e) { showToast(e.message, { kind: 'warn' }); }
        finally {
          promptInput.placeholder = was;
          micBtn.classList.remove('busy');
          dictation = null;
          promptInput.focus();
        }
      };
    }).catch((e) => { dictation = null; micBtn.classList.remove('listening'); showToast(explain(e), { kind: 'warn' }); });
  }
  micBtn.classList.add('listening');
  micBtn.title = 'Stop dictation';
}

function stopDictation() {
  const d = dictation;
  micBtn.title = 'Dictate';
  if (d) d.stop();
  if (d && listenEngine() === 'browser') dictation = null;
}

// ── Speaking ────────────────────────────────────────────────────────────────
/** Plain, speakable text from a reply's markdown. Exported for the tests. */
export function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Where the complete sentences of a growing text end (0 = none yet), outside code. Exported for the tests. */
export function sentenceEnd(text, from = 0) {
  if (((text.slice(0, from).match(/```/g) || []).length % 2) === 1) return from;
  let cut = from;
  const re = /[.!?…:;](?=\s)|\n/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (((text.slice(0, end).match(/```/g) || []).length % 2) === 1) break;
    cut = end;
  }
  return cut;
}

function pickVoice(lang) {
  const voices = synth?.getVoices() || [];
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang && v.localService) || voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang?.replace('_', '-').startsWith(base)) || null;
}

/** The queue of sentences being said: fetched ahead (HA voice), played in order. */
const speech = {
  queue: [], playing: false, source: null, gen: 0,
  say(text) {
    const t = speakable(text);
    if (!/[\p{L}\p{N}]/u.test(t)) return;
    const engine = speakEngine();
    const item = { text: t, engine };
    if (engine === 'ha') item.audio = fetchAudio(t);
    speech.queue.push(item);
    speech.next();
  },
  async next() {
    if (speech.playing) return;
    const item = speech.queue.shift();
    if (!item) { call.onSpoken(); return; }
    speech.playing = true;
    const gen = speech.gen;
    call.setState('speaking');
    try {
      if (item.engine === 'ha') {
        const buf = await item.audio;
        if (gen !== speech.gen) return;
        await playBuffer(buf, gen);
      } else {
        await sayBrowser(item.text);
      }
    } catch (e) {
      if (gen !== speech.gen) return;
      // HA voice unavailable: say it with the browser's voice, if it has one.
      if (item.engine === 'ha' && synth) { try { await sayBrowser(item.text); } catch { /* skip */ } }
      else console.warn('voice:', e?.message || e);
    }
    if (gen !== speech.gen) return;
    speech.playing = false;
    speech.next();
  },
  stop() {
    speech.gen++;
    speech.queue = [];
    speech.playing = false;
    try { speech.source?.stop(); } catch { /* ended */ }
    speech.source = null;
    if (synth) synth.cancel();
  },
  get busy() { return speech.playing || speech.queue.length > 0; },
};

async function fetchAudio(text) {
  const r = await fetch(`${wsBase}/api/tts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang: voiceLang() }),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return audioCtx().decodeAudioData(await r.arrayBuffer());
}

function playBuffer(buf, gen) {
  return new Promise((resolve) => {
    const ctx = audioCtx();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => resolve();
    if (gen !== speech.gen) { resolve(); return; }
    speech.source = src;
    src.start();
  });
}

function sayBrowser(text) {
  return new Promise((resolve, reject) => {
    if (!synth) { reject(new Error('no speech synthesis')); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = voiceLang();
    const v = pickVoice(u.lang);
    if (v) u.voice = v;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? resolve() : reject(e));
    synth.speak(u);
  });
}

// ── The call ────────────────────────────────────────────────────────────────
const call = {
  on: false, state: 'idle', engine: null, mic: null, rec: null, muted: false,
  awaiting: false, block: '', spoken: 0, startedAt: 0, timer: null, wake: null,

  setState(state, text) {
    call.state = state;
    orb.dataset.state = state;
    screen.dataset.state = state;
    statusEl.textContent = text || {
      listening: 'Listening…',
      transcribing: 'Transcribing what you said…',
      thinking: 'Claude is thinking…',
      working: 'Claude is working on it…',
      speaking: 'Claude is speaking — tap to interrupt',
      muted: 'Microphone off',
      idle: 'Tap the circle to speak',
    }[state] || '';
  },

  line(who, text) {
    const row = document.createElement('div');
    row.className = `call-line call-${who}`;
    row.textContent = text;
    logEl.appendChild(row);
    while (logEl.children.length > 8) logEl.firstChild.remove();
    logEl.scrollTop = logEl.scrollHeight;
    return row;
  },

  listen() {
    if (!call.on || call.muted) return;
    if (S.isRunning && !call.awaiting) { call.setState('working'); return; }
    if (call.engine === 'whisper') {
      call.setState('listening');
      call.mic.listen(async (chunks) => {
        if (!call.on) return;
        call.setState('transcribing');
        let text = '';
        try { text = await transcribe(chunks, call.mic.rate); }
        catch (e) { call.setState('idle', e.message); return; }
        if (!call.on) return;
        if (text) call.send(text); else call.listen();
      });
      return;
    }
    const rec = new Recognition();
    rec.lang = voiceLang();
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '', heard = '';
    const live = call.line('you', '…');
    rec.onresult = (e) => {
      finalText = ''; let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      heard = (finalText + interim).trim();
      live.textContent = heard || '…';
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      showToast(explain(e.error), { kind: 'warn' });
      hangUp();
    };
    rec.onend = () => {
      call.rec = null;
      live.remove();
      if (!call.on || call.muted) return;
      const said = (finalText || heard).trim();
      if (said) call.send(said);
      else if (call.state === 'listening') call.listen();
    };
    try { rec.start(); } catch { call.setState('idle'); return; }
    call.rec = rec;
    call.setState('listening');
  },

  send(text) {
    call.line('you', text);
    if (!S.isConnected) { call.setState('idle', 'Not connected — waiting…'); return; }
    call.awaiting = true;
    call.block = '';
    call.spoken = 0;
    call.setState('thinking');
    setInput(text);
    inputForm.requestSubmit();
  },

  /** Text of the reply as it is written: say each sentence once it is complete. */
  delta(t) {
    if (!call.awaiting) return;
    call.block += t;
    const end = sentenceEnd(call.block, call.spoken);
    if (end > call.spoken) {
      const piece = call.block.slice(call.spoken, end);
      call.spoken = end;
      call.say(piece);
    }
  },

  /** A finished block of the reply: say whatever of it was not said yet. */
  text(full) {
    if (!call.awaiting) return;
    const rest = full.startsWith(call.block.slice(0, call.spoken)) ? full.slice(call.spoken) : full;
    call.block = '';
    call.spoken = 0;
    call.say(rest);
  },

  say(piece) {
    const t = speakable(piece);
    if (!t) return;
    const last = logEl.lastElementChild;
    if (last?.classList.contains('call-claude') && last.dataset.turn === String(call.startedTurn)) last.textContent += ` ${t}`;
    else { const row = call.line('claude', t); row.dataset.turn = String(call.startedTurn); }
    // Talking over it (Whisper listening, mic open) interrupts it.
    if (call.engine === 'whisper' && !call.muted) call.mic.watchBargeIn(() => { speech.stop(); call.listen(); });
    speech.say(t);
  },

  /** The turn ended (result, error, stop). */
  turnEnd() {
    if (!call.awaiting) { if (call.on && call.state === 'working') call.listen(); return; }
    call.awaiting = false;
    call.startedTurn = (call.startedTurn || 0) + 1;
    if (call.block.length > call.spoken) call.say(call.block.slice(call.spoken));
    call.block = '';
    call.spoken = 0;
    if (!speech.busy) call.listen();
  },

  /** Everything queued has been said. */
  onSpoken() {
    if (!call.on) return;
    if (call.awaiting) call.setState('thinking');
    else call.listen();
  },
};

/** Fields the composer adds to a prompt sent during a call. */
export function voiceFields() {
  if (!call.on) return {};
  return pref('callFast', 'on') === 'on' ? { voice: true, model: 'claude-haiku-5-5', effort: 'low' } : { voice: true };
}
export function voiceOnDelta(text) { if (call.on) call.delta(text); }
export function voiceOnText(text) { if (call.on) call.text(text); }
export function voiceOnTurnEnd() { if (call.on) call.turnEnd(); }

async function startCall() {
  if (call.on) return;
  const engine = listenEngine();
  if (!engine) { showToast(whyNoMic(), { kind: 'warn' }); return; }
  if (dictation) stopDictation();
  audioCtx();   // created inside the tap, so it is allowed to play
  if (synth) { try { synth.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ } }
  call.engine = engine;
  if (engine === 'whisper') {
    try { call.mic = await openMic(); }
    catch (e) { showToast(explain(e), { kind: 'warn' }); return; }
  }
  Object.assign(call, { on: true, muted: false, awaiting: false, block: '', spoken: 0, startedTurn: 0, startedAt: Date.now() });
  logEl.innerHTML = '';
  engineEl.textContent = `${engine === 'whisper' ? 'Whisper (local)' : 'Browser'} · ${speakEngine() === 'ha' ? 'HA voice' : 'Browser voice'}${pref('callFast', 'on') === 'on' ? ' · Haiku' : ''}`;
  muteBtn.classList.remove('active');
  screen.classList.remove('hidden');
  callBtn.classList.add('active');
  timerEl.textContent = '00:00';
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  try { call.wake = await navigator.wakeLock?.request('screen'); } catch { call.wake = null; }
  call.listen();
}

export function hangUp() {
  if (!call.on) return;
  call.on = false;
  speech.stop();
  if (call.rec) { try { call.rec.abort(); } catch { /* ended */ } call.rec = null; }
  if (call.mic) { call.mic.close(); call.mic = null; }
  clearInterval(call.timer);
  try { call.wake?.release(); } catch { /* gone */ }
  call.wake = null;
  call.awaiting = false;
  screen.classList.add('hidden');
  callBtn.classList.remove('active');
  call.setState('idle');
}

orb.onclick = () => {
  if (!call.on) return;
  if (call.state === 'speaking') { speech.stop(); call.listen(); }
  else if (call.state === 'listening') { if (call.rec) call.rec.stop(); else call.mic?.endNow(); }
  else if (call.state === 'idle') call.listen();
};
muteBtn.onclick = () => {
  call.muted = !call.muted;
  muteBtn.classList.toggle('active', call.muted);
  muteBtn.title = call.muted ? 'Turn the microphone back on' : 'Mute the microphone';
  if (call.muted) {
    if (call.rec) { try { call.rec.abort(); } catch { /* ended */ } call.rec = null; }
    call.mic?.idle();
    if (!speech.busy && !call.awaiting) call.setState('muted');
  } else if (!speech.busy && !call.awaiting) call.listen();
};
hangupBtn.onclick = () => hangUp();
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && call.on) { e.stopPropagation(); hangUp(); }
}, true);

// ── Buttons and settings ────────────────────────────────────────────────────
micBtn.onclick = (e) => { e.preventDefault(); if (dictation) stopDictation(); else startDictation(); };
callBtn.onclick = (e) => { e.preventDefault(); if (call.on) hangUp(); else startCall(); };
// Shown wherever a microphone could be used at all; a click explains what is missing otherwise.
const anyMic = !!Recognition || canRecord;
micBtn.classList.toggle('unavailable', !anyMic);
callBtn.classList.toggle('unavailable', !anyMic);

function bindSelect(id, key, def) {
  const sel = $(id);
  if (!sel) return;
  const cur = pref(key, def);
  if (![...sel.options].some((o) => o.value === cur)) sel.add(new Option(cur, cur));
  sel.value = cur;
  sel.onchange = () => localStorage.setItem(key, sel.value);
}
bindSelect('voice-lang', 'voiceLang', voiceLang());
bindSelect('voice-stt', 'voiceStt', 'auto');
bindSelect('voice-tts', 'voiceTts', 'auto');
const fast = $('call-fast');
if (fast) {
  fast.checked = pref('callFast', 'on') === 'on';
  fast.onchange = () => localStorage.setItem('callFast', fast.checked ? 'on' : 'off');
}
// Voices load asynchronously in Chrome; asking once warms the list.
if (synth) synth.getVoices();
