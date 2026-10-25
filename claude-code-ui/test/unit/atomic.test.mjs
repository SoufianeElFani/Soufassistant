/*
 * writeFileAtomic (server/lib/atomic.js): a reader never sees a partial file,
 * and no temporary file is left behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { writeFileAtomic } from '../../server/lib/atomic.js';

test('replaces the file in one step and leaves no temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'state.json');
  writeFileAtomic(f, JSON.stringify({ n: 1 }));
  const big = JSON.stringify({ n: 2, pad: 'x'.repeat(1 << 20) });
  writeFileAtomic(f, big);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).n, 2);
  assert.deepEqual(readdirSync(dir), ['state.json']);
});

test('a failed write leaves the previous content and no temp file', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'atomic-'));
  const f = path.join(dir, 'state.json');
  writeFileAtomic(f, '{"ok":true}');
  assert.throws(() => writeFileAtomic(path.join(dir, 'missing-dir', 'x.json'), '{}'));
  assert.equal(readFileSync(f, 'utf8'), '{"ok":true}');
  assert.deepEqual(readdirSync(dir), ['state.json']);
});
