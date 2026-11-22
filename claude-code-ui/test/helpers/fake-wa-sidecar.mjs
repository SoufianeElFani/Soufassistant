/*
 * Stands in for whatsapp-web/sidecar.mjs (the linked-device WhatsApp) in the
 * integration tests: same JSON lines, no WhatsApp. It is "connected" at once,
 * emits each message a test drops into $WA_FAKE_DIR/inbox/*.json, and writes
 * every request it gets to $WA_FAKE_DIR/outbox.jsonl.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const DIR = process.env.WA_FAKE_DIR;
const inbox = path.join(DIR, 'inbox');
mkdirSync(inbox, { recursive: true });
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
out({ ev: 'state', state: 'open', me: '32460000000' });
setInterval(() => {
  for (const f of readdirSync(inbox).sort()) {
    const file = path.join(inbox, f);
    try { out({ ev: 'message', m: JSON.parse(readFileSync(file, 'utf8')) }); } catch {}
    rmSync(file, { force: true });
  }
}, 20);
createInterface({ input: process.stdin }).on('line', (line) => {
  const req = JSON.parse(line);
  appendFileSync(path.join(DIR, 'outbox.jsonl'), `${line}\n`);
  out({ ev: 'reply', id: req.id, ok: true });
  if (req.op === 'logout') { out({ ev: 'state', state: 'loggedOut' }); setTimeout(() => process.exit(0), 50); }
}).on('close', () => process.exit(0));
