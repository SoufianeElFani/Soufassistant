/*
 * The configurable workspace (server/lib/workspace.js): root validation,
 * project names, path containment and the sync-log summary.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateRoot, sanitizeProjectName, resolveInWorkspace, parseSyncLog, countConflicts } from '../../server/lib/workspace.js';

describe('validateRoot', () => {
  test('accepts folders under the allowed mounts', () => {
    assert.deepEqual(validateRoot('/config/Claude_Travail'), { ok: true, root: '/config/Claude_Travail' });
    assert.ok(validateRoot('/share/docs/').ok);
  });
  test('refuses relative paths, the mounts themselves, other places and internals', () => {
    for (const p of ['config/x', '/config', '/config/', '/etc/x', '/', '/config/.storage', '/config/.storage/x', '/data/secrets/x', '']) {
      assert.equal(validateRoot(p).ok, false, p);
    }
  });
});

test('sanitizeProjectName', () => {
  assert.equal(sanitizeProjectName(' My  App '), 'My App');
  assert.equal(sanitizeProjectName('a/b'), 'a-b');
  assert.equal(sanitizeProjectName('.hidden'), null);
  assert.equal(sanitizeProjectName('..'), null);
  assert.equal(sanitizeProjectName(''), null);
});

test('resolveInWorkspace keeps paths inside the root', () => {
  assert.equal(resolveInWorkspace('a/b.html', '/w'), '/w/a/b.html');
  assert.equal(resolveInWorkspace('../../etc/passwd', '/w'), '/w/etc/passwd');
  assert.equal(resolveInWorkspace('', '/w'), '/w');
});

describe('parseSyncLog', () => {
  test('an error after the last success is reported', () => {
    const r = parseSyncLog('2026/10/25 09:00:00 NOTICE: Bisync successful\n2026/10/25 09:05:00 ERROR : Safety abort: too many deletes\n');
    assert.ok(r.lastOk && r.lastError > r.lastOk);
    assert.match(r.lastErrorText, /too many deletes/);
  });
  test('a success after an error clears it', () => {
    const r = parseSyncLog('2026/10/25 09:05:00 ERROR : boom\n2026/10/25 09:06:00 NOTICE: Bisync successful\n');
    assert.equal(r.lastError, null);
    assert.ok(r.lastOk);
  });
});

test('countConflicts', () => {
  assert.equal(countConflicts([{ name: 'a.pptx' }, { name: 'a.pptx.conflict1' }, { name: 'b.conflict2.md' }]), 2);
});
