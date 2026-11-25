/*
 * Mode Confidentiel — les mots qu'aucun dictionnaire de la langue du message ne
 * connaît (1.5.9). Un client écrit en minuscules (« fortis ») n'a pas de majuscule
 * qui le trahisse : il n'est simplement pas un mot du français. Tout se passe ici,
 * sur Home Assistant ; le texte n'est jamais envoyé pour être analysé.
 *
 * Listes : /usr/share/dict (paquets wfrench, wamerican, wbritish, wdutch — dans
 * l'image de l'app). Depuis 1.8.1, tout message est lu avec les trois langues
 * (français, anglais, néerlandais), quelle que soit sa langue : l'utilisateur les
 * pratique toutes et un mot anglais ou néerlandais n'est pas un terme inconnu.
 * Revers assumé : un nom en minuscules qui est aussi un mot néerlandais (« fortis »)
 * n'est plus signalé par cette voie. Sans listes : rien n'est signalé par cette
 * voie (les autres contrôles restent).
 */
import { existsSync, readFileSync } from 'fs';

const DICT_DIR = process.env.DICT_DIR || '/usr/share/dict';
const FILES = { fr: ['french'], en: ['american-english', 'british-english'], nl: ['dutch', 'nederlands'] };
const strip = (w) => w.normalize('NFD').replace(/\p{M}/gu, '');
let sets = null;
let loading = null;

/**
 * Load the lists without freezing the app: ~1 million words take seconds on a
 * Home Assistant Green, so they are read in chunks between other work. Started in
 * the background at boot (index.js); the pre-send check awaits it if needed.
 */
export function ready() {
  if (sets) return Promise.resolve(sets);
  if (loading) return loading;
  loading = (async () => {
    const out = {};
    const tick = () => new Promise((r) => setImmediate(r));
    for (const [lang, files] of Object.entries(FILES)) {
      const s = new Set();
      for (const f of files) {
        const p = `${DICT_DIR}/${f}`;
        if (!existsSync(p)) continue;
        const lines = readFileSync(p, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const w = lines[i].trim().toLowerCase();
          if (w && !w.includes("'s")) {
            s.add(w);
            if (/[^\x00-\x7f]/.test(w)) s.add(strip(w));      // « reunion » typed without its accent
          }
          if (i % 20000 === 19999) await tick();
        }
      }
      if (s.size) out[lang] = s;
    }
    sets = out;
    return sets;
  })();
  return loading;
}
const loadSets = () => sets || {};
export const lexiconAvailable = () => Object.keys(loadSets()).length > 0;   // false until ready() resolved

/** The languages every message is checked against (1.8.1: always all three). */
export const LANGS = Object.freeze(['fr', 'en', 'nl']);

/** Is `w` a word of one of these languages (any form, with or without its accents)? */
export function isWord(w, langs = LANGS) {
  const s = loadSets();
  const lw = String(w).toLowerCase().replace(/’/g, "'");
  const forms = [lw, strip(lw)];
  // « l'entreprise », « qu'il » : the word after the elision
  const el = lw.match(/^(?:[ldjmnstc]|qu|jusqu|lorsqu|puisqu)'(.+)$/);
  if (el) forms.push(el[1], strip(el[1]));
  for (const l of langs) {
    const d = s[l];
    if (!d) continue;
    if (forms.some((f) => d.has(f))) return true;
    // hyphenated: each part a word (« chef-lieu », « e-mail » are in the lists already)
    if (lw.includes('-') && lw.split('-').every((p) => p.length < 3 || d.has(p) || d.has(strip(p)))) return true;
  }
  return false;
}

/**
 * The lowercase words of `text` that no dictionary (French, English, Dutch) knows.
 * Capitalised words, acronyms, numbers, e-mails, URLs and code are handled elsewhere.
 * `skip(word)` → true for words the vault already knows, ignores or exempts.
 * → [{ real, index }]
 */
export function unknownWords(text, skip = () => false) {
  if (!lexiconAvailable()) return [];
  const t = String(text)
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => ' '.repeat(m.length))                       // code
    .replace(/\b(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi, (m) => ' '.repeat(m.length));   // links, e-mails
  const out = [];
  const seen = new Set();
  for (const m of t.matchAll(/(?<![\p{L}\p{N}_/@.-])\p{Ll}[\p{L}'’-]*\p{L}(?![\p{L}\p{N}_@])/gu)) {
    const w = m[0].replace(/[-'’]+$/, '');
    if (w.length < 3 || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    if (skip(w) || isWord(w)) continue;
    out.push({ real: w, index: m.index });
  }
  return out;
}
