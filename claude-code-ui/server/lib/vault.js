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
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic.js';
import { readZip, makeZip } from './zip.js';
import { leafElements, partParagraphs, setPartParagraphs } from './office-edit.js';
import { log } from './log.js';
import { unknownWords } from './lexicon.js';

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

/**
 * Erase the whole vault: the name table, the originals, the real versions, the
 * passphrase. Works locked too (a forgotten passphrase). Starting from scratch,
 * the next pseudonyms begin again at Client-A.
 */
export function wipe() {
  rmSync(VAULT_DIR, { recursive: true, force: true });
  state = null; compiled = null; dek = null;
  mediaCount.clear();
  log('INFO', 'vault: effacé');
  return true;
}

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
// Words that open a sentence or a request and are never names (FR / EN / NL): not asked about.
// Everything else that starts with a capital is, once — « Ne plus signaler » remembers the answer.
const STARTERS = new Set(`
je j' tu il elle on nous vous ils elles le la les l' un une des du de d' ce c' cet cette ces ça cela ceci
mon ma mes ton ta tes son sa ses notre nos votre vos leur leurs moi toi lui eux y en
bonjour bonsoir salut hello coucou merci cordialement bien oui non ok okay d'accord parfait super
pour par avec sans sur sous dans chez entre vers selon après avant depuis pendant et ou mais donc car puis ensuite enfin alors aussi si
est-ce peux-tu pouvez-vous peux pouvez fais faites fait prépare préparez calcule calculez donne donnez écris écrivez rédige rédigez
envoie envoyez relance relancez demande demandez dis dites montre montrez regarde regardez vérifie vérifiez explique expliquez
crée créez ajoute ajoutez supprime supprimez enlève enlevez retire retirez corrige corrigez lis lisez résume résumez traduis traduisez
analyse analysez compare comparez propose proposez trouve trouvez cherche cherchez mets mettez garde gardez passe passez vas va
quel quelle quels quelles qui que qu' quoi quand comment pourquoi où combien voici voilà attention note remarque objet question réponse
offre offres contrat contrats commande commandes devis facture factures projet projets réunion réunions rapport rapports
comme suite concernant ci-joint ci-dessous ci-dessus veuillez veuille afin vu étant n'hésitez n'hésite également toutefois cependant néanmoins sinon ainsi voir
following regarding attached please kindly also however hereby
zoals betreft bijgevoegd gelieve graag echter verder
mail mails e-mail message document documents fichier fichiers client clients total montant prix budget compte-rendu planning
offer contract order quote invoice project meeting report offerte contract bestelling factuur vergadering verslag
the a an this that these those my your our their i you he she it we they hi dear thanks thank yes no please
can could would should will let make prepare write send check find show give tell add remove fix
het een dit dat deze die mijn jouw onze hun ik jij hij zij wij jullie hallo dag bedankt dank ja nee graag kun kunt wil maak schrijf stuur
lundi mardi mercredi jeudi vendredi samedi dimanche janvier février mars avril mai juin juillet août septembre octobre novembre décembre
monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december
`.split(/\s+/).filter(Boolean));
const PARTICLE = /^(?:de|des|du|van|der|den|la|le|von|&)$/i;
const starter = (w) => STARTERS.has(String(w).toLowerCase().replace(/’/g, "'"));
export function suspects(text) {
  const s = load();
  const t = String(text || '');
  const auto = detect(t);
  const c = compile();
  const listed = (v) => isAliasLike(v) || s.exempt.some((x) => norm(x) === norm(v)) || s.ignored.some((x) => norm(x) === norm(v))
    // already caught as a company (legal form) or a titled person; an e-mail address that
    // contains a name does not cover that name written out next to it
    || auto.some((a) => (a.kind === 'client' || a.kind === 'personne') && norm(a.real).includes(norm(v)));
  const known = (v) => c.byVariant.has(norm(v)) || listed(v);
  const out = new Map();
  const add = (v, kind, group, why) => { if (!out.has(norm(v))) out.set(norm(v), { real: v, kind, ...(group ? { group } : {}), ...(why ? { why } : {}) }); };
  // e-mails: the people in the headers, the greeting and the signature — even when their name is
  // also a common word (« Jean », « Marc »)
  for (const m of t.matchAll(MAIL_HEADER)) {
    for (let part of m[1].split(/[;,]/)) {
      part = part.replace(/<[^>]*>|\[[^\]]*\]|["'“”]/g, '').trim();
      if (part.length >= 2 && /\p{L}/u.test(part) && !/@/.test(part) && !known(part) && !part.split(/\s+/).every((w) => known(w))) add(part, 'personne');
    }
  }
  for (const m of t.matchAll(GREETING)) { const v = m[1].trim(); if (!known(v) && !starter(v)) add(v, 'personne'); }
  for (const m of t.matchAll(SIGN_OFF)) {
    const line = (m[1] || '').trim();
    if (line && line.length <= 60 && !/[@\d]/.test(line) && !known(line) && !line.split(/\s+/).every((w) => known(w) || starter(w.replace(/[,.!]$/, '')))) add(line, 'personne');
  }
  const runs = [];
  for (const m of t.matchAll(CAP)) {
    let words = m[1].replace(/[-'’&]+$/, '').split(/\s+/);
    const before = t.slice(0, m.index).replace(/[ \t«"“(\[*_>•–-]+$/, '');
    const atStart = !before || /[.!?:;\n]$/.test(before);
    // « Prépare », « Bonjour »… at the start of a run are not names; the first word otherwise
    // counts like any other — a list of names, one per line, is flagged too
    let shifted = false;
    while (words.length && starter(words[0])) { words.shift(); shifted = true; }
    if (!words.length) continue;
    // a capitalised common noun opening the sentence sticks to the name after it
    // (« Commande de L'Oréal », « Contrat Acme Service »): asked about on its own
    if (atStart && !shifted && words.length >= 2) {
      const rest = words.slice(1);
      const restText = rest.join(' ');
      if (PARTICLE.test(rest[0]) || (c.mask && new RegExp(c.mask.source, 'iu').test(restText))) {
        runs.push([words[0]]);
        while (rest.length && PARTICLE.test(rest[0])) rest.shift();
        words = rest;
        if (!words.length) continue;
      }
    }
    runs.push(words);
  }
  for (const words of runs) {
    const v = words.join(' ');
    if (v.length < 2 || /^\p{Lu}$/u.test(v) || /^\d/.test(v) || known(v)) continue;
    // a protected name with more capitalised words around it is a name of its own (« X Service »):
    // proposed whole, as a new entry of the same kind
    const inner = c.mask ? [...v.matchAll(c.mask)] : [];
    if (inner.length) {
      const rest = v.replace(c.mask, ' ').trim().split(/\s+/).filter(Boolean);
      if (!rest.length || rest.every((w) => starter(w) || known(w) || PARTICLE.test(w))) continue;
      const e = c.byVariant.get(norm(inner[0][0]));
      add(v, e?.kind || 'client', e?.alias || true);
      continue;
    }
    if (words.every((w) => known(w))) continue;
    const kind = !COMPANY.test(v) && words.length >= 2 && words.every((w) => /^\p{Lu}[\p{Ll}'’-]+$|^\p{Lu}{2,}$/u.test(w)) && words.length <= 3 && !words.some((w) => /^\p{Lu}{2,}$/u.test(w) && w.length > 3) ? 'personne' : 'client';
    add(v, kind);
  }
  // lowercase words no dictionary of the message's language knows: a client written « fortis »
  for (const w of unknownWords(t, (x) => known(x) || starter(x) || c.byVariant.has(norm(x)))) add(w.real, 'client', null, 'mot inconnu du dictionnaire');
  return { auto, unknown: [...out.values()].slice(0, 150) };
}

const MAIL_HEADER = /^[ \t>]*(?:de|from|van|à|a|to|aan|cc|cci|bcc)[ \t]*:[ \t]*(.+)$/gimu;
const GREETING = /^[ \t>]*(?:bonjour|bonsoir|salut|coucou|hello|hi|hey|dear|cher|chère|beste|dag|hallo|geachte)[ \t]+(?:(?:m\.|mr\.?|mme|madame|monsieur|mevrouw|meneer|heer)[ \t]+)?([\p{L}'’-]+(?:[ \t]+[\p{Lu}][\p{L}'’-]+)?)[ \t]*[,!:]/gimu;
const SIGN_OFF = /^[ \t>]*(?:cordialement|bien cordialement|bien à (?:vous|toi)|salutations(?: distinguées)?|bonne journée|merci d'avance|regards|kind regards|best regards|best|cheers|met vriendelijke groet(?:en)?|vriendelijke groet(?:en)?|mvg|groeten)[ \t]*[,.!]?[ \t]*\r?\n+[ \t>]*([^\n]+)/gimu;

/**
 * Où sont les données sensibles dans une ligne de texte (OCR d'une image, texte
 * d'un plan) : pour masquer des zones de pixels. Rien n'est appris ni envoyé.
 * `sure` : coffre, motifs, URL, adresse, société avec forme juridique, personne
 * avec civilité — masqué d'office ; sinon une suggestion (noms possibles).
 * → [{ start, end, sure, why }]
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\b[\w-]+(?:\.[\w-]+)*\.(?:be|com|eu|net|org|fr|nl|lu|de|io|cloud)(?:\/[^\s<>"']*)?(?![\w@])/gi;
// code postal + localité (pas « XV-2003 Open », pas « 3456 Site: »), rue, et les valeurs des champs d'un cartouche ou d'un formulaire
const POSTAL_RE = /(?<![\p{L}\p{N}_./-])[1-9]\d{3}\s+\p{Lu}\p{Ll}[\p{L}'’-]*(?:[\s-]\p{Lu}\p{Ll}[\p{L}'’-]*)?(?![\p{L}:])/gu;
const STREET_RE = /\b(?:rue|avenue|av\.|chaussée|boulevard|bd|place|quai|chemin|allée|street|road)\s+[^,;\n]{2,40}|\b\p{L}+(?:straat|laan|steenweg|weg|plein|lei|dreef|kaai)\b(?:\s+\d+\w?)?/giu;
const DWG_RE = /\b(?:dwg|drawing|plan|tekening|doc(?:ument)?)\s*(?:n[o°º.]*|nr\.?|number|num[ée]ro|#)\s*[:#]?\s*([A-Z0-9][^\n]{1,40}?)(?=\s+rev\b|\s*$)/giu;
const LABEL_WORD = /^(?:dwg|drawing|plan|tekening|rev|client|project|projet|site|scale|[ée]chelle|schaal|date|datum|sheet|feuille|blad)\b/i;
const LABEL_RE = /\b(?:client|klant|customer|owner|ma[îi]tre d['’]ouvrage|bouwheer|opdrachtgever|project|projet|site|location|lieu|adresse|address|adres|drawing(?:\s+n[o°º.]*)?|dwg(?:\s+n[o°º.]*)?|plan\s+n[o°º.]*|tekening(?:\s*nr\.?)?|r[ée]f(?:[ée]rence)?|contract|contrat|order|commande|bestelling|po|approved|checked|drawn|designed|dessin[ée]|v[ée]rifi[ée]|approuv[ée]|getekend|gecontroleerd|signature|signed|handtekening)\s*[:#]\s*([^\n]{1,80})/giu;
export function sensitiveSpans(text) {
  const t = String(text || '');
  const out = [];
  const add = (start, end, sure, why) => { if (end > start) out.push({ start, end, sure, why }); };
  const c = compile();
  const s = load();
  const exempt = (v) => s.exempt.some((x) => norm(x) === norm(v));
  const exemptAll = (v) => exempt(v) || isAliasLike(v);
  if (c.mask) for (const m of t.matchAll(c.mask)) add(m.index, m.index + m[0].length, true, 'coffre');
  for (const [kind, re] of PATTERNS) for (const m of t.matchAll(re)) if (!isAliasLike(m[0])) add(m.index, m.index + m[0].length, true, kind);
  for (const m of t.matchAll(URL_RE)) add(m.index, m.index + m[0].length, true, 'url');
  for (const re of [POSTAL_RE, STREET_RE]) for (const m of t.matchAll(re)) add(m.index, m.index + m[0].length, true, 'adresse');
  for (const m of t.matchAll(DWG_RE)) add(m.index + m[0].length - m[1].length, m.index + m[0].length, true, 'n° de plan');
  for (const m of t.matchAll(LABEL_RE)) { const v = m[1].trim(); const i = m.index + m[0].length - m[1].length + (m[1].length - m[1].trimStart().length); if (v && !exemptAll(v)) add(i, i + v.length, true, 'champ'); }
  for (const m of t.matchAll(LEGAL)) if (!exempt(m[1])) add(m.index, m.index + m[0].length, true, 'société');
  for (const m of t.matchAll(TITLED)) if (!exempt(m[1])) add(m.index, m.index + m[0].length, true, 'personne');
  for (const u of suspects(t).unknown) {
    if (/\d/.test(u.real) || /^\p{Lu}{1,4}$/u.test(u.real) || /[:#]$/.test(u.real)) continue;     // repères d'équipement (PT-101), sigles courts, libellés « CLIENT: »
    if (LABEL_WORD.test(u.real)) continue;
    for (let i = t.indexOf(u.real); i >= 0; i = t.indexOf(u.real, i + 1)) if (!/^\s*[:#]/.test(t.slice(i + u.real.length))) add(i, i + u.real.length, false, 'nom possible');
  }
  return out;
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
// Old binary and OpenDocument formats: converted here by LibreOffice, then masked like the others.
// The pseudonymised copy is in the new format (a .doc becomes a .docx).
export const LEGACY = { doc: 'docx', rtf: 'docx', odt: 'docx', xls: 'xlsx', ods: 'xlsx', ppt: 'pptx', odp: 'pptx' };
const ext = (p) => path.extname(p).slice(1).toLowerCase();

function run(cmd, args, timeout = 240000) {
  return new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (e, out) => (e ? rej(e) : res(String(out)))));
}

// ── Office (docx / pptx / xlsx) ─────────────────────────────────────────────
// Images in a PNG: drop its text / EXIF / time chunks (the pixels are kept).
export function stripPng(buf) {
  const SIG = '89504e470d0a1a0a';
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== SIG) return buf;
  const out = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const end = i + 12 + len;
    if (end > buf.length) return buf;   // unexpected structure: leave it alone
    if (!['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) out.push(buf.subarray(i, end));
    i = end;
    if (type === 'IEND') break;
  }
  return Buffer.concat(out);
}

// Placeholders for pictures the browser cannot repaint (vector / legacy formats): blank, same format.
const BLANK = {
  gif: () => Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
  svg: () => Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#000"/></svg>'),
  emf: () => {   // EMR_HEADER (88 bytes) + EMR_EOF (20 bytes)
    const b = Buffer.alloc(108);
    b.writeUInt32LE(1, 0); b.writeUInt32LE(88, 4);
    b.writeInt32LE(1, 16); b.writeInt32LE(1, 20); b.writeInt32LE(26, 32); b.writeInt32LE(26, 36);   // bounds, frame (0.01 mm)
    b.write(' EMF', 40, 'latin1'); b.writeUInt32LE(0x10000, 44); b.writeUInt32LE(108, 48); b.writeUInt32LE(2, 52);
    b.writeInt32LE(1920, 72); b.writeInt32LE(1080, 76); b.writeInt32LE(508, 80); b.writeInt32LE(286, 84);
    b.writeUInt32LE(14, 88); b.writeUInt32LE(20, 92); b.writeUInt32LE(0, 96); b.writeUInt32LE(16, 100); b.writeUInt32LE(20, 104);
    return b;
  },
  wmf: () => {   // META_HEADER (18 bytes) + META_EOF (6 bytes)
    const b = Buffer.alloc(24);
    b.writeUInt16LE(1, 0); b.writeUInt16LE(9, 2); b.writeUInt16LE(0x300, 4); b.writeUInt32LE(12, 6);
    b.writeUInt16LE(0, 10); b.writeUInt32LE(3, 12); b.writeUInt16LE(0, 16);
    b.writeUInt32LE(3, 18); b.writeUInt16LE(0, 22);
    return b;
  },
};
export const MEDIA_RE = /^(?:word|ppt|xl)\/media\/[^/]+\.(png|jpe?g|gif|svg|emf|wmf|bmp|tiff?|wdp)$/i;
const PAINTABLE = /\.(png|jpe?g)$/i;

/** The pictures inside an Office file, for the redaction editor. → { images: [{ path, mime, b64 }], other: [path] } */
export function officeMedia(buf) {
  const images = [], other = [];
  for (const e of readZip(buf)) {
    if (!MEDIA_RE.test(e.name)) continue;
    if (PAINTABLE.test(e.name)) images.push({ path: e.name, mime: /png$/i.test(e.name) ? 'image/png' : 'image/jpeg', b64: e.data.toString('base64') });
    else other.push(e.name);
  }
  return { images, other };
}

const SAFE_HOST = /(^|\.)(openxmlformats\.org|microsoft\.com|office\.com|w3\.org|purl\.org|schemas\.[\w.-]+|exemple\.invalid|lien-masque\.invalid)$/i;
/** An external link: the address of a client's site or mailbox is an identity too. */
function maskUrl(u, fn) {
  const v = String(u);
  if (/^mailto:/i.test(v)) return 'mailto:' + fn(v.slice(7).split('?')[0]);
  const m = v.match(/^(\w[\w+.-]*:\/\/)([^/?#:]+)/);
  if (!m) return fn(v);
  const host = m[2].toLowerCase();
  const exempt = load().exempt.some((x) => host.includes(norm(x).replace(/\s+/g, '')));
  return SAFE_HOST.test(host) || exempt ? fn(v) : `${m[1]}lien-masque.invalid/`;
}
/** The authors of comments and tracked changes, the creator of the file: people, learnt as such. */
function learnPerson(v) {
  const n = String(v || '').trim();
  if (n.length >= 2 && !/^[\d\s.@-]+$/.test(n) && !load().exempt.some((x) => norm(x) === norm(n))) addEntity({ real: n, kind: 'personne', auto: true });
}

const unx = (v) => v.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const enx = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const enxT = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');   // text nodes: quotes stay as written
const attr = (x, names, f) => x.replace(new RegExp(`(\\s(?:${names})=")([^"]*)"`, 'g'), (m, pre, v) => `${pre}${enx(f(unx(v)))}"`);

/**
 * `fn` over every piece of text of an Office file. With `masking`: authors and
 * creators are learnt first, external links are masked, embedded Office files
 * are treated too (other embedded objects are emptied), pictures the user
 * repainted (`media`: path → Buffer) replace the originals, and with
 * `blankMedia` the pictures that cannot be repainted are blanked. `notes`
 * collects what the user should know.
 */
function transformOffice(buf, kind, fn, opts = {}) {
  const { masking = false, media = null, blankMedia = false, notes = [] } = opts;
  const entries = readZip(buf);
  const files = new Map(entries.map((e) => [e.name, e.data]));
  const flavor = kind === 'pptx' ? 'pptx' : 'docx';
  const xmlNames = [...files.keys()].filter((n) => /\.(xml|rels)$/i.test(n));

  if (masking) {
    for (const name of xmlNames) {
      const x = files.get(name).toString('utf8');
      for (const m of x.matchAll(/\s(?:w:author|author)="([^"]+)"/g)) learnPerson(unx(m[1]));
      // displayName is a person only in Excel's list of people (a table has one too: « Tableau1 »)
      if (/persons\/person\.xml$/.test(name)) for (const m of x.matchAll(/\sdisplayName="([^"]+)"/g)) learnPerson(unx(m[1]));
      if (/commentAuthors\.xml$/.test(name)) for (const m of x.matchAll(/\sname="([^"]+)"/g)) learnPerson(unx(m[1]));
      // <dc:creator xmlns:dc="…">: the element may carry attributes
      if (/docProps\/core\.xml$/.test(name)) for (const m of x.matchAll(/<(?:dc:creator|cp:lastModifiedBy)\b[^>]*>([^<]+)</g)) learnPerson(unx(m[1]));
      if (/docProps\/app\.xml$/.test(name)) for (const m of x.matchAll(/<Manager\b[^>]*>([^<]+)</g)) learnPerson(unx(m[1]));
    }
  }

  for (const name of xmlNames) {
    let x = files.get(name).toString('utf8');
    const isPart = kind === 'docx' ? /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(name)
      : kind === 'pptx' ? /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(name) : false;
    if (/(^|\/)_rels\/[^/]+\.rels$/.test(name)) {
      // external targets only (hyperlinks, linked files): the rest are part paths
      if (masking) x = x.replace(/<Relationship\b[^>]*>/g, (r) => (/TargetMode="External"/.test(r) ? r.replace(/\sTarget="([^"]*)"/, (m, t) => ` Target="${enx(maskUrl(unx(t), fn))}"`) : r));
      files.set(name, Buffer.from(x));
      continue;
    }
    if (/^\[Content_Types\]\.xml$|\/theme\/|\/styles\.xml$|\/fontTable\.xml$|\/settings\.xml$/.test(name)) continue;
    if (isPart) {
      const edits = partParagraphs(x, flavor).filter((p) => p.text.trim()).map((p) => ({ i: p.i, old: p.text, text: fn(p.text) })).filter((e) => e.text !== e.old);
      if (edits.length) x = setPartParagraphs(x, flavor, edits);
      // tracked deletions and field codes are not paragraph text
      x = x.replace(/(<w:(?:delText|instrText)\b[^>]*>)([^<]*)(<\/w:(?:delText|instrText)>)/g, (m, a, t, b) => {
        let v = unx(t);
        if (masking) v = v.replace(/HYPERLINK\s+"([^"]+)"/g, (h, u) => `HYPERLINK "${maskUrl(u, fn)}"`);
        return a + enxT(fn(v)) + b;
      });
      // and any text left outside a paragraph (a malformed or hand-made part): masking twice is harmless
      x = x.replace(/>([^<>]+)</g, (m, t) => `>${enxT(fn(unx(t)))}<`);
    } else {
      // every other XML part (SmartArt, charts, masters, comments, docProps, sheets, shared strings…): its text nodes
      x = x.replace(/>([^<>]+)</g, (m, t) => `>${enxT(fn(unx(t)))}<`);
    }
    // people and labels kept in attributes
    x = attr(x, 'w:author|author|userId|caption', fn);
    if (/persons\/person\.xml$/.test(name)) x = attr(x, 'displayName', fn);
    if (/commentAuthors\.xml$/.test(name)) x = attr(x, 'name|initials', fn);
    if (/^xl\/workbook\.xml$/.test(name)) x = x.replace(/<sheet\b[^>]*>/g, (t) => attr(t, 'name', (v) => fn(v).slice(0, 31)));
    if (/^xl\/tables\/[^/]+\.xml$/.test(name)) {
      // a column's name must stay equal to its (masked) header cell, or Excel "repairs" the file
      x = x.replace(/<tableColumn\b[^>]*>/g, (t) => attr(t, 'name', fn));
      x = x.replace(/<table\b[^>]*>/, (t) => attr(t, 'name|displayName', (v) => fn(v).replace(/[^\p{L}\p{N}_.]/gu, '_')));
    }
    if (/^xl\/(pivotCache|pivotTables)\//.test(name)) x = attr(x, 'v|n|name|caption', fn);
    x = attr(x, 'descr|title', fn).replace(/(<(?:p|pic|wp|xdr|dgm):(?:cNvPr|docPr)\b[^>]*?\bname=")([^"]*)"/g, (m, pre, v) => `${pre}${enx(fn(unx(v)))}"`);
    files.set(name, Buffer.from(x));
  }

  for (const name of [...files.keys()]) {
    // embedded files: an Office one is treated like the outer file, anything else is emptied
    if (masking && /^(?:word|ppt|xl)\/embeddings\//.test(name)) {
      const k = (name.match(/\.(docx|pptx|xlsx|docm|pptm|xlsm)$/i) || [])[1];
      if (k) {
        try { files.set(name, transformOffice(files.get(name), OFFICE[k.slice(0, 3) + 'x'] || 'docx', fn, { ...opts, media: null })); }
        catch { files.set(name, Buffer.alloc(0)); notes.push(`objet incorporé illisible, vidé : ${path.basename(name)}`); }
      } else {
        files.set(name, Buffer.alloc(0));
        notes.push(`objet incorporé vidé (non pseudonymisable) : ${path.basename(name)}`);
      }
      continue;
    }
    if (!MEDIA_RE.test(name)) continue;
    if (media?.has(name)) { files.set(name, media.get(name)); continue; }
    const e = ext(name);
    if (masking && blankMedia && !PAINTABLE.test(name)) {
      const b = BLANK[e];   // tiff, bmp and wdp have none: reported
      if (b) files.set(name, b()); else notes.push(`image non masquée (format ${e}) : ${path.basename(name)}`);
      continue;
    }
    if (/^jpe?g$/.test(e)) files.set(name, stripJpeg(files.get(name)));
    else if (e === 'png') files.set(name, stripPng(files.get(name)));
  }
  return makeZip(entries.filter((e) => files.has(e.name)).map((e) => ({ name: e.name, data: files.get(e.name) })), { deflate: true });
}

/** Écrire `dst` = `src` passé par `fn` (mask ou reveal). → { ok, how, dst } */
export async function transformFile(src, dst, fn, opts = {}) {
  const k = ext(src);
  mkdirSync(path.dirname(dst), { recursive: true });
  if (TEXT_EXT.has(k)) { writeFileSync(dst, fn(readFileSync(src, 'utf8'))); return { ok: true, how: 'texte', dst }; }
  if (OFFICE[k]) { writeFileSync(dst, transformOffice(readFileSync(src), OFFICE[k], fn, opts)); return { ok: true, how: k, dst, notes: opts.notes || [] }; }
  if (LEGACY[k]) {
    const conv = await convertLegacy(readFileSync(src), k);
    const d2 = withOoxmlExt(dst);
    writeFileSync(d2, transformOffice(conv, LEGACY[k], fn, opts));
    return { ok: true, how: `${k}→${LEGACY[k]}`, dst: d2, notes: opts.notes || [] };
  }
  if (k === 'pdf') {
    const txt = await run('pdftotext', ['-layout', '-q', src, '-']).catch(() => '');
    const d2 = dst.replace(/\.pdf$/i, '.pdf.txt');
    writeFileSync(d2, fn(txt));
    return { ok: true, how: 'pdf→texte', dst: d2 };
  }
  return { ok: false, how: 'non pris en charge', dst };
}

/** `x.doc` → `x.docx` (unchanged for any other format). */
export const withOoxmlExt = (p) => { const k = ext(p); return LEGACY[k] ? String(p).slice(0, -k.length) + LEGACY[k] : p; };
// The same file converted twice gives the same media names: kept a quarter of an hour, so the
// pictures shown in the redaction editor are the ones masking then replaces.
const legacyCache = new Map();   // sha256 → { buf, at }
export async function convertLegacy(buf, k) {
  const target = LEGACY[k];
  if (!target) return buf;
  const key = createHash('sha256').update(buf).digest('hex');
  for (const [h, v] of legacyCache) if (Date.now() - v.at > 15 * 60e3) legacyCache.delete(h);
  if (legacyCache.has(key)) return legacyCache.get(key).buf;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
  try {
    const src = path.join(tmp, 'in.' + k);
    writeFileSync(src, buf);
    // its own profile: a LibreOffice already running (previews) would otherwise hold the lock
    await run('soffice', [`-env:UserInstallation=file://${tmp}/profile`, '--headless', '--convert-to', target, '--outdir', tmp, src], 180000);
    const out = path.join(tmp, 'in.' + target);
    if (!existsSync(out)) throw new Error(`conversion ${k} → ${target} impossible`);
    const b = readFileSync(out);
    legacyCache.set(key, { buf: b, at: Date.now() });
    return b;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export const maskFile = (src, dst, opts = {}) => transformFile(src, dst, (t) => mask(t), { masking: true, notes: [], ...opts });
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
  const report = { fichiers: 0, anonymises: 0, deplaces_au_coffre: 0, inchanges: 0, renommes: 0, images: [], non_pris: [], convertis: [], documents_images: [], entites_avant: load().entities.length };
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
    else if ((OFFICE[k] || LEGACY[k] || k === 'pdf') && statSync(p).size < 60e6) await maskFile(p, path.join(scratch, 'x.' + k)).catch(() => {});
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
    if (TEXT_EXT.has(k) || OFFICE[k] || LEGACY[k] || k === 'pdf') {
      const res = await maskFile(p, dst + '.anon-tmp' + path.extname(dst)).catch((e) => ({ ok: false, error: e.message }));
      if (!res.ok) {
        // never leave the clear original in the workspace: it is in the vault already
        rmSync(p, { force: true });
        report.deplaces_au_coffre++;
        report.non_pris.push(`${r1} (${res.error || res.how})`);
        state.files.push({ orig: r0, masked: null, how: 'au coffre seulement', at: Date.now() });
        continue;
      }
      const finalDst = res.how === 'pdf→texte' ? dst + '.txt' : withOoxmlExt(dst);
      if (p !== finalDst) rmSync(p, { force: true });
      renameSync(res.dst, finalDst);
      report.anonymises++;
      if (LEGACY[k]) report.convertis.push(path.relative(root, finalDst));
      if (OFFICE[ext(finalDst)]) {
        const m = officeMedia(readFileSync(finalDst));
        if (m.images.length || m.other.length) report.documents_images.push(path.relative(root, finalDst));
      }
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

// ── Images du workspace laissées « à vérifier » par l'anonymisation ──────────
export function imagesToCheck(root) {
  if (isLocked()) return [];
  return load().files.filter((f) => f.how === 'image (à vérifier)' && f.masked && existsSync(path.join(root, f.masked))).map((f) => f.masked);
}
/** Remplacer une image du workspace par sa version masquée (PNG) ; l'original va au coffre. → nouveau chemin */
export function saveRedacted(root, rel, png) {
  const s = load();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep) || !existsSync(abs)) return null;
  const f = s.files.find((x) => x.masked === rel);
  putReal('orig', (f?.orig || rel) + ' (avant masquage)', readFileSync(abs));
  const relPng = rel.replace(/\.[^./]+$/, '') + '.png';
  writeFileSync(path.join(root, relPng), png);
  if (relPng !== rel) rmSync(abs, { force: true });
  if (f) { f.masked = relPng; f.how = 'image masquée'; f.at = Date.now(); } else s.files.push({ orig: rel, masked: relPng, how: 'image masquée', at: Date.now() });
  save();
  return relPng;
}

// ── Documents du workspace dont les images restent à vérifier ─────────────────
const mediaCount = new Map();   // abs → { mtime, images, other }
export function docsToCheck(root) {
  if (isLocked()) return [];
  const out = [];
  for (const f of load().files) {
    if (!f.masked || f.imagesChecked || !OFFICE[ext(f.masked)]) continue;
    const abs = path.join(root, f.masked);
    if (!existsSync(abs)) continue;
    const mtime = statSync(abs).mtimeMs;
    let c = mediaCount.get(abs);
    if (!c || c.mtime !== mtime) {
      try { const m = officeMedia(readFileSync(abs)); c = { mtime, images: m.images.length, other: m.other.length }; } catch { c = { mtime, images: 0, other: 0 }; }
      mediaCount.set(abs, c);
    }
    if (c.images || c.other) out.push({ path: f.masked, images: c.images, other: c.other });
  }
  return out;
}
/**
 * A workspace document's pictures, checked: `media` (path → Buffer) repainted in the
 * editor replace the originals, `blank` blanks those that cannot be repainted;
 * neither = « rien de sensible ». The document leaves the list. → true
 */
export function saveDocMedia(root, rel, media = null, blank = false) {
  const s = load();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(path.resolve(root) + path.sep) || !existsSync(abs) || !OFFICE[ext(abs)]) return false;
  if (media?.size || blank) {
    const entries = readZip(readFileSync(abs)).map((e) => {
      if (!MEDIA_RE.test(e.name)) return e;
      if (media?.has(e.name)) return { name: e.name, data: media.get(e.name) };
      const b = blank && !PAINTABLE.test(e.name) && BLANK[ext(e.name)];
      return b ? { name: e.name, data: b() } : e;
    });
    writeFileSync(abs, makeZip(entries.map((e) => ({ name: e.name, data: e.data })), { deflate: true }));
  }
  const f = s.files.find((x) => x.masked === rel);
  if (f) f.imagesChecked = Date.now(); else s.files.push({ orig: rel, masked: rel, how: 'document', imagesChecked: Date.now(), at: Date.now() });
  save();
  return true;
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
  // a recursive tool and a parent of the vault in the *same* command segment: « ls && echo a / b »
  // or a sentence with « du » next to a lone slash is not a search through /
  if (tool === 'Bash') {
    const parent = new RegExp(`(^|[\\s'"=])(${PARENTS.filter((p) => p !== '/').map(esc).join('|')})/?(\\s|$|['"])|(^|\\s)/(\\s|$)`);
    const segments = String(ti.command || '').split(/;|&&|\|\||\||\n|`|\$\(/);
    if (segments.some((sg) => RECURSIVE.test(sg) && parent.test(sg))) {
      return deny('Commande récursive sur un dossier parent du coffre du mode Confidentiel : cible un dossier plus précis.');
    }
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
    const ok = (abs, extra = []) => safeFiles.has(path.resolve(abs)) || [...allowed, ...extra].some((d) => inside(abs, d));
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
// Attachments already pseudonymised / masked: the strict guard lets the agent read exactly these.
const safeFiles = new Set();
export const markSafe = (p) => safeFiles.add(path.resolve(p));

export async function maskAttachments(saved) {
  const notes = [];
  for (const a of saved) {
    const k = ext(a.path);
    if (a.isImage && a.redacted) { a.name = mask(a.name, { learn: false }); markSafe(a.path); continue; }   // masked by the user (redact.js), re-encoded PNG
    if (a.isImage) { notes.push(`image non masquée : ${a.name}`); continue; }
    if (TEXT_EXT.has(k) || OFFICE[k] || LEGACY[k] || k === 'pdf') {
      // pictures inside an Office file, repainted in the redaction editor (redact.js) — or all blanked
      const media = a.redactedMedia ? new Map(Object.entries(a.redactedMedia).map(([p, d]) => [p, Buffer.from(String(d).replace(/^data:[^;]+;base64,/, ''), 'base64')])) : null;
      const r = await maskFile(a.path, a.path + '.masq' + path.extname(a.path), { media, blankMedia: !!a.blankMedia })
        .catch((e) => ({ ok: false, how: e.message }));
      for (const n of r.notes || []) notes.push(`${a.name} — ${n}`);
      if (r.ok && (OFFICE[k] || LEGACY[k]) && !a.redactedMedia && !a.blankMedia) {
        const left = officeMedia(readFileSync(r.dst)).images.length;
        if (left) notes.push(`${a.name} — ${left} image(s) non masquée(s) dans le document`);
      }
      if (r.ok) {
        rmSync(a.path, { force: true });
        const final = r.how === 'pdf→texte' ? a.path + '.txt' : withOoxmlExt(a.path);
        renameSync(r.dst, final);
        a.path = final;
        markSafe(final);
        a.name = mask(withOoxmlExt(a.name), { learn: false });
      } else notes.push(`${a.name} — non pseudonymisable (${r.how}) : non transmis`);
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
  'Attached pictures and plans were masked by the user before sending (black boxes): never try to guess what is under them.',
].join(' ');
