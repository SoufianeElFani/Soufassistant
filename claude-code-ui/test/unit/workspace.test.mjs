/*
 * The workspace listing (server/lib/workspace.js) — what feeds the Workspace
 * panel and GET /api/workspace.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { listWorkspaceEntries } from '../../server/lib/workspace.js';

function makeTempWorkspace() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'workspace-test-'));
  writeFileSync(path.join(dir, 'report.html'), '<html></html>');
  writeFileSync(path.join(dir, '.hidden'), 'nope');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'data.csv'), 'a,b\n1,2\n');
  mkdirSync(path.join(dir, '.git'));
  writeFileSync(path.join(dir, '.git', 'config'), 'nope');
  return dir;
}

describe('listWorkspaceEntries', () => {
  test('lists files recursively, skipping dotfiles and dot-directories', () => {
    const dir = makeTempWorkspace();
    try {
      const entries = listWorkspaceEntries(dir);
      const paths = entries.map((e) => e.path).sort();
      assert.deepEqual(paths, ['report.html', 'sub/data.csv']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reports extension, size and mtime for each entry', () => {
    const dir = makeTempWorkspace();
    try {
      const entries = listWorkspaceEntries(dir);
      const html = entries.find((e) => e.path === 'report.html');
      assert.equal(html.ext, 'html');
      assert.equal(html.size, '<html></html>'.length);
      assert.equal(typeof html.mtime, 'number');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('returns an empty list for a directory that does not exist', () => {
    assert.deepEqual(listWorkspaceEntries('/does/not/exist'), []);
  });
});
