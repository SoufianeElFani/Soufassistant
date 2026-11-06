/*
 * 1.0.0 end to end through a real turn (stub SDK): an agent's instructions and
 * effort, deep research (Chat mode gets Write/Read, fenced), an autonomous task
 * (no prompts, questions declined), a project's knowledge in Chat, and the
 * "save as a skill" offer after a long task.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { startServer } from '../helpers/server-harness.mjs';

const tools = (n) => Array.from({ length: n }, (_, i) => ({ tool: { name: 'Read', input: { file_path: `/tmp/x${i}` }, id: `t${i}` } }));

describe('agents, research, autonomy, knowledge', () => {
  let h;
  before(async () => {
    h = await startServer({
      env: { SKILL_SUGGEST_STEPS: '3' },
      scenario: { runs: [
        { steps: [{ text: 'a' }] },
        { steps: [{ text: 'b' }] },
        { steps: [{ tool: { name: 'AskUserQuestion', input: { questions: [] }, id: 'q' } }, { tool: { name: 'Bash', input: { command: 'ls' }, id: 'b' } }, { text: 'c' }] },
        { steps: [...tools(4), { text: 'done' }] },
      ] },
    });
    const proj = path.join(h.dataDir, 'workspace', 'Offres');
    mkdirSync(path.join(proj, 'Knowledge'), { recursive: true });
    writeFileSync(path.join(proj, 'PROJECT.md'), 'Toujours en néerlandais.');
    writeFileSync(path.join(proj, 'Knowledge', 'tarifs.md'), 'Taux horaire 115 €.');
  });
  after(async () => { await h.stop(); });

  test('one turn each', async () => {
    const c = await h.connect();
    await c.waitFor('history');
    const done = async () => { await c.waitFor((m) => m.type === 'result' || m.type === 'query_complete' || m.type === 'done'); c.messages.length = 0; };

    c.send({ type: 'prompt', text: 'relis', mode: 'code', agent: 'relecteur-offres' });
    await done();
    let q = h.records('query').at(-1);
    assert.match(q.options.systemPromptText, /You are the agent "Relecteur d'offres"/);
    assert.equal(q.options.effort, 'high');

    c.send({ type: 'prompt', text: 'recherche', mode: 'chat', research: true, project: 'Offres', agent: null });
    await done();
    q = h.records('query').at(-1);
    assert.match(q.options.systemPromptText, /DEEP RESEARCH/);
    assert.match(q.options.systemPromptText, /Toujours en néerlandais[\s\S]*Taux horaire 115 €/, 'chat inlines the knowledge');
    assert.ok(q.options.tools.includes('Write') && q.options.tools.includes('WebSearch'));
    assert.ok(q.options.preToolUseHooks >= 1, 'writes are fenced');

    c.send({ type: 'prompt', text: 'fais tout', mode: 'code', autonomous: true, permissionMode: 'default', agent: null });
    await done();
    const decisions = h.records('tool_decision').slice(-2);
    assert.equal(decisions[0].outcome.behavior, 'deny', 'questions are declined');
    assert.match(decisions[0].outcome.message, /Autonomous task/);
    assert.equal(decisions[1].outcome.behavior, 'allow', 'Bash runs without a prompt');
    assert.match(h.records('query').at(-1).options.systemPromptText, /AUTONOMOUS task/);

    c.send({ type: 'prompt', text: 'long', mode: 'code', agent: null, permissionMode: 'bypass' });
    const sug = await c.waitFor('skill_suggestion');
    assert.equal(sug.steps, 4);
  });
});
