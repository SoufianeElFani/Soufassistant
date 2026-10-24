/*
 * Task-list state and validation (server/lib/tasks.js) — the state the
 * claude-tasks CLI drives via POST /internal/tasks.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';

// DATA_DIR is read once at config.js's first import, so point it at a scratch
// directory before anything imports tasks.js (directly or transitively) —
// avoids writing into a real /data that does not exist in this environment.
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));

const { taskState, setTasks, updateTask, clearTasks, MAX_TASKS } = await import('../../server/lib/tasks.js');

describe('setTasks', () => {
  test('keeps valid tasks and drops malformed ones', () => {
    const result = setTasks([
      { id: '1', description: 'Read the file', status: 'in_progress' },
      { id: '', description: 'no id', status: 'pending' },          // dropped — empty id
      { id: '2', description: '', status: 'pending' },              // dropped — empty description
      { id: '3', description: 'bad status', status: 'nope' },        // status coerced to pending
    ]);
    assert.deepEqual(result, [
      { id: '1', description: 'Read the file', status: 'in_progress' },
      { id: '3', description: 'bad status', status: 'pending' },
    ]);
  });

  test('de-duplicates by id, keeping the last occurrence', () => {
    const result = setTasks([
      { id: '1', description: 'first', status: 'pending' },
      { id: '1', description: 'second', status: 'completed' },
    ]);
    assert.deepEqual(result, [{ id: '1', description: 'second', status: 'completed' }]);
  });

  test('caps the list at MAX_TASKS', () => {
    const many = Array.from({ length: MAX_TASKS + 10 }, (_, i) => ({ id: String(i), description: `t${i}`, status: 'pending' }));
    const result = setTasks(many);
    assert.equal(result.length, MAX_TASKS);
  });

  test('rejects a non-array', () => {
    assert.throws(() => setTasks('nope'), /array/);
  });
});

describe('updateTask', () => {
  test('updates an existing task in place', () => {
    setTasks([{ id: '1', description: 'Do the thing', status: 'pending' }]);
    const result = updateTask('1', 'completed');
    assert.deepEqual(result, [{ id: '1', description: 'Do the thing', status: 'completed' }]);
  });

  test('creates a new task when the id is unknown and a description is given', () => {
    setTasks([]);
    const result = updateTask('new-id', 'in_progress', 'Brand new task');
    assert.deepEqual(result, [{ id: 'new-id', description: 'Brand new task', status: 'in_progress' }]);
  });

  test('refuses an unknown id with no description to create it from', () => {
    setTasks([]);
    assert.throws(() => updateTask('ghost', 'completed'), /unknown task id/);
  });

  test('refuses an invalid status', () => {
    setTasks([{ id: '1', description: 'x', status: 'pending' }]);
    assert.throws(() => updateTask('1', 'done'), /status must be one of/);
  });
});

test('clearTasks empties the list', () => {
  setTasks([{ id: '1', description: 'x', status: 'pending' }]);
  clearTasks();
  assert.deepEqual(taskState.tasks, []);
});
