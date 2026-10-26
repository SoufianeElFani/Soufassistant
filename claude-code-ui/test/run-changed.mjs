#!/usr/bin/env node
/*
 * `npm run test:changed` — the local, fast pre-push check.
 *
 * The full suite takes ~4–8 min on a Home Assistant Green but ~1.5 min on the
 * GitHub runners, and CI already runs all of it on `next` before anything is
 * promoted to `master` (which is all Home Assistant ever sees). So locally we
 * only run the tiers the change can break, chosen from the files changed since
 * origin/master (committed, staged, unstaged and untracked):
 *
 *   always            test/unit                 (~10 s)
 *   server/**         + test/integration
 *   scripts/**        + test/cli                (ha-tools & co. — the slow tier)
 *   frontend/**       + test/browser            only with --browser (or --all): needs
 *                                                Chrome, which is not persistent here,
 *                                                and takes ~3.5 min on the Green against
 *                                                ~1 min in CI; one file at a time (the
 *                                                Green flakes with parallel headless pages)
 *   test/<tier>/**    + that tier;  test/helpers/** + integration, cli, browser
 *   package*.json     everything
 *
 * `--all` runs every tier, `--list` only prints the choice. Exit code is the
 * first failing run's.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.includes('--all');

function git(...args) {
  try { return execFileSync('git', args, { cwd: APP, encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
}
// Best effort: a stale origin/master would count already-released changes.
try {
  execFileSync('git', ['fetch', '-q', 'origin', 'master'], { cwd: APP, stdio: 'ignore', timeout: 20000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
} catch { /* offline: use what we have */ }
const prefix = git('rev-parse', '--show-prefix')[0] || '';
const changed = new Set([
  ...git('diff', '--name-only', 'origin/master...HEAD'),
  ...git('diff', '--name-only', 'HEAD'),
  ...git('ls-files', '--others', '--exclude-standard', '--full-name'),
].map((f) => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f)));

const tiers = new Set(['unit']);
for (const f of changed) {
  if (all || /^package(-lock)?\.json$/.test(f)) { ['integration', 'cli', 'browser'].forEach((t) => tiers.add(t)); continue; }
  if (f.startsWith('server/')) tiers.add('integration');
  if (f.startsWith('scripts/')) tiers.add('cli');
  if (f.startsWith('frontend/')) tiers.add('browser');
  const m = f.match(/^test\/(unit|integration|cli|browser)\//);
  if (m) tiers.add(m[1]);
  if (f.startsWith('test/helpers/')) ['integration', 'cli', 'browser'].forEach((t) => tiers.add(t));
}
if (all) ['integration', 'cli', 'browser'].forEach((t) => tiers.add(t));

const chrome = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
  .filter(Boolean).find((p) => existsSync(p));

console.log(`changed: ${changed.size} file(s) · tiers: ${[...tiers].join(', ')}`);
if (process.argv.includes('--list')) process.exit(0);
const t0 = Date.now();
let status = 0;
// The node tiers share one run, so node --test spreads their files over the
// cores; the browser tier runs after, one file at a time.
const nodeTiers = ['unit', 'integration', 'cli'].filter((t) => tiers.has(t));
const runs = [{ name: nodeTiers.join('+'), dirs: nodeTiers, extra: [] }];
if (tiers.has('browser')) runs.push({ name: 'browser', dirs: ['browser'], extra: ['--test-concurrency=1'] });
for (const { name: t, dirs, extra } of runs) {
  if (t === 'browser' && !(all || process.argv.includes('--browser'))) {
    console.log('browser: left to CI (~1 min there, ~3.5 min here) — add --browser to run it here');
    continue;
  }
  if (t === 'browser' && !chrome) { console.log('browser: skipped — no Chrome (CI runs it)'); continue; }
  const args = ['--test', ...extra, ...dirs.map((d) => `test/${d}/`)];
  const s = Date.now();
  const r = spawnSync(process.execPath, args, {
    cwd: APP, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '', ...(chrome ? { CHROME_PATH: chrome } : {}) },
  });
  const out = r.stdout || '';
  const sum = (k) => (out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1] || '?';
  const fails = out.split('\n').filter((l) => /^\s*not ok /.test(l));
  console.log(`${t}: ${sum('pass')} passed, ${sum('fail')} failed in ${Math.round((Date.now() - s) / 1000)} s`);
  for (const l of fails) console.log(`  ${l.trim()}`);
  if (r.status && !status) status = r.status;
}
console.log(`total ${Math.round((Date.now() - t0) / 1000)} s — the full suite runs in CI on push to next`);
process.exit(status);
