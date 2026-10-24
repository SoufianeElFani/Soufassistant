#!/usr/bin/env node
/*
 * claude-tasks — drives the chat UI's task-list widget from a Bash tool call.
 *
 * It only ever talks to this app's own server, on loopback
 * (http://127.0.0.1:$SERVER_PORT/internal/tasks — see server/lib/internal.js
 * for why loopback is a real boundary here), so running it from any process
 * other than one spawned inside this container's Bash tool has no effect.
 *
 * This is deliberately a plain Node CLI with no dependency on ha-tools's
 * scaffolding (lib/ha-command.cjs etc.) — it has nothing to do with Home
 * Assistant or the WebSocket API ha-tools wraps, and the contract here is
 * small enough not to need it.
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

const HELP = `claude-tasks — the chat UI's task-list widget (not a to-do app; it is for showing your own progress on the CURRENT multi-step request)

Usage:
  claude-tasks get                                 Print the current list as JSON
  claude-tasks set '<json array>'                  Replace the whole list
  claude-tasks update <id> <status> [description]  Add or update one task
  claude-tasks clear                                Empty the list (e.g. once the whole request is done)

<status> is one of: pending | in_progress | completed

Each task is {"id": "...", "description": "...", "status": "..."}. Keep ids
short and stable (e.g. "1", "2", "write-tests") so repeated "update" calls
refer to the same row instead of creating new ones.

Examples:
  claude-tasks set '[{"id":"1","description":"Read the automation file","status":"in_progress"},{"id":"2","description":"Add the new trigger","status":"pending"}]'
  claude-tasks update 1 completed
  claude-tasks update 3 in_progress "Reload automations"
  claude-tasks clear

When to use it: a request with several distinct steps the user would want to
see progress on as you go — not a single quick edit, and not a substitute for
narrating what you are doing in your reply text.`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }

  if (cmd === 'get') {
    const r = await request('GET', '/internal/tasks');
    console.log(JSON.stringify(r.tasks ?? [], null, 2));
    return;
  }

  if (cmd === 'set') {
    const json = rest[0];
    if (!json) throw new Error('usage: claude-tasks set \'<json array>\'');
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { throw new Error(`invalid JSON: ${e.message}`); }
    const r = await request('POST', '/internal/tasks', { tasks: parsed });
    console.log(JSON.stringify(r.tasks, null, 2));
    return;
  }

  if (cmd === 'update') {
    const [id, status, ...descParts] = rest;
    if (!id || !status) throw new Error('usage: claude-tasks update <id> <status> [description]');
    const description = descParts.length ? descParts.join(' ') : undefined;
    const r = await request('POST', '/internal/tasks', { action: 'update', id, status, description });
    console.log(JSON.stringify(r.tasks, null, 2));
    return;
  }

  if (cmd === 'clear') {
    await request('POST', '/internal/tasks', { action: 'clear' });
    console.log('[]');
    return;
  }

  throw new Error(`unknown command "${cmd}" — try "claude-tasks --help"`);
}

main().catch((e) => { console.error(`claude-tasks: ${e.message}`); process.exit(1); });
