/*
 * When a "needs attention" push is sent, and when it is held back.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldPush, applySettings, notifySettings } from '../../server/lib/notify.js';

const on = { service: 'mobile_app_phone', onReply: true, onAttention: true };
const base = { kind: 'reply', settings: on, anyVisible: false, lastAt: null, now: 100000 };

describe('shouldPush', () => {
  test('sends when switched on and nobody is looking', () => assert.equal(shouldPush(base), true));
  test('never sends with no service chosen', () =>
    assert.equal(shouldPush({ ...base, settings: { ...on, service: '' } }), false));
  test('holds back while a tab is visible', () => assert.equal(shouldPush({ ...base, anyVisible: true }), false));
  test('respects the per-kind switches', () => {
    assert.equal(shouldPush({ ...base, settings: { ...on, onReply: false } }), false);
    assert.equal(shouldPush({ ...base, kind: 'permission', settings: { ...on, onAttention: false } }), false);
    assert.equal(shouldPush({ ...base, kind: 'permission', settings: { ...on, onReply: false } }), true);
  });
  test('a burst of the same kind is one nudge', () => {
    assert.equal(shouldPush({ ...base, lastAt: 95000 }), false);
    assert.equal(shouldPush({ ...base, lastAt: 80000 }), true);
  });
});

test('applySettings only accepts a bare service name', () => {
  applySettings({ service: '../evil/path', onReply: false });
  assert.equal(notifySettings.service, '');
  assert.equal(notifySettings.onReply, false);
  applySettings({ service: 'mobile_app_pixel_7' });
  assert.equal(notifySettings.service, 'mobile_app_pixel_7');
});
