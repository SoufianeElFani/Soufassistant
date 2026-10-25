/*
 * Plan usage (server/lib/plan-usage.js) — normalizing the SDK's experimental
 * /usage answer into what the Usage panel renders, and the panel's formatters.
 */
import { register } from 'node:module';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// plan-usage.js imports the Agent SDK; resolve it to the test stub.
register(new URL('../helpers/sdk-hooks.mjs', import.meta.url));
const { normalizePlanUsage } = await import('../../server/lib/plan-usage.js');

// Shape captured live from a Pro account (trimmed).
const LIVE = {
  subscription_type: 'pro',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 31, resets_at: '2026-10-25T12:40:00.293788+00:00' },
    seven_day: { utilization: 12, resets_at: '2026-10-30T21:00:00.293810+00:00' },
    seven_day_oauth_apps: null, seven_day_opus: null, seven_day_sonnet: null,
    tangelo: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null, currency: null },
  },
};

describe('normalizePlanUsage', () => {
  test('maps the live Pro answer to a session and a weekly window', () => {
    const n = normalizePlanUsage(LIVE, 1000);
    assert.equal(n.available, true);
    assert.equal(n.plan, 'pro');
    assert.equal(n.fetchedAt, 1000);
    assert.deepEqual(n.windows.map((w) => [w.key, w.group, w.utilization]),
      [['five_hour', 'session', 31], ['seven_day', 'weekly', 12]]);
    assert.equal(n.windows[0].resetsAt, Date.parse('2026-10-25T12:40:00.293788+00:00'));
    assert.deepEqual(n.extra, { enabled: false, monthlyLimit: null, used: null, utilization: null, currency: null });
  });

  test('keeps per-model weekly windows and an enabled monthly budget', () => {
    const n = normalizePlanUsage({
      subscription_type: 'max', rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 5, resets_at: null },
        seven_day_opus: { utilization: 80, resets_at: '2026-11-01T00:00:00Z' },
        extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: 'EUR' },
      },
    });
    assert.deepEqual(n.windows.map((w) => w.key), ['five_hour', 'seven_day_opus']);
    assert.equal(n.windows[0].resetsAt, null);
    assert.deepEqual(n.extra, { enabled: true, monthlyLimit: 50, used: 12.5, utilization: 25, currency: 'EUR' });
  });

  test('clamps out-of-range utilization and ignores garbage timestamps', () => {
    const n = normalizePlanUsage({ rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 140, resets_at: 'not a date' } } });
    assert.equal(n.windows[0].utilization, 100);
    assert.equal(n.windows[0].resetsAt, null);
  });

  test('API-key / unknown shapes are "unavailable", never a throw', () => {
    for (const raw of [null, undefined, {}, { rate_limits_available: false, rate_limits: null },
      { rate_limits_available: true, rate_limits: null }, { rate_limits_available: true, rate_limits: {} }]) {
      const n = normalizePlanUsage(raw);
      assert.equal(n.available, false);
      assert.deepEqual(n.windows, []);
    }
  });
});
