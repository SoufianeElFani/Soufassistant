/*
 * Voice: dictating into the message box, and a spoken conversation with Claude.
 *
 * Both use the browser's own speech services — the Web Speech API's
 * SpeechRecognition to listen and speechSynthesis to speak — so nothing is
 * installed and nothing runs on the Home Assistant box. Recognition is not in
 * every browser (Chrome, Edge and Safari have it; Firefox and some in-app
 * webviews do not) and needs the microphone allowed: where it is missing the
 * mic buttons are not shown, and the phone keyboard's own dictation still works.
 *
 *   🎤 (mic)        dictation: what you say is typed into the box as you speak,
 *                   for you to read over and send. Click again to stop.
 *   🎧 (talk)       a spoken conversation: Claude listens, sends what you said
 *                   when you pause, reads its reply aloud, then listens again.
 *                   The prompt carries `voice: true`, so the server asks for a
 *                   short, plain-spoken answer (no tables or code to read out).
 *                   Tap the orb to interrupt it; ✕ ends the conversation.
 */
import { S } from './state.js';
import { inputForm, promptInput } from './dom.js';
import { showToast } from './toast.js';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const synth = window.speechSynthesis || null;

export const voiceSupported = !!Recognition;

const micBtn = document.getElementById('mic-btn');
const talkBtn = document.getElementById('talk-btn');
const bar = document.getElementById('voice-bar');
const orb = document.getElementById('voice-orb');
const statusEl = document.getElementById('voice-status');
const heardEl = document.getElementById('voice-heard');
const endBtn = document.getElementById('voice-end');
const langSel = document.getElementById('voice-lang');

export function voiceLang() {
  return localStorage.getItem('voiceLang') || (navigator.language?.startsWith('fr') ? 'fr-FR' : navigator.language) || 'fr-FR';
}

function explain(error) {
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'The microphone is blocked. Allow it for this page — or open the app in its own tab (↗) if it runs inside Home Assistant.';
  }
  if (error === 'audio-capture') return 'No microphone was found.';
  if (error === 'network') return 'Speech recognition needs a network connection.';
  return `Speech recognition stopped (${error}).`;
}

function setInput(text) {
  promptInput.value = text;
  // The box's own listener resizes it, saves the draft and updates Send.
  promptInput.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Dictation ───────────────────────────────────────────────────────────────
let dictation = null;

function startDictation() {
  if (talk.on) return;
  const rec = new Recognition();
  rec.lang = voiceLang();
  rec.continuous = true;
  rec.interimResults = true;
  const base = promptInput.value.replace(/\s+$/, '');
  const sep = base ? ' ' : '';
  rec.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    setInput(base + sep + text.trim());
  };
  rec.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') showToast(explain(e.error), { kind: 'warn' }); };
  rec.onend = () => { dictation = null; micBtn.classList.remove('listening'); promptInput.focus(); };
  try { rec.start(); } catch { return; }
  dictation = rec;
  micBtn.classList.add('listening');
  micBtn.title = 'Stop dictation';
}

function stopDictation() {
  if (dictation) dictation.stop();
  micBtn.title = 'Dictate';
}

// ── Spoken conversation ─────────────────────────────────────────────────────
const talk = { on: false, state: 'idle', rec: null, queue: [], speaking: false, turnOpen: false, misses: 0 };

/** Fields the composer adds to a prompt sent during a spoken conversation. */
export function voiceFields() {
  return talk.on ? { voice: true } : {};
}

function setState(state, text) {
  talk.state = state;
  bar.dataset.state = state;
  statusEl.textContent = text || {
    listening: 'Listening… speak, then pause',
    thinking: 'Claude is thinking…',
    speaking: 'Speaking — tap the circle to interrupt',
    idle: 'Tap the circle to speak',
  }[state] || '';
}

function listen() {
  if (!talk.on || talk.rec) return;
  if (S.isRunning) { setState('thinking'); return; }
  const rec = new Recognition();
  rec.lang = voiceLang();
  rec.continuous = false;
  rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    finalText = '';
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    heardEl.textContent = (finalText + interim).trim();
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    showToast(explain(e.error), { kind: 'warn' });
    stopTalk();
  };
  rec.onend = () => {
    talk.rec = null;
    if (!talk.on) return;
    const said = finalText.trim() || heardEl.textContent.trim();
    if (said) {
      talk.misses = 0;
      send(said);
    } else if (++talk.misses < 3) {
      listen();
    } else {
      setState('idle');   // stop listening into a silent room; a tap starts again
    }
  };
  try { rec.start(); } catch { setState('idle'); return; }
  talk.rec = rec;
  heardEl.textContent = '';
  setState('listening');
}

function send(text) {
  if (!S.isConnected) { setState('idle', 'Not connected — waiting…'); return; }
  setInput(text);
  talk.turnOpen = true;
  setState('thinking');
  inputForm.requestSubmit();
}

/** Plain, speakable text from a reply's markdown. Exported for the tests. */
export function speakable(md) {
  return String(md || '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
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

function pickVoice(lang) {
  const voices = synth?.getVoices() || [];
  const base = lang.split('-')[0];
  return voices.find((v) => v.lang === lang && v.localService) || voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang?.startsWith(base)) || null;
}

function speakNext() {
  if (!talk.on || talk.speaking) return;
  const text = talk.queue.shift();
  if (!text) {
    // Everything said; once the turn is over too, it is the user's turn again.
    if (!talk.turnOpen) listen();
    return;
  }
  if (!synth) { speakNext(); return; }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = voiceLang();
  const v = pickVoice(u.lang);
  if (v) u.voice = v;
  u.onend = u.onerror = () => { talk.speaking = false; speakNext(); };
  talk.speaking = true;
  setState('speaking');
  synth.speak(u);
}

/** A finished block of the reply on screen (connection.js). */
export function voiceOnText(text) {
  if (!talk.on || !talk.turnOpen) return;
  const t = speakable(text);
  if (!t) return;
  talk.queue.push(t);
  speakNext();
}

/** The turn ended (result, error or stop). */
export function voiceOnTurnEnd() {
  if (!talk.on) return;
  talk.turnOpen = false;
  if (!talk.speaking && !talk.queue.length) listen();
}

function interrupt() {
  talk.queue = [];
  if (synth) synth.cancel();
  talk.speaking = false;
}

function startTalk() {
  if (dictation) stopDictation();
  talk.on = true;
  talk.misses = 0;
  talk.turnOpen = false;
  bar.classList.remove('hidden');
  talkBtn.classList.add('active');
  // iOS only lets speech start from a tap: an empty utterance unlocks it now.
  if (synth) { try { synth.speak(new SpeechSynthesisUtterance('')); } catch { /* ignore */ } }
  listen();
}

export function stopTalk() {
  talk.on = false;
  interrupt();
  if (talk.rec) { try { talk.rec.abort(); } catch { /* ignore */ } talk.rec = null; }
  talk.turnOpen = false;
  bar.classList.add('hidden');
  talkBtn.classList.remove('active');
  heardEl.textContent = '';
}

orb.onclick = () => {
  if (talk.state === 'speaking') { interrupt(); listen(); }
  else if (talk.state === 'listening') { talk.rec?.stop(); }
  else if (talk.state === 'idle') { talk.misses = 0; listen(); }
};
endBtn.onclick = () => stopTalk();

// ── Buttons and the language setting ────────────────────────────────────────
if (voiceSupported) {
  micBtn.classList.remove('hidden');
  talkBtn.classList.remove('hidden');
  micBtn.onclick = (e) => { e.preventDefault(); if (dictation) stopDictation(); else startDictation(); };
  talkBtn.onclick = (e) => { e.preventDefault(); if (talk.on) stopTalk(); else startTalk(); };
}
if (langSel) {
  const cur = voiceLang();
  if (![...langSel.options].some((o) => o.value === cur)) langSel.add(new Option(cur, cur));
  langSel.value = cur;
  langSel.onchange = () => localStorage.setItem('voiceLang', langSel.value);
}
// Voices load asynchronously in Chrome; asking once warms the list.
if (synth) synth.getVoices();
