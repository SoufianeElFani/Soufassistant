/*
 * Conversation tools (server/lib/session-tools.js) and live previews
 * (server/lib/previews.js): the pure parts.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const { turnsFromLines, humanPromptText, sessionToMarkdown } = await import('../../server/lib/session-tools.js');
const { parseProcNetTcp, inPreviewRange } = await import('../../server/lib/previews.js');

const user = (text, uuid, extra = {}) => ({ type: 'user', uuid, timestamp: '2026-10-25T10:00:00Z', message: { content: text }, ...extra });
const asst = (blocks) => ({ type: 'assistant', message: { content: blocks } });

describe('turnsFromLines', () => {
  test('one turn per typed prompt, with the file-tool changes made while answering it', () => {
    const turns = turnsFromLines([
      user('first', 'u1'),
      asst([{ type: 'tool_use', name: 'Write', input: { file_path: '/w/a.html', content: '<h1>x</h1>' } }]),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
      asst([{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/a.html', old_string: 'x', new_string: 'y' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
      user('second', 'u2'),
      asst([{ type: 'text', text: 'nothing to change' }]),
    ]);
    assert.deepEqual(turns.map((t) => [t.uuid, t.text, t.changes.length]), [['u1', 'first', 2], ['u2', 'second', 0]]);
    assert.equal(turns[0].changes[0].content, '<h1>x</h1>');
    assert.deepEqual(turns[0].changes[1].edits, [{ old: 'x', new: 'y' }]);
  });

  test('tool results, meta lines and harness messages are not turns', () => {
    assert.equal(humanPromptText({ type: 'user', isMeta: true, message: { content: 'x' } }), null);
    assert.equal(humanPromptText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }), null);
    assert.equal(humanPromptText({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } }), null);
    assert.equal(humanPromptText(user('hello', 'u')), 'hello');
  });
});

test('sessionToMarkdown renders prompts, replies and tool calls', () => {
  const md = sessionToMarkdown('Bilan', [
    { kind: 'user', text: 'Fais le bilan' },
    { kind: 'tool_use', name: 'Write', input: { file_path: '/w/b.md' } },
    { kind: 'text', text: 'Voilà.' },
  ]);
  assert.match(md, /^# Bilan/);
  assert.match(md, /## 🧑 Vous\n\nFais le bilan/);
  assert.match(md, /> 🔧 `Write` — `\/w\/b\.md`/);
  assert.match(md, /## 🤖 Claude\n\nVoilà\./);
});

describe('previews', () => {
  test('parseProcNetTcp keeps LISTEN sockets only', () => {
    const t = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1FA4 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11111 1',
      '   1: 0100007F:1FA5 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 22222 1',
      '   2: 00000000:1E61 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 33333 1',
    ].join('\n');
    assert.deepEqual(parseProcNetTcp(t), [{ port: 8100, inode: '11111' }, { port: 7777, inode: '33333' }]);
  });
  test('only the preview port range is proxied', () => {
    assert.ok(inPreviewRange(8100) && inPreviewRange('8150') && inPreviewRange(8199));
    for (const p of [80, 8099, 8200, 7681, 'x', 8100.5]) assert.ok(!inPreviewRange(p), String(p));
  });
});
