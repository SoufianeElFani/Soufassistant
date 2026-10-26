/*
 * Adding to a working turn (`steer`): a message sent while Claude is working is
 * pushed into the run instead of stopping it, and the run stays open until the
 * CLI is idle again — so the added message is never cut off.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

describe('a message added while Claude is working', () => {
  test('does not stop the turn, reaches the CLI, and the run ends once idle', async () => {
    const h = await startServer({
      scenario: { runs: [{ noResult: true, steps: [
        { text: 'starting the report' },
        { sleep: 1200 },
        { text: 'still going' },
        { emit: { type: 'result', subtype: 'success', total_cost_usd: 0.01, num_turns: 1, usage } },
        { sleep: 200 },
        { emit: { type: 'system', subtype: 'session_state_changed', state: 'idle' } },
      ] }] },
    });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'write the report', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'text' && /starting/.test(m.text));
      c.send({ type: 'prompt', text: 'and add a summary table', permissionMode: 'bypass', steer: true });

      await c.waitFor((m) => m.type === 'text' && /still going/.test(m.text), { timeout: 8000 });
      const input = await h.waitForRecord((r) => r.kind === 'input' && /summary table/.test(r.text || ''));
      assert.ok(input, 'the added message went into the same run');
      assert.equal(h.records().filter((r) => r.kind === 'query').length, 1, 'no second query: the turn was not restarted');
      assert.ok(h.stdout.includes('message added to the working turn'));
    } finally { await h.stop(); }
  });

  test('without steer, a new prompt still replaces the working turn', async () => {
    const h = await startServer({
      scenario: { runs: [
        { steps: [{ text: 'first' }, { sleep: 3000 }, { text: 'never shown' }] },
        { steps: [{ text: 'second answer' }] },
      ] },
    });
    try {
      const c = await h.connect();
      await c.waitFor('history');
      c.send({ type: 'prompt', text: 'one', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'text' && m.text === 'first');
      c.send({ type: 'prompt', text: 'two', permissionMode: 'bypass' });
      await c.waitFor((m) => m.type === 'text' && m.text === 'second answer', { timeout: 8000 });
      assert.equal(h.records().filter((r) => r.kind === 'query').length, 2);
    } finally { await h.stop(); }
  });
});
