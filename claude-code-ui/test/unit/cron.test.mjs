/*
 * The 5-field cron matcher (server/lib/cron.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCronExpr, matchesCron, describeCron } from '../../server/lib/cron.js';

const at = (y, m, d, h, min, dow) => {
  // dow is informational only here — JS Date derives its own day-of-week from
  // the actual calendar date, so callers pick a real date for the weekday they want.
  const date = new Date(y, m - 1, d, h, min);
  if (dow !== undefined) assert.equal(date.getDay(), dow, 'test date does not have the expected weekday');
  return date;
};

describe('isValidCronExpr', () => {
  test('accepts the common shapes', () => {
    assert.equal(isValidCronExpr('0 7 * * *'), true);
    assert.equal(isValidCronExpr('*/15 * * * *'), true);
    assert.equal(isValidCronExpr('0 9 * * 1-5'), true);
    assert.equal(isValidCronExpr('30 8,18 * * *'), true);
  });
  test('rejects malformed expressions', () => {
    assert.equal(isValidCronExpr('0 7 * *'), false);          // 4 fields
    assert.equal(isValidCronExpr('60 7 * * *'), false);        // minute out of range
    assert.equal(isValidCronExpr('0 7 * * 8'), false);         // dow out of range
    assert.equal(isValidCronExpr('0 7 5-2 * *'), false);       // inverted range
    assert.equal(isValidCronExpr(''), false);
    assert.equal(isValidCronExpr('garbage'), false);
  });
});

describe('matchesCron', () => {
  test('a plain daily time matches only that minute', () => {
    assert.equal(matchesCron(at(2026, 10, 24, 7, 0), '0 7 * * *'), true);
    assert.equal(matchesCron(at(2026, 10, 24, 7, 1), '0 7 * * *'), false);
    assert.equal(matchesCron(at(2026, 10, 24, 8, 0), '0 7 * * *'), false);
  });

  test('step expressions', () => {
    assert.equal(matchesCron(at(2026, 10, 24, 12, 0), '*/15 * * * *'), true);
    assert.equal(matchesCron(at(2026, 10, 24, 12, 15), '*/15 * * * *'), true);
    assert.equal(matchesCron(at(2026, 10, 24, 12, 7), '*/15 * * * *'), false);
  });

  test('weekday ranges — 2026-10-26 is a Monday', () => {
    const monday = at(2026, 10, 26, 9, 0, 1);
    const saturday = at(2026, 10, 24, 9, 0, 6);
    assert.equal(matchesCron(monday, '0 9 * * 1-5'), true);
    assert.equal(matchesCron(saturday, '0 9 * * 1-5'), false);
  });

  test('dom and dow are OR-ed when both are restricted (classic cron rule)', () => {
    // The 1st of the month OR a Monday — 2026-10-26 is a Monday but not the 1st.
    const monday26th = at(2026, 10, 26, 0, 0, 1);
    assert.equal(matchesCron(monday26th, '0 0 1 * 1'), true);
    // Neither the 1st nor a Monday.
    const tuesday27th = at(2026, 10, 27, 0, 0, 2);
    assert.equal(matchesCron(tuesday27th, '0 0 1 * 1'), false);
  });

  test('0 and 7 both mean Sunday', () => {
    const sunday = at(2026, 10, 25, 10, 0, 0);
    assert.equal(matchesCron(sunday, '0 10 * * 0'), true);
    assert.equal(matchesCron(sunday, '0 10 * * 7'), true);
  });

  test('throws on an invalid expression rather than silently never matching', () => {
    assert.throws(() => matchesCron(new Date(), 'nope'));
  });
});

describe('describeCron', () => {
  test('known shapes get a human label', () => {
    assert.equal(describeCron('0 7 * * *'), 'every day at 07:00');
    assert.equal(describeCron('*/30 * * * *'), 'every 30 minutes');
  });
  test('falls back to the raw expression otherwise', () => {
    assert.equal(describeCron('5 4 1 * *'), '5 4 1 * *');
  });
});
