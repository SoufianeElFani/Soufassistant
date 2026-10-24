/*
 * The Team panel — a local, self-hosted 1:1 / team-roster tracker for a
 * project or team lead. One member per card: name, role, free-text notes,
 * and the date of their last 1:1. Nothing here is Home-Assistant-specific;
 * it is a small persisted list in the same spirit as tasks.js and
 * scheduler.js (own module, own file, broadcast to every tab).
 *
 * Unlike the task list (claude-tasks, driven only by Claude for the CURRENT
 * request) this is meant to accumulate over weeks, and both sides can write
 * to it: a person edits it directly from the panel, and Claude can log a
 * note after being told about a conversation ("I had a 1:1 with X today, she
 * mentioned Y") via the team-notes CLI, exactly the way claude-tasks reaches
 * tasks.js. Both paths converge on the same upsert()/remove() here, so
 * there is one source of truth and one broadcast.
 */
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { TEAM_FILE } from './config.js';
import { log } from './log.js';
import { broadcast } from './broadcast.js';

export const MAX_MEMBERS = 30;
export const teamState = { members: [] };

export function load() {
  try {
    if (existsSync(TEAM_FILE)) {
      const d = JSON.parse(readFileSync(TEAM_FILE, 'utf8'));
      if (Array.isArray(d.members)) teamState.members = d.members.filter(isValidMember);
    }
  } catch (e) { console.warn('Could not load team members:', e.message); }
}

function save() {
  try { writeFileSync(TEAM_FILE, JSON.stringify(teamState)); }
  catch (e) { console.warn('Could not save team members:', e.message); }
}

function isValidMember(m) {
  return !!m && typeof m.id === 'string' && m.id.length > 0 &&
    typeof m.name === 'string' && m.name.length > 0;
}

function broadcastTeam() {
  broadcast({ type: 'team_members', members: teamState.members });
}

export function list() { return teamState.members; }

/** Create or update one member. Matches by id when given; otherwise matches
 *  an existing member by exact (case-insensitive) name, so "log a note about
 *  Bernard" updates the same card rather than creating a duplicate. */
export function upsert(input) {
  const name = String(input?.name || '').trim().slice(0, 80);
  const role = String(input?.role || '').trim().slice(0, 120);
  const notes = String(input?.notes || '').trim().slice(0, 4000);
  if (!name) throw new Error('A name is required.');

  let existing = null;
  if (input?.id) existing = teamState.members.find((m) => m.id === input.id);
  if (!existing && input?.matchByName) {
    existing = teamState.members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  }

  if (existing) {
    existing.name = name;
    existing.role = role;
    if (input?.notes !== undefined) existing.notes = notes;
    if (input?.touchOneOnOne) existing.lastOneOnOne = Date.now();
    save();
    broadcastTeam();
    return existing;
  }

  if (teamState.members.length >= MAX_MEMBERS) {
    throw new Error(`You already have ${MAX_MEMBERS} team members — remove one first.`);
  }
  const member = {
    id: randomUUID(), name, role, notes,
    lastOneOnOne: input?.touchOneOnOne ? Date.now() : null,
    createdAt: Date.now(),
  };
  teamState.members.push(member);
  save();
  broadcastTeam();
  log('INFO', `team: added "${name}"`);
  return member;
}

export function remove(id) {
  const before = teamState.members.length;
  teamState.members = teamState.members.filter((m) => m.id !== id);
  if (teamState.members.length !== before) { save(); broadcastTeam(); }
}

/** Append a dated note to an existing member's notes (keeps prior notes),
 *  and optionally marks a 1:1 as having just happened. Used by the
 *  team-notes CLI so Claude can log something without overwriting what
 *  the user wrote themselves in the panel. */
export function addNote(nameOrId, note, { touchOneOnOne = false } = {}) {
  const key = String(nameOrId || '').trim();
  if (!key) throw new Error('A name or id is required.');
  let member = teamState.members.find((m) => m.id === key) ||
    teamState.members.find((m) => m.name.toLowerCase() === key.toLowerCase());
  if (!member) {
    if (teamState.members.length >= MAX_MEMBERS) {
      throw new Error(`You already have ${MAX_MEMBERS} team members — remove one first.`);
    }
    member = { id: randomUUID(), name: key.slice(0, 80), role: '', notes: '', lastOneOnOne: null, createdAt: Date.now() };
    teamState.members.push(member);
  }
  const cleanNote = String(note || '').trim().slice(0, 1000);
  if (cleanNote) {
    const stamp = new Date().toISOString().slice(0, 10);
    const line = `[${stamp}] ${cleanNote}`;
    member.notes = (member.notes ? `${member.notes}\n${line}` : line).slice(-4000);
  }
  if (touchOneOnOne) member.lastOneOnOne = Date.now();
  save();
  broadcastTeam();
  log('INFO', `team: note added for "${member.name}"`);
  return member;
}
