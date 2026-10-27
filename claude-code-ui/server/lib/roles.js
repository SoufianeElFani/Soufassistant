/*
 * Roles — the hats the user writes a prompt in. Each role is a short context
 * (who they are in that role, the scope, who they deal with, the tone, the
 * usual deliverables) added to the system prompt of a turn when it is picked
 * in the composer. Several can be picked at once; their contexts are combined.
 *
 * Which roles a conversation uses is remembered with it, so reopening it
 * restores the picker and an unattended resume (auto-continue) keeps them.
 * The list is the user's own, managed from the Roles panel; a first start
 * seeds it with the three roles below. Stored on the HA box (and nowhere
 * else), so the defaults stay generic — nothing confidential belongs here.
 */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { writeFileAtomic } from './atomic.js';
import { ROLES_FILE } from './config.js';
import { log } from './log.js';

export const MAX_ROLES = 20;
export const MAX_CONTEXT = 3000;

export const DEFAULT_ROLES = [
  {
    id: 'digital-solutions-pm',
    name: 'Chef de projet — Digital Solutions',
    short: 'Digital Solutions',
    context: [
      "Je travaille comme chef de projet Digital Solutions chez Equans (Belgique) : projets de solutions",
      "numériques pour les bâtiments et l'énergie (supervision, GTB/BMS, IoT, plateformes de données, tableaux de bord énergie).",
      "Interlocuteurs : clients (facility managers, directions techniques), équipes internes (techniciens, intégrateurs, IT), sous-traitants.",
      "Ton : clair, structuré, orienté résultats, délais et budget.",
      "Livrables types : planning, compte rendu de réunion, suivi des risques et des actions, estimation/offre, bilan de projet, présentation client.",
    ].join(' '),
  },
  {
    id: 'smart-building-lead',
    name: 'Smart Building Development Team Leader',
    short: 'Smart Building',
    context: [
      "Je dirige l'équipe de développement Smart Building : développement de l'offre bâtiment intelligent",
      "(capteurs, GTB, intégration des systèmes, plateformes, services à valeur ajoutée) et accompagnement de l'équipe.",
      "Interlocuteurs : mon équipe, la direction, les commerciaux et l'avant-vente, les partenaires technologiques.",
      "Ton : leadership bienveillant, vision, priorisation, pédagogie.",
      "Livrables types : feuille de route, standards et bonnes pratiques, plan de montée en compétences, support d'avant-vente, réunion d'équipe, feedback individuel.",
    ].join(' '),
  },
  {
    id: 'data-governance-pm',
    name: 'Data Governance Program Manager',
    short: 'Data Governance',
    context: [
      "Je pilote le programme de gouvernance des données : rôles (data owners, data stewards),",
      "politiques et standards, qualité des données, catalogue et glossaire, conformité (RGPD), indicateurs.",
      "Interlocuteurs : métiers, IT, sécurité, juridique/DPO, direction, comités de gouvernance.",
      "Ton : rigoureux, fédérateur, orienté valeur métier et conduite du changement.",
      "Livrables types : charte et politiques, RACI, feuille de route du programme, tableau de bord qualité, support de comité, plan de communication.",
    ].join(' '),
  },
];

let state = null;   // { roles: [...], sessions: { [sessionId]: [roleId, …] } }

function load() {
  if (state) return state;
  state = { roles: DEFAULT_ROLES.map((r) => ({ ...r })), sessions: {} };
  try {
    if (existsSync(ROLES_FILE)) {
      const d = JSON.parse(readFileSync(ROLES_FILE, 'utf8'));
      if (Array.isArray(d.roles)) state.roles = d.roles.filter(isValidRole).slice(0, MAX_ROLES);
      if (d.sessions && typeof d.sessions === 'object' && !Array.isArray(d.sessions)) state.sessions = d.sessions;
    }
  } catch (e) { console.warn('Could not load roles:', e.message); }
  return state;
}

function save() {
  try { writeFileAtomic(ROLES_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { console.warn('Could not save roles:', e.message); }
}

function isValidRole(r) {
  return !!r && typeof r.id === 'string' && r.id && typeof r.name === 'string' && r.name.trim() &&
    typeof r.context === 'string';
}

/** Forget what was loaded (tests point DATA_DIR somewhere new). */
export function reset() { state = null; }

export function listRoles() { return load().roles; }

/** The wire message every tab keeps: the roles and each conversation's picks. */
export function rolesMessage() {
  const s = load();
  return { type: 'roles', roles: s.roles, sessions: s.sessions };
}

/** Role ids as sent by a client: strings naming an existing role, each once. */
export function normalizeRoleIds(ids) {
  if (!Array.isArray(ids)) return [];
  const known = new Set(load().roles.map((r) => r.id));
  return [...new Set(ids.filter((x) => typeof x === 'string' && known.has(x)))];
}

export function rolesFor(sessionId) {
  if (!sessionId) return [];
  return normalizeRoleIds(load().sessions[sessionId] || []);
}

/** Remember a conversation's roles. Returns whether anything changed. */
export function setSessionRoles(sessionId, ids) {
  if (!sessionId) return false;
  const s = load();
  const next = normalizeRoleIds(ids);
  const prev = s.sessions[sessionId] || [];
  if (prev.length === next.length && prev.every((x, i) => x === next[i])) return false;
  if (next.length) s.sessions[sessionId] = next;
  else delete s.sessions[sessionId];
  save();
  return true;
}

export function forgetSession(sessionId) {
  const s = load();
  if (!s.sessions[sessionId]) return;
  delete s.sessions[sessionId];
  save();
}

export function copySessionRoles(from, to) {
  const ids = rolesFor(from);
  if (ids.length) setSessionRoles(to, ids);
}

/** Create (no id) or update one role. */
export function saveRole(input) {
  const s = load();
  const name = String(input?.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const short = String(input?.short || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  const context = String(input?.context || '').trim().slice(0, MAX_CONTEXT);
  if (!name) return { ok: false, error: 'A name is required.' };
  if (!context) return { ok: false, error: 'Describe the role: it is what Claude is told.' };
  const existing = input?.id ? s.roles.find((r) => r.id === input.id) : null;
  if (existing) {
    Object.assign(existing, { name, short, context });
  } else {
    if (s.roles.length >= MAX_ROLES) return { ok: false, error: `You already have ${MAX_ROLES} roles — remove one first.` };
    s.roles.push({ id: randomUUID(), name, short, context });
  }
  save();
  log('INFO', `roles: ${existing ? 'updated' : 'added'} "${name}"`);
  return { ok: true };
}

export function deleteRole(id) {
  const s = load();
  const i = s.roles.findIndex((r) => r.id === id);
  if (i < 0) return { ok: false, error: 'No such role.' };
  s.roles.splice(i, 1);
  for (const [sid, ids] of Object.entries(s.sessions)) {
    const left = ids.filter((x) => x !== id);
    if (left.length) s.sessions[sid] = left; else delete s.sessions[sid];
  }
  save();
  return { ok: true };
}

/** The system-prompt section for the picked roles ('' for none). Pure given the list. */
export function rolePrompt(ids, roles = listRoles()) {
  const picked = (ids || []).map((id) => roles.find((r) => r.id === id)).filter(Boolean);
  if (!picked.length) return '';
  const names = picked.map((r) => r.name).join(' + ');
  return [
    `## The user's role${picked.length > 1 ? 's' : ''} for this conversation: ${names}`,
    picked.length > 1
      ? 'The user is writing wearing these hats at once. Use their contexts together to frame your answers (vocabulary, priorities, audience, deliverables), without mentioning them unless it helps.'
      : 'The user is writing in this role. Use its context to frame your answers (vocabulary, priorities, audience, deliverables), without mentioning it unless it helps.',
    ...picked.map((r) => `### ${r.name}\n${r.context}`),
  ].join('\n\n');
}
