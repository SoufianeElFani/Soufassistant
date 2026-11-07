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
 * Ce n'est pas du chiffrement : le coffre est sur la même machine que l'agent.
 * La garde empêche l'agent de l'atteindre (chemin cité, ou recherche récursive
 * dans un dossier parent) ; elle protège contre l'accident, pas contre un attaquant.
 */
import { execFile } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
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

let state = null;

function load() {
  if (state) return state;
  try { state = JSON.parse(readFileSync(VAULT_FILE(), 'utf8')); } catch { state = {}; }
  state.entities ||= [];
  state.exempt ||= ['Equans', 'Equans Digital', 'Equans NV', 'Equans SA', 'Equans NV/SA', 'Soufiane EL FANI', 'Soufiane'];
  state.files ||= [];
  state.counters ||= {};
  return state;
}
function save() {
  mkdirSync(VAULT_DIR, { recursive: true });
  writeFileAtomic(VAULT_FILE(), JSON.stringify(state, null, 1));
  compiled = null;
}
export function reset() { state = null; compiled = null; }

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

export function listEntities() { return load().entities; }
export function exemptList() { return load().exempt; }

/** Ajouter (ou compléter) une entité. → l'entité. */
export function addEntity({ real, kind = 'autre', variants = [], alias, auto = false }) {
  const s = load();
  real = String(real || '').trim();
  if (real.length < 2) return null;
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
export function detect(text) {
  const s = load();
  const out = [];
  const isExempt = (v) => s.exempt.some((x) => norm(v).includes(norm(x)) || norm(x) === norm(v));
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

export function reveal(text) {
  const c = compile();
  return c.reveal && text ? String(text).replace(c.reveal, (a) => c.byAlias.get(a)?.real ?? a) : text;
}

/** Pour l'affichage dans le navigateur (jamais envoyé au modèle). */
export function revealMap() { return Object.fromEntries(load().entities.map((e) => [e.alias, e.real])); }

// ── Fichiers ────────────────────────────────────────────────────────────────
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
    } else if ((kind === 'xlsx' && /^xl\/(sharedStrings|worksheets\/sheet\d+|comments\d*)\.xml$/.test(name)) || /^docProps\/(core|app)\.xml$/.test(name)
      || (kind === 'pptx' && /^ppt\/charts\/chart\d+\.xml$/.test(name)) || (kind === 'docx' && /^word\/charts\/chart\d+\.xml$/.test(name))) {
      // texte des éléments, sans toucher aux balises
      x = x.replace(/>([^<>]+)</g, (m, t) => `>${fn(t)}<`);
      files.set(name, Buffer.from(x));
    }
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
  const outDir = path.join(VAULT_DIR, 'reels', new Date().toISOString().slice(0, 10));
  const dst = path.join(outDir, reveal(path.basename(rel)).replace(/\s+/g, '-'));
  const r = await revealFile(abs, dst);
  if (r.ok && ['docx', 'pptx', 'xlsx'].includes(ext(abs)) && ext(abs) !== 'xlsx') {
    // et son PDF, si c'est un document
    await run('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', outDir, r.dst]).catch(() => {});
  }
  return r;
}

export function listReels() {
  const dir = path.join(VAULT_DIR, 'reels');
  const out = [];
  const walk = (d) => { for (const n of (existsSync(d) ? readdirSync(d) : [])) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else out.push({ name: n, id: path.relative(dir, p), size: statSync(p).size, mtime: statSync(p).mtimeMs }); } };
  walk(dir);
  return out.sort((a, b) => b.mtime - a.mtime);
}
export function reelPath(id) {
  const dir = path.join(VAULT_DIR, 'reels');
  const p = path.resolve(dir, String(id || ''));
  return p.startsWith(dir + path.sep) && existsSync(p) ? p : null;
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
  // 1er passage : apprendre les entités dans les textes (motifs, sociétés, civilités) et les noms de fichiers
  for (const p of files) {
    mask(path.relative(root, p));
    if (TEXT_EXT.has(ext(p)) && statSync(p).size < 2e6) mask(readFileSync(p, 'utf8'));
  }
  for (const p of files) {
    report.fichiers++;
    const r0 = path.relative(root, p);
    const r1 = mask(r0, { learn: false });
    const k = ext(p);
    if (dryRun) { if (r1 !== r0) report.renommes++; continue; }
    const orig = path.join(VAULT_DIR, 'originaux', r0);
    mkdirSync(path.dirname(orig), { recursive: true });
    copyFileSync(p, orig);
    const dst = path.join(root, r1);
    if (TEXT_EXT.has(k) || OFFICE[k] || k === 'pdf') {
      const res = await maskFile(p, dst + '.anon-tmp' + path.extname(dst));
      const finalDst = res.how === 'pdf→texte' ? dst + '.txt' : dst;
      if (p !== finalDst) rmSync(p, { force: true });
      renameSync(res.dst, finalDst);
      report.anonymises++;
      state.files.push({ orig: r0, masked: path.relative(root, finalDst), how: res.how, at: Date.now() });
    } else if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(k)) {
      if (p !== dst) { mkdirSync(path.dirname(dst), { recursive: true }); renameSync(p, dst); report.renommes++; }
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
  if (!dryRun) { prune(base); save(); }
  report.entites_apres = load().entities.length;
  log('INFO', `vault: ${rel} — ${report.fichiers} fichiers, ${report.anonymises} anonymisés${dryRun ? ' (essai)' : ''}`);
  return report;
}

// ── La garde : l'agent n'atteint jamais le coffre ─────────────────────────────
const PARENTS = ['/', '/data', DATA_DIR, path.dirname(VAULT_DIR)].map((p) => p.replace(/\/+$/, '') || '/');
const RECURSIVE = /\b(grep|rg|ag|find|fd|ls\s+-[a-zA-Z]*R|tree|du|tar|zip|rsync|cp\s+-[a-zA-Z]*r|scp|locate)\b/;

export function vaultGuard(input) {
  const tool = input?.tool_name || '';
  const ti = input?.tool_input ?? {};
  const blob = JSON.stringify(ti);
  const deny = (why) => ({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: why } });
  if (blob.includes(VAULT_MARK) || blob.includes(VAULT_DIR)) return deny('Le coffre du mode Confidentiel est inaccessible à l\'agent (données réelles). Travaille sur les fichiers pseudonymisés du workspace.');
  const raw = String(ti.path || ti.file_path || '');
  const target = raw ? (raw.replace(/\/+$/, '') || '/') : null;
  if ((tool === 'Grep' || tool === 'Glob') && target && PARENTS.includes(target)) return deny(`Recherche trop large (${target}) : elle traverserait le coffre du mode Confidentiel. Cible un dossier plus précis.`);
  if (tool === 'Bash' && RECURSIVE.test(ti.command || '') && new RegExp(`(^|[\\s'"=])(${PARENTS.filter((p) => p !== '/').map(esc).join('|')})/?(\\s|$|['"])|(^|\\s)/(\\s|$)`).test(ti.command || '')) {
    return deny('Commande récursive sur un dossier parent du coffre du mode Confidentiel : cible un dossier plus précis.');
  }
  return { continue: true };
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
].join(' ');
