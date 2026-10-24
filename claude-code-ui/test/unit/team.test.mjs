/*
 * Team-panel state and validation (server/lib/team.js) — written to by the
 * panel itself (upsert/remove) and by the team-notes CLI (addNote) via
 * POST /internal/team.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR is read once at config.js's first import, same reasoning as
// tasks.test.mjs — point it at a scratch directory before team.js (or
// anything importing it) loads.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'team-test-'));

const { teamState, upsert, remove, addNote, MAX_MEMBERS } = await import('../../server/lib/team.js');

describe('upsert', () => {
  test('creates a new member', () => {
    const m = upsert({ name: 'Jamie Ortiz', role: 'Developer' });
    assert.equal(m.name, 'Jamie Ortiz');
    assert.equal(m.role, 'Developer');
    assert.equal(m.lastOneOnOne, null);
    assert.equal(teamState.members.length, 1);
  });

  test('rejects a missing name', () => {
    assert.throws(() => upsert({ role: 'x' }), /name is required/);
  });

  test('updates an existing member by id', () => {
    const created = upsert({ name: 'Alex' });
    const updated = upsert({ id: created.id, name: 'Alex Updated', role: 'Lead' });
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, 'Alex Updated');
    assert.equal(updated.role, 'Lead');
  });

  test('touchOneOnOne stamps the current time', () => {
    const before = Date.now();
    const m = upsert({ name: 'Touch Test', touchOneOnOne: true });
    assert.ok(m.lastOneOnOne >= before);
  });

  test('caps the list at MAX_MEMBERS', () => {
    teamState.members = [];
    for (let i = 0; i < MAX_MEMBERS; i++) upsert({ name: `m${i}` });
    assert.throws(() => upsert({ name: 'one too many' }), /already have/);
  });
});

describe('remove', () => {
  test('removes a member by id', () => {
    teamState.members = [];
    const m = upsert({ name: 'To Remove' });
    remove(m.id);
    assert.equal(teamState.members.length, 0);
  });

  test('is a no-op for an unknown id', () => {
    teamState.members = [];
    upsert({ name: 'Keep Me' });
    remove('ghost-id');
    assert.equal(teamState.members.length, 1);
  });
});

describe('addNote', () => {
  test('creates a member by name if none matches, and appends a dated line', () => {
    teamState.members = [];
    const m = addNote('Bernard', '1:1: roadmap pricing still undecided');
    assert.equal(m.name, 'Bernard');
    assert.match(m.notes, /^\[\d{4}-\d{2}-\d{2}\] 1:1: roadmap pricing still undecided$/);
  });

  test('matches an existing member case-insensitively and appends', () => {
    teamState.members = [];
    upsert({ name: 'Bernard', notes: 'existing note' });
    const m = addNote('bernard', 'second note');
    assert.equal(teamState.members.length, 1);
    assert.match(m.notes, /^existing note\n\[\d{4}-\d{2}-\d{2}\] second note$/);
  });

  test('touchOneOnOne stamps the current time', () => {
    teamState.members = [];
    const before = Date.now();
    const m = addNote('New Person', 'had a 1:1', { touchOneOnOne: true });
    assert.ok(m.lastOneOnOne >= before);
  });

  test('rejects an empty name', () => {
    assert.throws(() => addNote('', 'x'), /name or id is required/);
  });
});
