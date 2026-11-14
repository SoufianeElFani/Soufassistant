/*
 * Le dépôt confidentiel — déposer des documents réels sans passer par le Hub.
 *
 * Un dossier hors du workspace, donc hors du Drive (`Depot_confidentiel`, à côté de
 * `Claude_Travail` ; par Samba : \\<HA>\config\Depot_confidentiel). Toutes les 15 s,
 * coffre déverrouillé, chaque fichier stable (10 s sans changement) y est traité
 * comme par Hub › Anonymiser : noms appris (motifs, formes juridiques, civilités),
 * original au coffre, copie pseudonymisée à sa place, nom compris.
 *
 * Puis la même vérification qu'avant l'envoi d'un message : les mots qui ressemblent
 * à des noms et que le coffre ne connaît pas (vault.suspects). Aucun → le fichier
 * part dans <workspace>/Confidentiel, que l'agent lit en mode strict. Sinon il
 * attend dans le dépôt, que l'agent ne lit jamais, jusqu'à la décision de
 * l'utilisateur dans Hub › Confidentiel › Dépôt (protéger / ne plus signaler).
 * Coffre verrouillé : rien n'est traité, les fichiers attendent.
 */
import path from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import * as vault from './vault.js';
import * as lexicon from './lexicon.js';
import { log } from './log.js';

export const depotDir = (root) => process.env.DEPOT_DIR || path.join(path.dirname(root), 'Depot_confidentiel');
const STABLE_MS = Number(process.env.DEPOT_STABLE_MS ?? 10000);
// what Office, Windows and the browsers leave behind while a file is being written
const SKIP = /^(?:\.|~\$|desktop\.ini$|thumbs\.db$)|\.(?:tmp|part|crdownload|anon-tmp)(?:\.|$)/i;
const IMAGES = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

let busy = false;
const checked = new Map();   // rel → { mtime, unknown }
const recent = [];           // the last results, for the Hub: { name, to, how, at }
const note = (r) => { recent.unshift({ ...r, at: Date.now() }); recent.length = Math.min(recent.length, 12); };

function listFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (SKIP.test(n)) continue;
    const p = path.join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) listFiles(p, base, out); else out.push(path.relative(base, p));
  }
  return out;
}

/** Names in a pending file the vault does not know (cached per modification). */
async function unknownIn(dir, rel) {
  const abs = path.join(dir, rel);
  const mtime = statSync(abs).mtimeMs;
  const c = checked.get(rel);
  if (c && c.mtime === mtime) return c.unknown;
  await lexicon.ready();
  const text = await vault.fileText(abs);
  const unknown = text == null
    ? [{ real: '(texte illisible)', kind: 'autre', why: 'le contenu n\'a pas pu être relu' }]
    : vault.suspects(`${rel.replace(/[_/]+/g, ' ')}\n${text}`).unknown;
  checked.set(rel, { mtime, unknown });
  return unknown;
}

/** One dropped file: original to the vault, pseudonymised copy in its place. → pending rel, or null */
async function ingest(dir, rel) {
  const abs = path.join(dir, rel);
  const k = vault.extOf(abs);
  const text = vault.TEXT_EXT.has(k) || vault.OFFICE[k] || vault.LEGACY[k] || k === 'pdf';
  // 1st pass: learn the names (patterns, legal forms, titles) from the file name and its content
  vault.mask(rel);
  if (text) await vault.fileText(abs).then((t) => t && vault.mask(t)).catch(() => {});
  const r1 = vault.mask(rel, { learn: false });
  const buf = readFileSync(abs);
  vault.keepOriginal(`Dépôt/${rel}`, buf);
  const dst = path.join(dir, r1);
  mkdirSync(path.dirname(dst), { recursive: true });
  if (IMAGES.has(k)) {
    // a picture is not read here: renamed, metadata stripped, then checked in the Hub (as after an anonymisation)
    rmSync(abs, { force: true });
    writeFileSync(dst, /^jpe?g$/.test(k) ? vault.stripJpeg(buf) : buf);
    release(dir, r1, { orig: rel, how: 'image (à vérifier)' });
    return null;
  }
  if (text) {
    const res = await vault.maskFile(abs, dst + '.anon-tmp' + path.extname(dst)).catch((e) => ({ ok: false, how: e.message }));
    if (res.ok) {
      const final = res.how === 'pdf→texte' ? dst + '.txt' : vault.withOoxmlExt(dst);
      rmSync(abs, { force: true });
      renameSync(res.dst, final);
      const fr = path.relative(dir, final);
      vault.depotSet(fr, { rel: fr, orig: rel, how: res.how, at: Date.now() });
      return fr;
    }
  }
  // never left in clear: kept in the vault only
  rmSync(abs, { force: true });
  vault.recordFile({ orig: `Dépôt/${rel}`, masked: null, how: 'au coffre seulement' });
  note({ name: r1, to: null, how: text ? 'non pseudonymisable : gardé au coffre seulement' : 'format non pris en charge : gardé au coffre seulement' });
  return null;
}

/** A checked file leaves the drop folder for <workspace>/Confidentiel. */
let rootDir = null;
function release(dir, rel, { orig, how }) {
  const root = rootDir;
  let to = path.join(vault.CONF_DIR, rel);
  for (let i = 2; existsSync(path.join(root, to)); i++) to = path.join(vault.CONF_DIR, rel.replace(/(\.[^./]+)?$/, ` (${i})$1`));
  mkdirSync(path.dirname(path.join(root, to)), { recursive: true });
  renameSync(path.join(dir, rel), path.join(root, to));
  vault.depotSet(rel, null);
  vault.recordFile({ orig: `Dépôt/${orig}`, masked: to, how });
  checked.delete(rel);
  note({ name: rel, to, how });
  log('INFO', `dépôt: ${rel} → ${to}`);
  prune(dir);
}
function prune(d, top = d) {
  for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) prune(p, top); }
  if (d !== top && !readdirSync(d).length) rmSync(d, { recursive: true });
}

/**
 * One pass over the drop folder. → true when something moved (the caller refreshes the views).
 */
export async function tick(root) {
  const dir = depotDir(root);
  rootDir = root;
  try { mkdirSync(dir, { recursive: true }); mkdirSync(path.join(root, vault.CONF_DIR), { recursive: true }); } catch {}
  if (busy || vault.isLocked()) return false;
  busy = true;
  let changed = false;
  try {
    const pending = () => new Map(vault.depotEntries().map((d) => [d.rel, d]));
    for (const d of pending().values()) if (!existsSync(path.join(dir, d.rel))) { vault.depotSet(d.rel, null); changed = true; }
    for (const rel of listFiles(dir)) {
      if (pending().has(rel)) continue;
      if (Date.now() - statSync(path.join(dir, rel)).mtimeMs < STABLE_MS) continue;
      try { await ingest(dir, rel); } catch (e) { log('WARN', `dépôt: ${rel}: ${e.message}`); continue; }
      changed = true;
    }
    for (const d of pending().values()) {
      if (!(await unknownIn(dir, d.rel)).length) { release(dir, d.rel, d); changed = true; }
    }
  } finally { busy = false; }
  return changed;
}

/** For the Hub (browser only, never the model): what waits, and why. */
export async function depotStatus(root) {
  const dir = depotDir(root);
  const locked = vault.isLocked();
  const waiting = locked ? listFiles(dir).length : listFiles(dir).filter((r) => !vault.depotEntries().some((d) => d.rel === r)).length;
  const pending = [];
  if (!locked) for (const d of vault.depotEntries()) if (existsSync(path.join(dir, d.rel))) pending.push({ rel: d.rel, unknown: await unknownIn(dir, d.rel) });
  return { dir, locked, waiting, pending, recent };
}

/**
 * The user's decision on a pending file: `protect` [{ real, kind }] join the vault,
 * `ignore` [words] are no longer flagged; the file is pseudonymised again with them,
 * and leaves when nothing is left. `force` releases it as it is.
 */
export async function resolve(root, rel, { protect = [], ignore = [], force = false } = {}) {
  const dir = depotDir(root);
  rootDir = root;
  const d = vault.depotEntries().find((x) => x.rel === rel);
  if (!d || !existsSync(path.join(dir, rel))) return { ok: false, error: 'Fichier introuvable dans le dépôt.' };
  for (const p of protect) vault.addEntity({ real: p.real, kind: p.kind || 'client' });
  if (ignore.length) vault.addIgnored(ignore);
  let cur = rel;
  if (protect.length) {
    const abs = path.join(dir, rel);
    const r2 = vault.mask(rel, { learn: false });
    const res = await vault.maskFile(abs, path.join(dir, r2) + '.anon-tmp' + path.extname(r2));
    if (!res.ok) return { ok: false, error: res.how };
    rmSync(abs, { force: true });
    mkdirSync(path.dirname(path.join(dir, r2)), { recursive: true });
    renameSync(res.dst, path.join(dir, r2));
    vault.depotSet(rel, { ...d, rel: r2 });
    checked.delete(rel);
    cur = r2;
  }
  if (force || !(await unknownIn(dir, cur)).length) { release(dir, cur, { ...d, rel: cur }); return { ok: true, released: true }; }
  return { ok: true, released: false };
}
