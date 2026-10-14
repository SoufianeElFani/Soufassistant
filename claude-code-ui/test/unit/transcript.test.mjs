/*
 * Reading Claude Code's transcript format. The integration tests cover this
 * through the wire; these cover the edges it is impractical to script a whole
 * session for — and they localise a failure to the parser rather than the
 * server.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockText, isCommandEcho, isHarnessEcho, isQuestionAnswer, lineToItems, parseTaskNotification, truncateOutput,
} from '../../server/lib/sessions.js';

const at = '2026-07-15T09:30:00.000Z';
const ts = Date.parse(at);

describe('blockText', () => {
  test('passes a plain string through', () => {
    assert.equal(blockText('hello'), 'hello');
  });

  test('joins the text of a content-block array', () => {
    assert.equal(blockText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
    assert.equal(blockText(['a', 'b']), 'ab');
  });

  test('falls back to JSON for a shape it does not know', () => {
    assert.equal(blockText({ weird: true }), '{"weird":true}');
  });

  test('treats a block with no text as empty rather than "undefined"', () => {
    assert.equal(blockText([{ type: 'image' }]), '');
  });
});

describe('isCommandEcho', () => {
  test('recognises the slash-command plumbing the CLI records as user messages', () => {
    assert.equal(isCommandEcho('<command-name>/compact</command-name>'), true);
    assert.equal(isCommandEcho('<local-command-stdout>done</local-command-stdout>'), true);
  });

  test('leaves an ordinary message alone', () => {
    assert.equal(isCommandEcho('please compact the chat'), false);
    assert.equal(isCommandEcho(undefined), false);
  });
});

describe('isHarnessEcho', () => {
  test('recognises a stray task-notification or system-reminder, not just command echoes', () => {
    assert.equal(isHarnessEcho('<task-notification>\n<task-id>x</task-id>\n</task-notification>'), true);
    assert.equal(isHarnessEcho('<system-reminder>be careful</system-reminder>'), true);
    assert.equal(isHarnessEcho('<command-name>/compact</command-name>'), true);
  });

  test('leaves an ordinary message alone', () => {
    assert.equal(isHarnessEcho('is the task notification system working?'), false);
  });
});

describe('parseTaskNotification', () => {
  test('pulls task-id, status and summary out of the real tag shape', () => {
    // The exact shape a background-task notification is injected as — seen
    // live, same CLI build this app ships (sdk 0.3.284 / CLI 2.1.284).
    const text = '<task-notification>\n<task-id>b792jzxbl</task-id>\n' +
      '<tool-use-id>toolu_01QRDfZkuu5QF1jWCqFTSN8s</tool-use-id>\n' +
      '<output-file>/tmp/tasks/b792jzxbl.output</output-file>\n' +
      '<status>completed</status>\n' +
      '<summary>Background command "grep foo" completed (exit code 0)</summary>\n' +
      '</task-notification>';
    assert.deepEqual(parseTaskNotification(text), {
      taskId: 'b792jzxbl', status: 'completed',
      summary: 'Background command "grep foo" completed (exit code 0)',
    });
  });

  test('falls back to a generic summary when a field is missing', () => {
    const result = parseTaskNotification('<task-notification>\n<status>failed</status>\n</task-notification>');
    assert.equal(result.taskId, null);
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'Background task finished');
  });

  test('returns null for text that is not a task-notification', () => {
    assert.equal(parseTaskNotification('just a normal message'), null);
    assert.equal(parseTaskNotification(undefined), null);
  });
});

describe('isQuestionAnswer', () => {
  const answer = 'The user answered your question(s):\n- Room: Hall';
  const skipped = 'The user closed the question dialog without answering. Ask again…';

  test('is true for an AskUserQuestion result, which always arrives as an error', () => {
    assert.equal(isQuestionAnswer('AskUserQuestion', true, answer), true);
  });

  test('is false when the call did not fail — nothing to reinterpret', () => {
    assert.equal(isQuestionAnswer('AskUserQuestion', false, answer), false);
  });

  test('recognises both answer texts when the tool name has been truncated away', () => {
    assert.equal(isQuestionAnswer(undefined, true, answer), true);
    assert.equal(isQuestionAnswer(undefined, true, skipped), true);
  });

  test('does not reinterpret a genuine failure from another tool', () => {
    assert.equal(isQuestionAnswer('Bash', true, 'command not found'), false);
    assert.equal(isQuestionAnswer(undefined, true, 'command not found'), false);
  });

  test('only matches the answer text at the start, not mentioned in passing', () => {
    assert.equal(
      isQuestionAnswer(undefined, true, 'grep found: The user answered your question(s):'),
      false);
  });
});

describe('truncateOutput', () => {
  test('leaves a reasonable result alone', () => {
    assert.equal(truncateOutput('short'), 'short');
  });

  test('caps a flood and says that it did', () => {
    const out = truncateOutput('x'.repeat(10_000));
    assert.ok(out.length < 4100);
    assert.ok(out.endsWith('…[truncated]'));
  });
});

describe('lineToItems', () => {
  test('turns a user string into one item, stamped from the transcript', () => {
    const items = lineToItems({ type: 'user', timestamp: at, message: { content: 'hello' } });
    assert.deepEqual(items, [{ kind: 'user', text: 'hello', ts }]);
  });

  test('skips meta, sidechain and compact-summary lines', () => {
    for (const flag of ['isMeta', 'isSidechain', 'isCompactSummary']) {
      const items = lineToItems({ type: 'user', [flag]: true, message: { content: 'noise' } });
      assert.deepEqual(items, [], `${flag} was not skipped`);
    }
  });

  test('skips a line with no message at all', () => {
    assert.deepEqual(lineToItems({ type: 'user' }), []);
  });

  test('drops whitespace-only and slash-command user messages', () => {
    assert.deepEqual(lineToItems({ type: 'user', message: { content: '   ' } }), []);
    assert.deepEqual(lineToItems({ type: 'user', message: { content: '<command-name>/compact</command-name>' } }), []);
  });

  test('carries tool names across the transcript so a result can be interpreted', () => {
    const toolNames = new Map();
    lineToItems({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }] },
    }, toolNames);

    const [result] = lineToItems({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'q1', is_error: true, content: 'anything at all' }] },
    }, toolNames);

    assert.equal(result.answered, true, 'the name came from the earlier line');
    assert.equal(result.isError, false);
  });

  test('leaves a real tool failure as an error', () => {
    const toolNames = new Map([['b1', 'Bash']]);
    const [result] = lineToItems({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }] },
    }, toolNames);
    assert.equal(result.isError, true);
    assert.equal(result.answered, false);
  });

  test('emits text and tool_use from one assistant message in order', () => {
    const items = lineToItems({
      type: 'assistant',
      timestamp: at,
      message: { content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/config/a' } },
      ] },
    });
    assert.deepEqual(items.map((i) => i.kind), ['text', 'tool_use']);
    assert.equal(items[1].name, 'Read');
    assert.equal(items[1].ts, ts);
  });

  test('omits ts entirely when the line has no usable timestamp', () => {
    const [item] = lineToItems({ type: 'user', timestamp: 'not a date', message: { content: 'hi' } });
    assert.equal('ts' in item, false, 'an undefined ts would render as a bogus date');
  });

  test('ignores a line type it does not know', () => {
    assert.deepEqual(lineToItems({ type: 'system', message: { content: 'x' } }), []);
  });

  test('a stray task-notification never renders as a user bubble', () => {
    // The injected record that caused the original bug: a `user`-role line
    // stamped origin.kind:'task-notification', its content the raw harness XML.
    const text = '<task-notification>\n<task-id>aba7acb45617cd7ac</task-id>\n' +
      '<status>completed</status>\n<summary>Subagent report delivered</summary>\n</task-notification>';
    const items = lineToItems({
      type: 'user', timestamp: at, origin: { kind: 'task-notification' },
      message: { role: 'user', content: text },
    });
    assert.deepEqual(items, [{
      kind: 'task_notice', taskId: 'aba7acb45617cd7ac', status: 'completed',
      summary: 'Subagent report delivered', ts,
    }]);
  });

  test('a task-notification with no parseable fields still never becomes a user item', () => {
    const items = lineToItems({
      type: 'user', origin: { kind: 'task-notification' },
      message: { role: 'user', content: 'The subagent ended without delivering a report through SubagentHandback' },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'task_notice');
    assert.notEqual(items[0].kind, 'user');
  });

  test('a delivered SubagentHandback report renders labelled, not as the user', () => {
    const items = lineToItems({
      type: 'user', timestamp: at,
      origin: { kind: 'peer', from: 'agent-aba7acb45617cd7ac', name: 'background agent', body: 'All done.' },
      message: { role: 'user', content: 'ignored — origin.body is the real text' },
    });
    assert.deepEqual(items, [{ kind: 'agent_report', from: 'background agent', text: 'All done.', ts }]);
  });

  test('other non-human origins are dropped, never shown as the user', () => {
    for (const kind of ['channel', 'coordinator', 'observer', 'auto-continuation', 'observer-activity']) {
      const items = lineToItems({ type: 'user', origin: { kind }, message: { role: 'user', content: 'machine text' } });
      assert.deepEqual(items, [], `origin.kind=${kind} was not dropped`);
    }
  });

  test('origin:human and an absent origin still render as an ordinary user bubble', () => {
    const withHuman = lineToItems({ type: 'user', origin: { kind: 'human' }, message: { content: 'hi' } });
    assert.deepEqual(withHuman, [{ kind: 'user', text: 'hi' }]);
    const withoutOrigin = lineToItems({ type: 'user', message: { content: 'hi' } });
    assert.deepEqual(withoutOrigin, [{ kind: 'user', text: 'hi' }]);
  });
});
