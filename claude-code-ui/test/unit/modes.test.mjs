/*
 * Chat / Code / Cowork (server/lib/modes.js): the SDK options each mode adds,
 * and Cowork's write fence.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { modeOptions, normalizeMode, coworkWriteGuard, isInside, CHAT_TOOLS } from '../../server/lib/modes.js';

describe('modeOptions', () => {
  test('code adds nothing but the workspace note', () => {
    const m = modeOptions('code', { root: '/config/W' });
    assert.deepEqual(m.opts, {});
    assert.match(m.append, /\/config\/W/);
    assert.equal(m.coworkDir, null);
  });

  test('chat strips tools, plugins and setting sources, and replaces the system prompt', () => {
    const m = modeOptions('chat', { root: '/config/W' });
    assert.deepEqual(m.opts.tools, CHAT_TOOLS);
    assert.deepEqual(m.opts.plugins, []);
    assert.deepEqual(m.opts.settingSources, []);
    assert.equal(typeof m.systemPrompt, 'string');
    assert.match(m.systemPrompt, /Chat mode/);
  });

  test('cowork needs a project folder', () => {
    assert.match(modeOptions('cowork', { root: '/w' }).error, /project/i);
    const m = modeOptions('cowork', { root: '/w', project: 'App', projectDir: '/w/App' });
    assert.deepEqual(m.opts.additionalDirectories, ['/w/App']);
    assert.equal(m.coworkDir, '/w/App');
    assert.match(m.append, /Cowork mode/);
    assert.match(m.append, /\/w\/App/);
  });

  test('unknown modes fall back to code', () => {
    assert.equal(normalizeMode('nope'), 'code');
    assert.equal(normalizeMode(undefined), 'code');
  });
});

describe('isInside', () => {
  test('the folder itself and its children, not siblings with a shared prefix', () => {
    assert.ok(isInside('/w/App', '/w/App'));
    assert.ok(isInside('/w/App/a/b.txt', '/w/App'));
    assert.ok(!isInside('/w/AppOld/x', '/w/App'));
    assert.ok(!isInside('/w/App/../x', '/w/App'));
  });
});

describe('coworkWriteGuard', () => {
  const guard = coworkWriteGuard('/w/App', '/config');
  const call = (tool, input) => guard({ tool_name: tool, tool_input: input });

  test('allows writes inside the project and /tmp', async () => {
    assert.deepEqual(await call('Write', { file_path: '/w/App/index.html' }), { continue: true });
    assert.deepEqual(await call('Edit', { file_path: '/tmp/scratch.txt' }), { continue: true });
  });

  test('denies writes elsewhere, including relative paths (they resolve against /config)', async () => {
    for (const input of [{ file_path: '/config/configuration.yaml' }, { file_path: 'notes.md' }, { file_path: '/w/App/../escape.txt' }]) {
      const r = await call('Write', input);
      assert.equal(r.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(input));
    }
  });

  test('leaves reads and non-file tools alone', async () => {
    assert.deepEqual(await call('Read', { file_path: '/config/secrets.yaml' }), { continue: true });
    assert.deepEqual(await call('Bash', { command: 'ls /' }), { continue: true });
  });
});
