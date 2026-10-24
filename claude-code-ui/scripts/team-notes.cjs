#!/usr/bin/env node
/*
 * team-notes — logs a dated note on a team member in the Team panel, from a
 * Bash tool call (so it goes through the ordinary permission system).
 *
 * Same shape as claude-tasks.cjs: a plain Node CLI with no dependency on
 * ha-tools's scaffolding, talking only to this app's own loopback endpoint
 * (http://127.0.0.1:$SERVER_PORT/internal/team — see server/lib/internal.js
 * for why loopback is a real boundary here).
 *
 * This is for LOGGING what you're told about a 1:1 or team conversation — it
 * is not a substitute for the panel itself, which is where names, roles and
 * notes are edited directly by the person using this app.
 */
const http = require('http');

const PORT = process.env.SERVER_PORT || '7681';
const HOST = '127.0.0.1';

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: HOST, port: PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(chunks || '{}'); } catch { parsed = { raw: chunks }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const HELP = `team-notes — log a dated note on a Team-panel member (not a to-do list; see claude-tasks for that)

Usage:
  team-notes list                                    Print the current team list as JSON
  team-notes note <name> <text...>                   Append a dated note to this member (creates them if new)
  team-notes note <name> --1on1 <text...>             ...and mark today as their last 1:1

<name> matches an existing member case-insensitively, or creates a new one if
none matches. Keep notes short and factual — this is a log, not a transcript;
never record anything the user did not actually say, and never anything a
person would consider confidential or sensitive about themselves or others
beyond what is needed to be useful (no health, HR, or disciplinary detail).

Examples:
  team-notes note Bernard "1:1: roadmap pricing still undecided, follow up next week"
  team-notes note "Erkan" --1on1 "Discussed dev budget constraints, he'll scope a small POC"
  team-notes list

When to use it: the user tells you about a 1:1 or team conversation and asks
you to note it, or something clearly worth remembering comes up about someone
on their team while chatting. Not for routine chit-chat, and never on your own
initiative without the user having actually told you something to log.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  if (cmd === 'list') {
    const r = await request('GET', '/internal/team');
    console.log(JSON.stringify(r.members ?? [], null, 2));
    return;
  }

  if (cmd === 'note') {
    let [name, ...noteParts] = rest;
    if (!name) throw new Error('usage: team-notes note <name> [--1on1] <text...>');
    let touchOneOnOne = false;
    if (noteParts[0] === '--1on1') { touchOneOnOne = true; noteParts = noteParts.slice(1); }
    const note = noteParts.join(' ');
    if (!note) throw new Error('usage: team-notes note <name> [--1on1] <text...>');
    const r = await request('POST', '/internal/team', { action: 'note', member: name, note, touchOneOnOne });
    console.log(JSON.stringify(r.members, null, 2));
    return;
  }

  throw new Error(`unknown command "${cmd}" — try "team-notes --help"`);
}

main().catch((e) => { console.error(`team-notes: ${e.message}`); process.exit(1); });
