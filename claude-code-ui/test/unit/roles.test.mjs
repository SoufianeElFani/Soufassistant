/*
 * Roles (server/lib/roles.js): the prompt section they add, and the list's
 * validation and persistence.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'roles-test-'));

const R = await import('../../server/lib/roles.js');

describe('rolePrompt', () => {
  const roles = [{ id: 'a', name: 'Alpha', context: 'ctx A' }, { id: 'b', name: 'Beta', context: 'ctx B' }];
  test('nothing picked adds nothing', () => {
    assert.equal(R.rolePrompt([], roles), '');
    assert.equal(R.rolePrompt(['zzz'], roles), '');
  });
  test('one role', () => {
    const t = R.rolePrompt(['a'], roles);
    assert.match(t, /^## The user's role for this conversation: Alpha/);
    assert.match(t, /### Alpha\nctx A/);
  });
  test('several roles are combined, in the order picked', () => {
    const t = R.rolePrompt(['b', 'a'], roles);
    assert.match(t, /roles for this conversation: Beta \+ Alpha/);
    assert.ok(t.indexOf('### Beta') < t.indexOf('### Alpha'));
  });
});

describe('the list', () => {
  test('starts with the three defaults, none of them confidential-looking', () => {
    assert.equal(R.listRoles().length, 3);
    for (const r of R.listRoles()) assert.ok(r.context.length > 50 && r.context.length < R.MAX_CONTEXT);
  });
  test('normalizeRoleIds keeps known ids, once each', () => {
    assert.deepEqual(R.normalizeRoleIds(['smart-building-lead', 'x', 'smart-building-lead', 3]), ['smart-building-lead']);
    assert.deepEqual(R.normalizeRoleIds('nope'), []);
  });
  test('saving trims and requires a name and a context', () => {
    assert.equal(R.saveRole({ name: ' ', context: 'x' }).ok, false);
    assert.equal(R.saveRole({ name: 'X', context: '  ' }).ok, false);
    assert.equal(R.saveRole({ name: '  New   role ', context: ' c ' }).ok, true);
    const r = R.listRoles().at(-1);
    assert.equal(r.name, 'New role');
    assert.equal(r.context, 'c');
  });
  test("a conversation's roles are remembered, and dropped with the role", () => {
    const r = R.listRoles().at(-1);
    assert.equal(R.setSessionRoles('s1', [r.id, 'data-governance-pm']), true);
    assert.equal(R.setSessionRoles('s1', [r.id, 'data-governance-pm']), false, 'no change, no write');
    R.copySessionRoles('s1', 's2');
    assert.deepEqual(R.rolesFor('s2'), [r.id, 'data-governance-pm']);
    R.deleteRole(r.id);
    assert.deepEqual(R.rolesFor('s1'), ['data-governance-pm']);
    R.forgetSession('s2');
    assert.deepEqual(R.rolesFor('s2'), []);
  });
  test('persists to roles.json and reloads', () => {
    const file = path.join(process.env.DATA_DIR, 'roles.json');
    const d = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(d.sessions, { s1: ['data-governance-pm'] });
    R.reset();
    assert.deepEqual(R.rolesFor('s1'), ['data-governance-pm']);
    assert.equal(R.listRoles().length, 3);
  });
});
