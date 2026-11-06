/*
 * Agents — custom assistants, like ChatGPT's GPTs or Claude's Projects
 * instructions: a name, an icon, instructions, and fixed settings a
 * conversation with that agent always uses (mode, model, effort, which skills,
 * deep research). Picked from the composer's ✚ menu; a conversation
 * remembers its agent, so reopening it (or an unattended resume) keeps it.
 *
 * Stored in AGENTS_FILE on the HA box; a first start seeds two examples. The
 * instructions go into the system prompt (agentPrompt); `skills`, when set,
 * is an allow-list — every other skill is switched off for that agent's runs
 * (agentSkillOverrides, keyed by name the same way the Skills panel does).
 */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { writeFileAtomic } from './atomic.js';
import { AGENTS_FILE } from './config.js';
import { log } from './log.js';

export const MAX_AGENTS = 30;
export const MAX_INSTRUCTIONS = 8000;
const MODES = ['', 'chat', 'code', 'cowork'];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_AGENTS = [
  {
    id: 'relecteur-offres', icon: '🔍', name: "Relecteur d'offres",
    description: 'Relit une offre ou un dossier avant envoi : cohérence, prix, champs à compléter, ton.',
    instructions: [
      "Tu relis des offres commerciales et des dossiers avant leur envoi. Pour le document donné :",
      "1) liste ce qui reste à compléter ([crochets], XXX, dates, références) ;",
      "2) vérifie la cohérence des montants entre le texte, les tableaux et le modèle Excel s'il existe ;",
      "3) relève les incohérences (noms, dates, durées, périmètre, exclusions) et les risques contractuels ;",
      "4) propose des corrections de style concrètes (phrase actuelle → phrase proposée), dans la langue du document.",
      "Termine par un verdict : prêt à envoyer / à corriger, avec les 3 points prioritaires. Ne modifie pas le fichier sans qu'on te le demande.",
    ].join('\n'),
    mode: '', model: '', effort: 'high', skills: [], research: false,
  },
  {
    id: 'coach-presentation', icon: '🎤', name: 'Coach présentation',
    description: "Prépare une prise de parole : messages clés, structure, questions difficiles, notes orateur.",
    instructions: [
      "Tu aides à préparer une présentation ou une réunion. Pars de l'objectif et du public.",
      "Donne : le message principal en une phrase, 3 messages clés, une structure minutée, les 5 questions difficiles probables avec une réponse courte,",
      "et, si un deck existe, des notes orateur slide par slide (ce qu'on dit, pas ce qu'on lit). Sois direct et concret.",
    ].join('\n'),
    mode: '', model: '', effort: '', skills: [], research: false,
  },
];

let state = null;   // { agents: [...], sessions: { [sessionId]: agentId } }

function load() {
  if (state) return state;
  state = { agents: DEFAULT_AGENTS.map((a) => ({ ...a })), sessions: {} };
  try {
    if (existsSync(AGENTS_FILE)) {
      const d = JSON.parse(readFileSync(AGENTS_FILE, 'utf8'));
      if (Array.isArray(d.agents)) state.agents = d.agents.filter((a) => a && a.id && a.name).slice(0, MAX_AGENTS);
      if (d.sessions && typeof d.sessions === 'object') state.sessions = d.sessions;
    }
  } catch (e) { log('WARN', `agents not loaded: ${e.message}`); }
  return state;
}
function save() {
  try { writeFileAtomic(AGENTS_FILE, JSON.stringify(state, null, 2)); } catch (e) { log('WARN', `agents not saved: ${e.message}`); }
}

export function reset() { state = null; }
export function listAgents() { return load().agents; }
export function getAgent(id) { return id ? load().agents.find((a) => a.id === id) || null : null; }
export function agentsMessage() { const s = load(); return { type: 'agents', agents: s.agents, sessions: s.sessions }; }

export function agentFor(sessionId) { return sessionId ? getAgent(load().sessions[sessionId]) : null; }
export function setSessionAgent(sessionId, id) {
  if (!sessionId) return false;
  const s = load();
  const next = getAgent(id)?.id || null;
  if ((s.sessions[sessionId] || null) === next) return false;
  if (next) s.sessions[sessionId] = next; else delete s.sessions[sessionId];
  save();
  return true;
}

/** Validate and clean what the form sent. Pure. */
export function cleanAgent(input) {
  const str = (v, n) => String(v ?? '').replace(/\r\n/g, '\n').trim().slice(0, n);
  const a = {
    name: str(input?.name, 80).replace(/\s+/g, ' '),
    icon: [...str(input?.icon, 8)].slice(0, 2).join('') || '🤖',
    description: str(input?.description, 200).replace(/\s+/g, ' '),
    instructions: str(input?.instructions, MAX_INSTRUCTIONS),
    mode: MODES.includes(input?.mode) ? input.mode : '',
    model: str(input?.model, 80),
    effort: EFFORTS.includes(input?.effort) ? input.effort : '',
    skills: Array.isArray(input?.skills) ? [...new Set(input.skills.map((x) => str(x, 80)).filter(Boolean))].slice(0, 40) : [],
    research: !!input?.research,
  };
  if (!a.name) return { error: 'A name is required.' };
  if (!a.instructions) return { error: 'Write the instructions: they are what makes the agent.' };
  return { agent: a };
}

export function saveAgent(input) {
  const s = load();
  const { agent, error } = cleanAgent(input);
  if (error) return { ok: false, error };
  const existing = input?.id ? s.agents.find((x) => x.id === input.id) : null;
  if (existing) Object.assign(existing, agent);
  else {
    if (s.agents.length >= MAX_AGENTS) return { ok: false, error: `You already have ${MAX_AGENTS} agents.` };
    s.agents.push({ id: randomUUID(), ...agent });
  }
  save();
  return { ok: true, id: existing?.id || s.agents[s.agents.length - 1].id };
}

export function deleteAgent(id) {
  const s = load();
  const i = s.agents.findIndex((a) => a.id === id);
  if (i < 0) return { ok: false, error: 'No such agent.' };
  s.agents.splice(i, 1);
  for (const [sid, aid] of Object.entries(s.sessions)) if (aid === id) delete s.sessions[sid];
  save();
  return { ok: true };
}

/** The system-prompt section for an agent ('' for none). Pure. */
export function agentPrompt(agent) {
  if (!agent) return '';
  return [`## You are the agent "${agent.name}"`, agent.description ? `Purpose: ${agent.description}` : '',
    'Follow these instructions for the whole conversation (they come from the user):', agent.instructions]
    .filter(Boolean).join('\n\n');
}

/** skillOverrides switching off every skill outside the agent's allow-list. Pure. */
export function agentSkillOverrides(agent, skills) {
  if (!agent?.skills?.length) return null;
  const allow = new Set(agent.skills);
  const o = {};
  for (const s of skills) if (!allow.has(s.name) && !allow.has(s.invocation)) { o[s.name] = 'off'; if (s.invocation) o[s.invocation] = 'off'; }
  return Object.keys(o).length ? o : null;
}
