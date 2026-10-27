/*
 * 0.7.0: the reply streamed as it is written (text_delta), and roles — the
 * hats a prompt is written in, added to the system prompt and remembered per
 * conversation — end to end through the real server and the SDK stub.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, userLine } from '../helpers/server-harness.mjs';

const lastQuery = (h) => h.records('query').at(-1).options;

describe('streaming a reply', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [
        { steps: [{ stream: { chunks: ['Hel', 'lo ', 'wor', 'ld'], gap: 50 } }] },
        { steps: [{ stream: { chunks: ['sub', 'agent'], parent: 'toolu_1' } }, { text: 'main' }] },
      ] },
    });
  });
  after(async () => { await h.stop(); });

  test('asks the SDK for partial messages and sends the text on, batched, before the finished block', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'hi', permissionMode: 'bypass' });
    await c.waitFor('result');
    assert.equal(lastQuery(h).includePartialMessages, true);
    const deltas = c.all('text_delta');
    assert.ok(deltas.length >= 1, 'some text was streamed');
    assert.ok(deltas.length < 4, 'the deltas were batched, not sent one per chunk');
    assert.ok('Hello world'.startsWith(deltas.map((d) => d.text).join('')), 'in order, nothing lost or repeated');
    const kinds = c.messages.map((m) => m.type).filter((t) => t === 'text_delta' || t === 'text');
    assert.equal(kinds.at(-1), 'text', 'the finished block comes last');
    assert.equal(c.all('text').at(-1).text, 'Hello world');
  });

  test("a subagent's text is not streamed", async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'again', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'text' && m.text === 'main');
    assert.equal(c.all('text_delta').length, 0);
  });
});

describe('roles', () => {
  let h;
  before(async () => {
    h = await startServer({
      scenario: { runs: [
        { steps: [{ text: 'as a PM' }] },
        { steps: [{ text: 'in chat' }] },
        { steps: [{ text: 'no role' }] },
      ] },
      sessions: { old: [userLine('An old conversation')] },
      data: { 'active-session.json': { sessionId: 'old' } },
    });
  });
  after(async () => { await h.stop(); });

  test('a first start offers the three default roles', async () => {
    const c = await h.connect();
    const r = await c.waitFor('roles');
    assert.deepEqual(r.roles.map((x) => x.id), ['digital-solutions-pm', 'smart-building-lead', 'data-governance-pm']);
    assert.deepEqual(r.sessions, {});
  });

  test("the picked roles' contexts go into the system prompt, and the conversation remembers them", async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'plan', permissionMode: 'bypass', mode: 'code',
      roles: ['digital-solutions-pm', 'data-governance-pm', 'no-such-role'] });
    await c.waitFor('result');
    const o = lastQuery(h);
    assert.match(o.systemPromptText, /Chef de projet — Digital Solutions \+ Data Governance Program Manager/);
    assert.match(o.systemPromptText, /### Data Governance Program Manager\n/);
    assert.doesNotMatch(o.systemPromptText, /Smart Building Development/);
    const r = await c.waitFor((m) => m.type === 'roles' && m.sessions.old);
    assert.deepEqual(r.sessions.old, ['digital-solutions-pm', 'data-governance-pm']);
  });

  test('a chat turn gets them too, in its own system prompt', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'chat', permissionMode: 'bypass', mode: 'chat', roles: ['smart-building-lead'] });
    await c.waitFor('result');
    const o = lastQuery(h);
    assert.equal(o.systemPrompt, 'custom');
    assert.match(o.systemPromptText, /Chat mode[\s\S]*Smart Building Development Team Leader/);
  });

  test('no role picked: nothing is added, and the conversation forgets its roles', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'plain', permissionMode: 'bypass', roles: [] });
    await c.waitFor('result');
    assert.doesNotMatch(lastQuery(h).systemPromptText, /role/i);
    const r = await c.waitFor((m) => m.type === 'roles' && !m.sessions.old);
    assert.deepEqual(r.sessions, {});
  });

  test('roles are added, edited and deleted from the panel', async () => {
    const c = await h.connect();
    await c.waitFor('roles');
    c.send({ type: 'role_save', name: '  Coach  ', short: 'Coach', context: 'Je coache une équipe.' });
    assert.equal((await c.waitFor('role_result')).ok, true);
    const added = await c.waitFor((m) => m.type === 'roles' && m.roles.length === 4);
    const coach = added.roles.at(-1);
    assert.equal(coach.name, 'Coach');

    c.send({ type: 'role_save', id: coach.id, name: 'Coach agile', short: '', context: 'Scrum.' });
    await c.waitFor((m) => m.type === 'roles' && m.roles.some((x) => x.name === 'Coach agile'));

    c.send({ type: 'role_save', name: 'Empty', context: '' });
    const bad = await c.waitFor((m) => m.type === 'role_result' && !m.ok);
    assert.match(bad.error, /Describe the role/);

    c.send({ type: 'role_delete', id: coach.id });
    await c.waitFor((m) => m.type === 'roles' && m.roles.length === 3);
  });

  test('picking roles in an existing conversation is saved for it', async () => {
    const c = await h.connect();
    await c.waitFor('roles');
    c.send({ type: 'session_roles', id: 'old', roles: ['smart-building-lead'] });
    const r = await c.waitFor((m) => m.type === 'roles' && m.sessions.old);
    assert.deepEqual(r.sessions.old, ['smart-building-lead']);
  });
});

describe('a spoken conversation', () => {
  let h;
  before(async () => {
    h = await startServer({ scenario: { runs: [{ steps: [{ text: 'Bonjour !' }] }, { steps: [{ text: 'typed' }] }] } });
  });
  after(async () => { await h.stop(); });

  test('a prompt sent by voice asks for a short spoken answer; a typed one does not', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    c.send({ type: 'prompt', text: 'salut', permissionMode: 'bypass', voice: true, roles: ['smart-building-lead'] });
    await c.waitFor('result');
    const spoken = lastQuery(h).systemPromptText;
    assert.match(spoken, /## Spoken conversation/);
    assert.match(spoken, /Smart Building[\s\S]*Spoken conversation/, 'alongside the roles');
    c.send({ type: 'prompt', text: 'typed', permissionMode: 'bypass' });
    await c.waitFor((m) => m.type === 'text' && m.text === 'typed');
    assert.doesNotMatch(lastQuery(h).systemPromptText, /Spoken conversation/);
  });
});
