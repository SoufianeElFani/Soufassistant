/*
 * Le mode Confidentiel — pseudonymiser avant d'envoyer, re-identifier en local.
 *
 * Un coffre (VAULT_DIR, jamais synchronisé, interdit aux outils de l'agent par
 * vaultGuard) garde la table « vrai nom ↔ pseudonyme » (Acme Brewing ↔ Client-A),
 * les originaux des fichiers anonymisés et les versions réelles des livrables.
 *
 *   mask(text)    vrais noms → pseudonymes (dictionnaire + motifs : e-mails,
 *                 téléphones, IBAN, TVA, références d'offre ; sociétés avec forme
 *                 juridique et personnes avec civilité sont ajoutées au vol)
 *   reveal(text)  pseudonymes → vrais noms (affichage, livrables réels)
 *   maskFile / revealFile   même chose dans un fichier : texte, docx/pptx (par
 *                 paragraphe, mise en forme gardée), xlsx (chaînes), pdf (→ texte)
 *   anonymizeWorkspace      originaux → coffre, copies anonymes à leur place
 *
 * Chiffrement (1.4.0) : avec une phrase de passe, le coffre est `coffre.enc`
 * (AES-256-GCM). Une clé de données aléatoire chiffre la table et chaque fichier
 * (originaux, versions réelles : `blobs/<id>.enc`, noms opaques) ; elle est
 * elle-même chiffrée par une clé dérivée de la phrase (scrypt). La phrase n'est
 * jamais écrite : après un redémarrage le coffre est verrouillé, et mask() refuse
 * de travailler (le message n'est pas envoyé) tant qu'on ne l'a pas déverrouillé.
 * Sans phrase de passe (anciens coffres), `coffre.json` en clair, comme avant.
 * La garde empêche l'agent d'atteindre le coffre (chemin cité, API, recherche
 * récursive dans un dossier parent) ; elle protège contre l'accident.
 */
import { execFile } from 'child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { readZip, makeZip } from './zip.js';
import { leafElements, partParagraphs, setPartParagraphs } from './office-edit.js';
import { log } from './log.js';

export const VAULT_DIR = process.env.VAULT_DIR || path.join(DATA_DIR, '.coffre-souf');
const VAULT_FILE = () => path.join(VAULT_DIR, 'coffre.json');
export const VAULT_MARK = path.basename(VAULT_DIR);           // le nom que la garde cherche
export const KINDS = { client: 'Client', personne: 'Personne', lieu: 'Lieu', projet: 'Projet', partenaire: 'Partenaire', ref: 'REF', email: 'email', tel: 'tel', iban: 'iban', tva: 'tva', autre: 'Donnee' };

const ENC_FILE = () => path.join(VAULT_DIR, 'coffre.enc');
const BLOB_DIR = () => path.join(VAULT_DIR, 'blobs');
// Mots souvent en majuscule qui ne sont pas des noms à protéger (alerte avant envoi)
const DEFAULT_IGNORED = ['Claude', 'Anthropic', 'Home Assistant', 'Google', 'Google Drive', 'Drive', 'Word', 'Excel', 'PowerPoint', 'PDF', 'HTML', 'CSV', 'API', 'HA', 'OK', 'FR', 'EN', 'NL', 'BE', 'EUR', 'HTVA', 'TVA', 'PoC', 'KPI', 'ROI', 'IA', 'AI', 'Soufassistant', 'Hub', 'Chat', 'Code', 'Cowork', 'Markdown', 'Python', 'GitHub', 'SaaS', 'BMS', 'EMS', 'SCADA', 'PLC', 'GTC', 'MQTT', 'SLA'];

let state = null;
let dek = null;          // clé de données, en mémoire seulement (coffre déverrouillé)

export class VaultLocked extends Error {
  constructor() { super('Coffre verrouillé : déverrouille-le (Hub › Confidentiel) avant d\'envoyer en mode Confidentiel.'); this.code = 'VAULT_LOCKED'; }
}
export const isEncrypted = () => existsSync(ENC_FILE());
export const isLocked = () => isEncrypted() && !dek;
export function vaultStatus() { return { encrypted: isEncrypted(), locked: isLocked() }; }

// ── Chiffrement ─────────────────────────────────────────────────────────────
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const kek = (pass, salt) => scryptSync(String(pass).normalize('NFC'), salt, 32, SCRYPT);
function seal(key, buf) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]);       // iv(12) | tag(16) | données
}
function unseal(key, box) {
  const d = createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
  d.setAuthTag(box.subarray(12, 28));
  return Buffer.concat([d.update(box.subarray(28)), d.final()]);
}
const readEnc = () => JSON.parse(readFileSync(ENC_FILE(), 'utf8'));

function load() {
  if (state) return state;
  if (isEncrypted()) {
    if (!dek) throw new VaultLocked();
    const enc = readEnc();
    state = enc.state ? JSON.parse(unseal(dek, Buffer.from(enc.state, 'base64')).toString('utf8')) : {};
  } else {
    try { state = JSON.parse(readFileSync(VAULT_FILE(), 'utf8')); } catch { state = {}; }
  }
  state.entities ||= [];
  state.exempt ||= ['Equans', 'Equans Digital', 'Equans NV', 'Equans SA', 'Equans NV/SA', 'Soufiane EL FANI', 'Soufiane'];
  state.files ||= [];
  state.counters ||= {};
  state.blobs ||= [];      // { id, type: 'orig' | 'reel', name, at, size }
  state.roots ||= [];      // dossiers du workspace anonymisés (mode strict)
  state.ignored ||= [...DEFAULT_IGNORED];
  return state;
}
function save() {
  mkdirSync(VAULT_DIR, { recursive: true });
  if (dek) {
    const enc = readEnc();
    enc.state = seal(dek, Buffer.from(JSON.stringify(state))).toString('base64');
    writeFileAtomic(ENC_FILE(), JSON.stringify(enc));
  } else {
    writeFileAtomic(VAULT_FILE(), JSON.stringify(state, null, 1));
  }
  compiled = null;
}
export function reset() { state = null; compiled = null; dek = null; }

/** Déverrouiller avec la phrase de passe. → true, ou false si elle est fausse. */
export function unlock(pass) {
  if (!isEncrypted()) return true;
  const enc = readEnc();
  let key;
  try { key = unseal(kek(pass || '', Buffer.from(enc.salt, 'base64')), Buffer.from(enc.wrapped, 'base64')); } catch { return false; }
  dek = key; state = null; compiled = null;
  load();
  log('INFO', 'vault: déverrouillé');
  return true;
}
export function lock() { if (!isEncrypted()) return; dek = null; state = null; compiled = null; log('INFO', 'vault: verrouillé'); }

function wrapKey(pass, key) {
  const salt = randomBytes(16);
  return { v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64'), wrapped: seal(kek(pass, salt), key).toString('base64') };
}

/** Garder un fichier réel : chiffré sous un nom opaque, ou en clair sans phrase de passe. */
function putReal(type, name, buf) {
  const s = load();
  if (!dek) {
    const dst = type === 'orig' ? path.join(VAULT_DIR, 'originaux', name) : path.join(VAULT_DIR, 'reels', new Date().toISOString().slice(0, 10), name);
    mkdirSync(path.dirname(dst), { recursive: true });
    writeFileSync(dst, buf);
    return null;
  }
  const id = randomBytes(9).toString('hex');
  mkdirSync(BLOB_DIR(), { recursive: true });
  writeFileSync(path.join(BLOB_DIR(), id + '.enc'), seal(dek, buf));
  const e = { id, type, name, at: Date.now(), size: buf.length };
  s.blobs.push(e);
  return e;
}

/**
 * Activer le chiffrement (1re fois : la table, `originaux/` et `reels/` sont
 * chiffrés puis les versions en clair supprimées) ou changer la phrase de passe.
 */
export function setPassphrase(pass, oldPass) {
  if (String(pass || '').length < 8) return { ok: false, error: 'Phrase de passe trop courte (8 caractères minimum).' };
  if (isEncrypted()) {
    if (!unlock(oldPass)) return { ok: false, error: 'Ancienne phrase de passe incorrecte.' };
    writeFileAtomic(ENC_FILE(), JSON.stringify({ ...wrapKey(pass, dek), state: readEnc().state }));
    log('INFO', 'vault: phrase de passe changée');
    return { ok: true };
  }
  const s = load();
  dek = randomBytes(32);
  mkdirSync(VAULT_DIR, { recursive: true });
  writeFileAtomic(ENC_FILE(), JSON.stringify({ ...wrapKey(pass, dek), state: '' }));
  // les fichiers en clair du coffre → fichiers chiffrés aux noms opaques
  let n = 0;
  for (const [sub, type] of [['originaux', 'orig'], ['reels', 'reel']]) {
    const dir = path.join(VAULT_DIR, sub);
    const walk = (d) => { for (const x of (existsSync(d) ? readdirSync(d) : [])) { const p = path.join(d, x); if (statSync(p).isDirectory()) walk(p); else { putReal(type, type === 'reel' ? x : path.relative(dir, p), readFileSync(p)); n++; } } };
    walk(dir);
  }
  save();
  for (const sub of ['originaux', 'reels', 'tmp-apprentissage']) rmSync(path.join(VAULT_DIR, sub), { recursive: true, force: true });
  rmSync(VAULT_FILE(), { force: true });
  log('INFO', `vault: chiffré (${s.entities.length} entrées, ${n} fichiers)`);
  return { ok: true, files: n };
}

/** La liste « ne plus signaler » de l'alerte avant envoi. */
export const ignoredList = () => load().ignored;
export function setIgnored(list) { load().ignored = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))]; save(); }
export function addIgnored(words) { const s = load(); for (const w of words) if (w && !s.ignored.some((x) => norm(x) === norm(w))) s.ignored.push(String(w).trim()); save(); }

/** Les dossiers anonymisés, en chemins absolus (le mode strict n'autorise qu'eux). */
export function protectedRoots(root) {
  const s = load();
  const rels = new Set(s.roots);
  for (const f of s.files) if (f.masked) rels.add(f.masked.split('/')[0]);
  return [...rels].filter(Boolean).map((r) => path.join(root, r));
}

// ── Pseudonymes ─────────────────────────────────────────────────────────────
const letters = (n) => { let s = ''; n += 1; while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); } return s; };
function nextAlias(kind) {
  const s = load();
  const n = s.counters[kind] = (s.counters[kind] || 0) + 1;
  switch (kind) {
    case 'client': return `Client-${letters(n - 1)}`;
    case 'partenaire': return `Partenaire-${letters(n - 1)}`;
    case 'email': return `contact${String(n).padStart(2, '0')}@exemple.invalid`;
    case 'tel': return `+32 400 00 ${String(Math.floor(n / 100)).padStart(2, '0')} ${String(n % 100).padStart(2, '0')}`;
    case 'iban': return `BE00 0000 0000 ${String(n).padStart(4, '0')}`;
    case 'tva': return `BE 0000.000.${String(n).padStart(3, '0')}`;
    case 'ref': return `REF-${String(n).padStart(4, '0')}`;
    default: return `${KINDS[kind] || 'Donnee'}-${String(n).padStart(2, '0')}`;
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const B = '(?<![\\p{L}\\p{N}@.])', E = '(?![\\p{L}\\p{N}])';

export function listEntities() { return isLocked() ? [] : load().entities; }
export function exemptList() { return isLocked() ? [] : load().exempt; }

/** Ajouter (ou compléter) une entité. → l'entité. */
export function addEntity({ real, kind = 'autre', variants = [], alias, auto = false }) {
  const s = load();
  real = String(real || '').trim();
  if (real.length < 2 || isAliasLike(real)) return null;
  variants = variants.filter((v) => !isAliasLike(v));
  if (s.exempt.some((x) => norm(x) === norm(real))) return null;
  const all = [real, ...variants].map((v) => String(v).trim()).filter((v) => v.length >= 2);
  let e = s.entities.find((x) => [x.real, ...(x.variants || [])].some((v) => all.some((a) => norm(a) === norm(v))));
  if (e) {
    for (const v of all) if (![e.real, ...e.variants].some((x) => norm(x) === norm(v))) e.variants.push(v);
  } else {
    e = { real, kind: KINDS[kind] ? kind : 'autre', alias: alias || nextAlias(kind), variants: all.slice(1), auto, added: Date.now() };
    s.entities.push(e);
  }
  save();
  return e;
}
export function removeEntity(alias) {
  const s = load();
  const i = s.entities.findIndex((e) => e.alias === alias);
  if (i < 0) return false;
  s.entities.splice(i, 1);
  save();
  return true;
}
export function setExempt(list) { load().exempt = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))]; save(); }

let compiled = null;
function compile() {
  if (compiled) return compiled;
  const s = load();
  const byVariant = new Map();
  for (const e of s.entities) for (const v of [e.real, ...(e.variants || [])]) byVariant.set(norm(v), e);
  const vs = [...byVariant.keys()].sort((a, b) => b.length - a.length);
  const pat = vs.map((v) => v.split(' ').map(esc).join('[\\s_-]+')).join('|');
  const aliases = s.entities.map((e) => e.alias).sort((a, b) => b.length - a.length);
  compiled = {
    byVariant,
    mask: vs.length ? new RegExp(`${B}(?:${pat})${E}`, 'giu') : null,
    byAlias: new Map(s.entities.map((e) => [e.alias, e])),
    reveal: aliases.length ? new RegExp(`${B}(?:${aliases.map(esc).join('|')})${E}`, 'gu') : null,
  };
  return compiled;
}

// Motifs reconnus sans dictionnaire (ajoutés au coffre la 1re fois)
const PATTERNS = [
  ['email', /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g],
  ['iban', /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g],
  ['tva', /\bBE\s?0?\d{3}[.\s]?\d{3}[.\s]?\d{3}\b/g],
  ['tel', /(?<![\w.])(?:\+32|0032|0)\s?4\d{2}(?:[\s./-]?\d{2}){3}(?![\d])|(?<![\w.])\+\d{2,3}(?:[\s./-]?\d{1,4}){3,5}(?![\d])/g],
  ['ref', /\b20\d{2}_\d{2}-\d{4}\b|\b20\d{2}\/\d{3,5}\/[A-Z/]{3,}\b/g],
];
const LEGAL = /\b((?:[A-Z][\p{L}&'.-]+|[A-Z]{2,})(?:\s+(?:[A-Z][\p{L}&'.-]+|[A-Z]{2,}|de|des|du|van|der|&)){0,4})\s+(NV|SA|BV|SRL|SPRL|BVBA|GmbH|Ltd|LLC|Inc|AG|SAS|SARL|N\.V\.|S\.A\.)\b/gu;
const TITLED = /\b(?:M\.|Mme|Mlle|Mr\.?|Mrs\.?|Ms\.?|Dhr\.?|Mevr\.?|Madame|Monsieur|Attn\.\s*(?:Mr|Mrs|Ms)\.?)\s+((?:[A-Z][\p{L}'-]+|[A-Z]{2,})(?:\s+(?:[A-Z][\p{L}'-]+|[A-Z]{2,}|van|de|der|du)){0,3})/gu;

/** Repérer de nouvelles entités dans un texte (sans rien remplacer). → [{real, kind}] */
// Our own pseudonyms must never be learnt as real names (a phone alias looks like a phone…)
const ALIAS_LIKE = /exemple\.invalid|\+32\s+400\s+00\s+\d{2}\s+\d{2}|BE\s+0000\.000\.\d{3}|BE00\s+0000\s+0000\s+\d{4}|\bREF-\d{4}\b|\b(?:Client|Partenaire)-(?:[A-Z]{1,3}\b|$|\s)|\b(?:Personne|Lieu|Projet|Donnee)-(?:\d+|$|\s)|^(?:Client|Partenaire|Personne|Lieu|Projet|Donnee|REF)-?$/;
export const isAliasLike = (v) => ALIAS_LIKE.test(String(v));

export function detect(text) {
  const s = load();
  const out = [];
  const isExempt = (v) => isAliasLike(v) || s.exempt.some((x) => norm(v).includes(norm(x)) || norm(x) === norm(v));
  for (const [kind, re] of PATTERNS) for (const m of String(text).matchAll(re)) if (!isExempt(m[0])) out.push({ real: m[0].trim(), kind });
  // une société avec sa forme juridique : on retient le nom seul (la forme reste dans le texte)
  for (const m of String(text).matchAll(LEGAL)) if (!isExempt(m[1])) out.push({ real: m[1].trim(), kind: 'client' });
  for (const m of String(text).matchAll(TITLED)) if (!isExempt(m[1])) out.push({ real: m[1].trim(), kind: 'personne' });
  const seen = new Set();
  return out.filter((x) => { const k = norm(x.real); if (seen.has(k)) return false; seen.add(k); return !compile().byVariant.has(k); });
}

/** Texte → texte pseudonymisé. `learn` : ajouter au coffre ce que detect() trouve. */
export function mask(text, { learn = true } = {}) {
  if (!text) return text;
  if (learn) for (const d of detect(text)) addEntity({ ...d, auto: true });
  const c = compile();
  return c.mask ? String(text).replace(c.mask, (m) => c.byVariant.get(norm(m))?.alias ?? m) : String(text);
}

/**
 * Alerte avant envoi : ce qui ressemble à un nom (mots en majuscule, sigles) et
 * que le coffre ne connaît pas — ni entité, ni exemption, ni « ne plus signaler ».
 * Un mot seul en début de phrase n'est pas retenu (« Prépare… »).
 * → { auto: [{real, kind}] protégés d'office par detect(), unknown: [{real, kind}] }
 */
const CAP = /(?<![\p{L}\p{N}@./\\_-])((?:\p{Lu}[\p{L}\p{N}'’&-]*)(?:[ \t]+(?:(?:de|des|du|van|der|den|la|le|von|&)[ \t]+)?\p{Lu}[\p{L}\p{N}'’&-]*){0,4})(?![\p{L}\p{N}@])/gu;
const COMPANY = /\b(Industries|Industrie|Group|Groupe|Groep|Holding|Energy|Energie|Solutions|Services|Systems|Technologies|Tech|Corp|Corporation|Company|Bank|Banque|Partners|Consulting|International|Engineering|Logistics|Pharma|Hospital|Hôpital|Ziekenhuis|Université|Universiteit|University|Invest|Capital|Immo|Real Estate|Ville|Stad|Gemeente|Commune|Province|Provincie|Région|Regio)\b/u;
export function suspects(text) {
  const s = load();
  const t = String(text || '');
  const auto = detect(t);
  const c = compile();
  const known = (v) => c.byVariant.has(norm(v)) || isAliasLike(v) || s.exempt.some((x) => norm(x) === norm(v)) || s.ignored.some((x) => norm(x) === norm(v))
    || auto.some((a) => norm(a.real).includes(norm(v)));
  const masked = c.mask ? t.replace(c.mask, ' ') : t;     // ce qui est déjà protégé ne compte plus
  const out = new Map();
  for (const m of masked.matchAll(CAP)) {
    let v = m[1].replace(/[-'’&]+$/, '');
    const words = v.split(/\s+/);
    const before = masked.slice(0, m.index).replace(/[ \t«"“(\[*_>-]+$/, '');
    const startOfSentence = !before || /[.!?:;\n]$/.test(before);
    if (words.length === 1 && startOfSentence && !/^\p{Lu}{2,}/u.test(v)) continue;
    // un mot de début de phrase suivi d'un nom : garder seulement le nom
    if (startOfSentence && words.length > 1 && !/^\p{Lu}{2,}/u.test(words[0])) { words.shift(); v = words.join(' '); }
    if (v.length < 2 || /^\p{Lu}$/u.test(v) || /^\d/.test(v) || known(v) || words.every((w) => known(w))) continue;
    const kind = !COMPANY.test(v) && words.length >= 2 && words.every((w) => /^\p{Lu}[\p{Ll}'’-]+$|^\p{Lu}{2,}$/u.test(w)) && words.length <= 3 && !words.some((w) => /^\p{Lu}{2,}$/u.test(w) && w.length > 3) ? 'personne' : 'client';
    if (!out.has(norm(v))) out.set(norm(v), { real: v, kind });
  }
  return { auto, unknown: [...out.values()].slice(0, 40) };
}

export function reveal(text) {
  const c = compile();
  return c.reveal && text ? String(text).replace(c.reveal, (a) => c.byAlias.get(a)?.real ?? a) : text;
}

/** Pour l'affichage dans le navigateur (jamais envoyé au modèle). */
export function revealMap() { return isLocked() ? {} : Object.fromEntries(load().entities.map((e) => [e.alias, e.real])); }

// ── Fichiers ────────────────────────────────────────────────────────────────
/** Un JPEG sans ses métadonnées (EXIF / XMP en APP1, IPTC en APP13, commentaires) — l'image est intacte. */
export function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m === 0xda) { out.push(buf.subarray(i)); return Buffer.concat(out); }   // début des données : on garde tout
    const len = buf.readUInt16BE(i + 2);
    if (!(m === 0xe1 || m === 0xed || m === 0xfe)) out.push(buf.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return buf;   // structure inattendue : ne rien toucher
}

const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'ts', 'html', 'htm', 'svg', 'xml', 'css', 'sh', 'toml', 'ini', 'log', 'sql', 'tex']);
const OFFICE = { docx: 'docx', pptx: 'pptx', xlsx: 'xlsx' };
const ext = (p) => path.extname(p).slice(1).toLowerCase();

function run(cmd, args, timeout = 240000) {
  return new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(String(out)))));
}

function transformOffice(buf, kind, fn) {
  const entries = readZip(buf);
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const flavor = kind === 'pptx' ? 'pptx' : 'docx';
  for (const name of [...files.keys()]) {
    let x = files.get(name).toString('utf8');
    const isPart = kind === 'docx' ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(name)
      : kind === 'pptx' ? /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name) : false;
    if (isPart) {
      const edits = partParagraphs(x, flavor).filter((p) => p.text.trim()).map((p) => ({ i: p.i, old: p.text, text: fn(p.text) })).filter((e) => e.text !== e.old);
      if (edits.length) x = setPartParagraphs(x, flavor, edits);
      files.set(name, Buffer.from(x));
    } else if (/\.xml$/i.test(name) && !/(^|\/)_rels\/|^\[Content_Types\]\.xml$|\/theme\/|\/styles\.xml$|\/fontTable\.xml$|\/settings\.xml$/.test(name)) {
      // every other XML part (SmartArt, charts, masters, comments, docProps, sheets…): its text nodes
      // texte des éléments, sans toucher aux balises
      x = x.replace(/>([^<>]+)</g, (m, t) => `>${fn(t)}<`);
      files.set(name, Buffer.from(x));
    }
  }
  for (const name of [...files.keys()]) if (/\/media\/[^/]+\.jpe?g$/i.test(name)) files.set(name, stripJpeg(files.get(name)));
  // texte alternatif et titres d'objets (images, formes), dans toutes les parties
  const unx = (v) => v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const enx = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const name of [...files.keys()]) {
    if (!/\.xml$/i.test(name) || /_rels\//.test(name)) continue;
    const x = files.get(name).toString('utf8');
    const y = x.replace(/\b(descr|title)="([^"]*)"/g, (m, a, v) => `${a}="${enx(fn(unx(v)))}"`)
      .replace(/(<(?:p|pic|wp|xdr|dgm):(?:cNvPr|docPr)\b[^>]*?\bname=")([^"]*)"/g, (m, pre, v) => `${pre}${enx(fn(unx(v)))}"`);
    if (y !== x) files.set(name, Buffer.from(y));
  }
  return makeZip(entries.filter((e) => files.has(e.name)).map((e) => ({ name: e.name, data: files.get(e.name) })), { deflate: true });
}

/** Écrire `dst` = `src` passé par `fn` (mask ou reveal). → { ok, how, dst } */
export async function transformFile(src, dst, fn) {
  const k = ext(src);
  mkdirSync(path.dirname(dst), { recursive: true });
  if (TEXT_EXT.has(k)) { writeFileSync(dst, fn(readFileSync(src, 'utf8'))); return { ok: true, how: 'texte', dst }; }
  if (OFFICE[k]) { writeFileSync(dst, transformOffice(readFileSync(src), OFFICE[k], fn)); return { ok: true, how: k, dst }; }
  if (k === 'pdf') {
    const txt = await run('pdftotext', ['-layout', '-q', src, '-']).catch(() => '');
    const d2 = dst.replace(/\.pdf$/i, '.pdf.txt');
    writeFileSync(d2, fn(txt));
    return { ok: true, how: 'pdf→texte', dst: d2 };
  }
  return { ok: false, how: 'non pris en charge', dst };
}

export const maskFile = (src, dst) => transformFile(src, dst, (t) => mask(t));
export const revealFile = (src, dst) => transformFile(src, dst, reveal);

/** Version réelle d'un livrable (dans le coffre). → chemin dans le coffre */
export async function particularize(abs, rel) {
  load();
  // produit dans un dossier temporaire, puis gardé au coffre (chiffré s'il y a une phrase de passe)
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'reel-'));
  try {
    const dst = path.join(tmp, reveal(path.basename(rel)).replace(/\s+/g, '-'));
    const r = await revealFile(abs, dst);
    if (r.ok && ['docx', 'pptx'].includes(ext(abs))) {
      // et son PDF, si c'est un document
      await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', tmp, r.dst]).catch(() => {});
    }
    if (r.ok) {
      for (const n of readdirSync(tmp)) putReal('reel', n, readFileSync(path.join(tmp, n)));
      save();
    }
    return r;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export function listReels() {
  if (isLocked()) return [];
  const out = load().blobs.filter((b) => b.type === 'reel').map((b) => ({ name: b.name, id: 'b:' + b.id, size: b.size, mtime: b.at }));
  const dir = path.join(VAULT_DIR, 'reels');
  const walk = (d) => { for (const n of (existsSync(d) ? readdirSync(d) : [])) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push({ name: n, id: path.relative(dir, p), size: statSync(p).size, mtime: statSync(p).mtimeMs }); } };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}
/** Une version réelle, pour le téléchargement. → { name, data } ou null */
export function reelFile(id) {
  id = String(id || '');
  if (isLocked()) return null;
  if (id.startsWith('b:')) {
    const b = load().blobs.find((x) => x.type === 'reel' && x.id === id.slice(2));
    return b && dek ? { name: b.name, data: unseal(dek, readFileSync(path.join(BLOB_DIR(), b.id + '.enc'))) } : null;
  }
  const dir = path.join(VAULT_DIR, 'reels');
  const p = path.resolve(dir, id);
  return p.startsWith(dir + path.sep) && existsSync(p) ? { name: path.basename(p), data: readFileSync(p) } : null;
}

/**
 * Anonymiser un dossier du workspace : chaque fichier va au coffre (originaux/),
 * une copie pseudonymisée (nom compris) prend sa place. `dryRun` : seulement le rapport.
 */
export async function anonymizeTree(root, rel, { dryRun = false } = {}) {
  const base = path.join(root, rel);
  const report = { fichiers: 0, anonymises: 0, deplaces_au_coffre: 0, inchanges: 0, renommes: 0, images: [], non_pris: [], entites_avant: load().entities.length };
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (n === '__pycache__' || n === 'node_modules' || n.startsWith('.')) continue;
      if (statSync(p).isDirectory()) walk(p); else files.push(p);
    }
  };
  if (existsSync(base)) walk(base);
  // déjà anonymisés (une 2e exécution ne doit rien refaire : elle écraserait les originaux du coffre)
  const done = new Set(load().files.filter((f) => f.masked).map((f) => f.masked));
  for (let i = files.length - 1; i >= 0; i--) if (done.has(path.relative(root, files[i]))) { files.splice(i, 1); report.deja_faits = (report.deja_faits || 0) + 1; }
  // 1er passage : apprendre les entités dans les textes (motifs, sociétés, civilités) et les noms de fichiers
  // (tous les formats, PDF et Office compris : un nom qui n'est que dans un PDF doit être connu
  //  avant de calculer les noms de fichiers)
  const scratch = path.join(VAULT_DIR, 'tmp-apprentissage');
  for (const p of files) {
    mask(path.relative(root, p));
    const k = ext(p);
    if (TEXT_EXT.has(k) && statSync(p).size < 2e6) mask(readFileSync(p, 'utf8'));
    else if ((OFFICE[k] || k === 'pdf') && statSync(p).size < 60e6) await maskFile(p, path.join(scratch, 'x.' + k)).catch(() => {});
  }
  rmSync(scratch, { recursive: true, force: true });
  for (const p of files) {
    report.fichiers++;
    const r0 = path.relative(root, p);
    const r1 = mask(r0, { learn: false });
    const k = ext(p);
    if (dryRun) { if (r1 !== r0) report.renommes++; continue; }
    putReal('orig', r0, readFileSync(p));
    const dst = path.join(root, r1);
    if (TEXT_EXT.has(k) || OFFICE[k] || k === 'pdf') {
      const res = await maskFile(p, dst + '.anon-tmp' + path.extname(dst));
      const finalDst = res.how === 'pdf→texte' ? dst + '.txt' : dst;
      if (p !== finalDst) rmSync(p, { force: true });
      renameSync(res.dst, finalDst);
      report.anonymises++;
      state.files.push({ orig: r0, masked: path.relative(root, finalDst), how: res.how, at: Date.now() });
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(k)) {
      mkdirSync(path.dirname(dst), { recursive: true });
      const img = readFileSync(p);
      rmSync(p, { force: true });
      writeFileSync(dst, /^jpe?g$/.test(k) ? stripJpeg(img) : img);
      report.images.push(path.relative(root, dst));
      state.files.push({ orig: r0, masked: path.relative(root, dst), how: 'image (à vérifier)', at: Date.now() });
    } else {
      rmSync(p, { force: true });
      report.deplaces_au_coffre++;
      report.non_pris.push(r1);
      state.files.push({ orig: r0, masked: null, how: 'au coffre seulement', at: Date.now() });
    }
    if (r1 !== r0) report.renommes++;
  }
  // un PDF dont le Word voisin vient d'être anonymisé : le régénérer depuis ce Word
  if (!dryRun) {
    for (const f of state.files.filter((x) => x.how === 'pdf→texte' && x.at > Date.now() - 3600e3)) {
      const pdfTxt = path.join(root, f.masked);
      const docx = pdfTxt.replace(/\.pdf\.txt$/i, '.docx');
      if (existsSync(docx)) {
        await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', path.dirname(docx), docx]).catch(() => {});
        if (existsSync(docx.replace(/\.docx$/i, '.pdf'))) { rmSync(pdfTxt, { force: true }); f.masked = path.relative(root, docx.replace(/\.docx$/i, '.pdf')); f.how = 'pdf régénéré'; }
      }
    }
  }
  // dossiers vides laissés par les renommages
  const prune = (d) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) prune(p); } if (d !== base && !readdirSync(d).length) rmSync(d, { recursive: true }); };
  if (!dryRun) { prune(base); const top = String(rel).split('/')[0]; if (top && !state.roots.includes(top)) state.roots.push(top); save(); }
  report.entites_apres = load().entities.length;
  log('INFO', `vault: ${rel} — ${report.fichiers} fichiers, ${report.anonymises} anonymisés${dryRun ? ' (essai)' : ''}`);
  return report;
}

// ── La garde : l'agent n'atteint jamais le coffre ─────────────────────────────
const PARENTS = ['/', '/data', DATA_DIR, path.dirname(VAULT_DIR)].map((p) => p.replace(/\/+$/, '') || '/');
// in command position only (start, after ; & | ( or $( , sudo, xargs): « du » or « find » in a sentence is not a command
const RECURSIVE = /(?:^|[;&|`(\n]|\$\()\s*(?:(?:sudo|xargs|nice|timeout\s+\S+)\s+)*(?:grep|rg|ag|find|fd|ls\s+-[a-zA-Z]*R|tree|du|tar|zip|rsync|cp\s+-[a-zA-Z]*r|scp|locate)\b/;

export function vaultGuard(input) {
  const tool = input?.tool_name || '';
  const ti = input?.tool_input ?? {};
  const blob = JSON.stringify(ti);
  const deny = (why) => ({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  if (blob.includes(VAULT_MARK) || blob.includes(VAULT_DIR) || /api\/vault/i.test(blob)) return deny('Le coffre du mode Confidentiel est inaccessible à l\'agent (données réelles). Travaille sur les fichiers pseudonymisés du workspace.');
  const raw = String(ti.path || ti.file_path || '');
  const target = raw ? (raw.replace(/\/+$/, '') || '/') : null;
  if ((tool === 'Grep' || tool === 'Glob') && target && PARENTS.includes(target)) return deny(`Recherche trop large (${target}) : elle traverserait le coffre du mode Confidentiel. Cible un dossier plus précis.`);
  if (tool === 'Bash' && RECURSIVE.test(ti.command || '') && new RegExp(`(^|[\\s'"=])(${PARENTS.filter((p) => p !== '/').map(esc).join('|')})/?(\\s|$|['"])|(^|\\s)/(\\s|$)`).test(ti.command || '')) {
    return deny('Commande récursive sur un dossier parent du coffre du mode Confidentiel : cible un dossier plus précis.');
  }
  return { continue: true };
}

// ── Le mode strict : avec le bouclier, l'agent ne lit que les dossiers anonymisés ──
// Les résultats d'outils ne passent pas par mask() : ce que l'agent lit ailleurs
// (fichiers, web, connecteurs, Home Assistant) partirait en clair. Le mode strict
// le lui refuse. C'est une garde par motifs (un script peut toujours ouvrir un
// autre fichier) : elle évite l'accident, elle ne remplace pas un bac à sable.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Edit', 'MultiEdit', 'NotebookEdit', 'LS']);
const NET_TOOLS = new Set(['WebFetch', 'WebSearch']);
const MCP_OK = new Set(['mcp__soufassistant__generate_image']);
const SYSTEM_DIRS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/data/tools', '/dev/null', '/tmp'];
const NET_CMD = /(^|[\s;&|(`'"])(curl|wget|ha-tools|ssh|scp|sftp|nc|ncat|telnet|rclone|gh|ftp|sqlite3)(\s|$|;)|\bha\s+(core|apps?|addons?|supervisor|host|backups?|os|network)\b|\bgit\s+(clone|fetch|pull|push|ls-remote)\b|\bpython[\d.]*\s+-m\s+http\b/;
const inside = (p, d) => p === d || p.startsWith(d.replace(/\/+$/, '') + '/');

/** PreToolUse pour un message confidentiel. `roots()` → dossiers autorisés (absolus). */
export function strictGuard(roots, cwd = '/') {
  const home = os.homedir();
  const readOnly = [path.join(home, '.claude', 'skills'), path.join(home, '.claude', 'plugins')];
  const deny = (why) => ({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Mode Confidentiel strict : ${why} Si ce travail n'est pas confidentiel, l'utilisateur peut éteindre le bouclier (sous la zone de saisie).` } });
  return async (input) => {
    const tool = input?.tool_name || '';
    const ti = input?.tool_input ?? {};
    let allowed;
    try { allowed = [...roots(), '/tmp']; } catch (e) { return deny(e.message); }
    const where = allowed.filter((r) => r !== '/tmp').join(', ') || 'aucun dossier anonymisé pour l\'instant (Hub › Confidentiel › Anonymiser)';
    const ok = (abs, extra = []) => [...allowed, ...extra].some((d) => inside(abs, d));
    if (NET_TOOLS.has(tool)) return deny('pas de web : ce qui en revient ne serait pas pseudonymisé.');
    if (tool.startsWith('mcp__') && !MCP_OK.has(tool)) return deny('pas de connecteur ni de navigateur : leurs réponses ne seraient pas pseudonymisées.');
    if (READ_TOOLS.has(tool)) {
      const targets = [ti.file_path, ti.notebook_path, ti.path].filter(Boolean);
      if (!targets.length && (tool === 'Grep' || tool === 'Glob' || tool === 'LS')) targets.push(cwd);
      if (tool === 'Glob' && path.isAbsolute(String(ti.pattern || ''))) targets.push(String(ti.pattern).replace(/[*?[{].*$/, '') || '/');
      for (const t of targets) {
        const abs = path.resolve(cwd, String(t));
        if (!ok(abs, readOnly)) return deny(`lecture limitée aux dossiers anonymisés (${where}) — refusé : ${abs}.`);
      }
      return { continue: true };
    }
    if (tool === 'Bash') {
      const cmd = String(ti.command || '');
      if (NET_CMD.test(cmd)) return deny('pas de commande réseau ni d\'accès à Home Assistant (curl, ha-tools, ssh, git fetch…) : leurs résultats ne seraient pas pseudonymisés.');
      if (/(^|[\s'"=:])~(\/|\s|$)|\$\{?HOME\b|(^|[\s/'"=])\.\.(\/|\s|$|['"])/.test(cmd)) return deny('pas de ~, $HOME ni de « .. » dans les commandes : utilise des chemins absolus dans les dossiers anonymisés.');
      const first = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n|$)/);
      const start = first && (first[1] || first[2] || first[3]);
      if (!start || !ok(path.resolve(cwd, start))) return deny(`une commande doit commencer par cd "<dossier anonymisé>" (${where}).`);
      for (const m of cmd.matchAll(/(?:^|[\s;&|(])cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)]+))/g)) {
        const d = m[1] || m[2] || m[3];
        if (!path.isAbsolute(d) || !ok(d)) return deny(`cd hors des dossiers anonymisés : ${d}.`);
      }
      for (const m of cmd.matchAll(/(?:^|[\s'"=:(<>|,])(\/[^\s'";|&)<>,`]*)/g)) {
        const p = m[1].replace(/\/+$/, '') || '/';
        if (!ok(p, SYSTEM_DIRS) && !SYSTEM_DIRS.some((d) => inside(p, d))) return deny(`chemin hors des dossiers anonymisés : ${p}.`);
      }
      return { continue: true };
    }
    return { continue: true };
  };
}

// ── Pièces jointes et invite d'un message confidentiel ───────────────────────
export async function maskAttachments(saved) {
  const notes = [];
  for (const a of saved) {
    const k = ext(a.path);
    if (a.isImage) { notes.push(`image non pseudonymisable : ${a.name}`); continue; }
    if (TEXT_EXT.has(k) || OFFICE[k] || k === 'pdf') {
      const r = await maskFile(a.path, a.path + '.masq' + path.extname(a.path));
      if (r.ok) {
        rmSync(a.path, { force: true });
        const final = r.how === 'pdf→texte' ? a.path + '.txt' : a.path;
        renameSync(r.dst, final);
        a.path = final;
        a.name = mask(a.name, { learn: false });
      }
    } else notes.push(`fichier non pseudonymisable : ${a.name}`);
  }
  return notes;
}

export const CONFIDENTIAL_PROMPT = [
  '## Confidential mode',
  'Names of companies, people, places, projects, references and contact details in this conversation have been replaced',
  'by pseudonyms before reaching you (Client-A, Personne-03, Lieu-02, Projet-01, REF-0004, contact05@exemple.invalid…).',
  'Use them exactly as written — in text, file names and documents — and never try to guess the real identities.',
  'The user sees the real names on their screen and can produce the real version of a deliverable locally ("Particulariser").',
  'Never try to read the confidential vault.',
  'Strict mode is on: you may only read the anonymised workspace folders (and /tmp); the web, connectors, the browser, Home Assistant',
  'and files elsewhere are refused, because what comes back from them is not pseudonymised. Start every Bash command with',
  'cd "<an anonymised folder>" and use absolute paths inside it. If a refusal blocks the task, say so and suggest turning the shield off.',
].join(' ');
