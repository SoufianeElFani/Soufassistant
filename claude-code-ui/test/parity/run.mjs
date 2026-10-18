/*
 * Launcher for the ha-ws-client parity harness (npm run test:parity).
 *
 * The old binary hard-codes ws://supervisor/core/api/websocket, so to run it
 * against a fake Home Assistant we make `supervisor` resolve to 127.0.0.1:80 —
 * inside a throwaway user+mount+network namespace, which needs no root:
 *
 *     unshare -rmn   (map us to root *inside*, private /etc/hosts, own loopback)
 *
 * The pinned release binary is downloaded once into its own directory and checked
 * against a recorded sha256; OLD_BIN points at one you already have.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION_TAG = 'v1.8.1';
const SHA256 = 'c23ecc911368d273554b5945df5a4bb035847254d2520d584927d74d3218d578';   // linux-amd64
const URL_ = `https://github.com/schoolboyqueue/home-assistant-blueprints/releases/download/${VERSION_TAG}/ha-ws-client-linux-amd64`;

async function oldBinary() {
  if (process.env.OLD_BIN) return process.env.OLD_BIN;
  if (process.arch !== 'x64') {
    console.error('parity: the pinned binary is linux-amd64; set OLD_BIN to one that runs here');
    process.exit(2);
  }
  const dir = path.join(tmpdir(), 'ha-ws-client-parity');
  const file = path.join(dir, `ha-ws-client-${VERSION_TAG}`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (existsSync(file) && sha(readFileSync(file)) === SHA256) return file;
  mkdirSync(dir, { recursive: true });
  console.error(`parity: downloading ${URL_}`);
  const res = await fetch(URL_);
  if (!res.ok) { console.error(`parity: download failed: HTTP ${res.status}`); process.exit(2); }
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== SHA256) { console.error(`parity: sha256 mismatch (got ${sha(buf)}) — refusing to run it`); process.exit(2); }
  writeFileSync(file, buf);
  chmodSync(file, 0o755);
  return file;
}

const bin = await oldBinary();
const scratch = mkdtempSync(path.join(tmpdir(), 'parity-hosts-'));
const hosts = path.join(scratch, 'hosts');
writeFileSync(hosts, '127.0.0.1 localhost supervisor\n');

const inner = `ip link set lo up && mount --bind '${hosts}' /etc/hosts && exec "$@"`;
const r = spawnSync('unshare', ['-rmn', 'sh', '-c', inner, 'sh',
  process.execPath, '--test', ...process.argv.slice(2), path.join(HERE, 'ws-client-parity.test.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, PARITY_INNER: '1', OLD_BIN: bin, NODE_PATH: '' },
});
if (r.error) { console.error(`parity: could not enter a namespace: ${r.error.message}`); process.exit(2); }
process.exit(r.status ?? 1);
