/*
 * Plan limits for the Usage panel (server/lib/plan-usage.js): a connecting tab
 * is sent the 5-hour / weekly meters, a probe never eats a scripted run, and a
 * finished turn refreshes them from the run's own Query.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../helpers/server-harness.mjs';

describe('plan usage on a subscription login', () => {
  let h;
  before(async () => {
    h = await startServer({
      subscription: true,
      scenario: {
        runs: [{ steps: [{ text: 'the scripted reply' }] }],
        planUsage: {
          subscription_type: 'max', rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 42, resets_at: '2030-01-01T12:00:00Z' },
            seven_day: { utilization: 7, resets_at: '2030-01-05T12:00:00Z' },
            extra_usage: { is_enabled: true, monthly_limit: 20, used_credits: 5, utilization: 25, currency: 'USD' },
          },
        },
      },
    });
  });
  after(async () => { await h.stop(); });

  test('a connecting tab receives the normalized meters', async () => {
    const c = await h.connect();
    const m = await c.waitFor('plan_usage');
    assert.equal(m.usage.available, true);
    assert.equal(m.usage.plan, 'max');
    assert.deepEqual(m.usage.windows.map((w) => [w.key, w.utilization]), [['five_hour', 42], ['seven_day', 7]]);
    assert.equal(m.usage.extra.monthlyLimit, 20);
  });

  test('the probe did not consume the scripted run', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hello', permissionMode: 'bypass' });
    await c.waitFor('result');
    assert.ok(c.all('text').some((m) => m.text === 'the scripted reply'), 'the first real prompt got run #1');
  });
});

describe('plan usage on an API-key login', () => {
  let h;
  before(async () => { h = await startServer({ subscription: false }); });
  after(async () => { await h.stop(); });

  test('is never fetched', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(c.all('plan_usage').length, 0);
    assert.equal(h.records('plan_usage').length, 0);
  });
});
