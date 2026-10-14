/*
 * A minimal AsyncIterable<SDKUserMessage> queue, handed to the SDK as `prompt`
 * in place of a plain string.
 *
 * Why: the SDK treats a string prompt as a single-turn query and, once the
 * model's own turn reports `result`, closes the CLI's stdin — even while a
 * background task that turn spawned (a subagent, a backgrounded shell command)
 * is still running. Once stdin is closed, the CLI can no longer send ANY
 * control request back to this host (a hook callback, a canUseTool ask):
 * confirmed live, every one is then denied locally, inside the CLI, with its
 * canned "The user doesn't want to take this action right now" text — no
 * PreToolUse hook and no canUseTool ever run for that call, they just fail
 * closed. A subagent trying to deliver its report through SubagentHandback
 * loses exactly this way. Handing the SDK an AsyncIterable instead keeps the
 * channel open for as long as run-query.js chooses to, which is the fix.
 *
 * This is deliberately not a general message bus: one queue, FIFO, and the
 * generator parks on a single pending promise between pushes.
 */

/**
 * @param {string} firstText  The prompt that starts the run.
 */
export function makeInputChannel(firstText) {
  const queue = [];
  let wake = null;
  let closed = false;

  function frame(text) {
    return {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      // The SDK's origin contract: absent origin is unattributed, and strict
      // trust gates fail closed on it. This is genuinely keyboard input (or,
      // for a prompt queued mid-background-run, the same user's next message),
      // so it is stamped 'human' rather than left to default.
      origin: { kind: 'human' },
    };
  }

  queue.push(frame(firstText));

  /** Queue another user turn. No-op once close() has been called. */
  function push(text) {
    if (closed) return false;
    queue.push(frame(text));
    if (wake) { const w = wake; wake = null; w(); }
    return true;
  }

  /** End the stream once the generator next has nothing queued to yield. */
  function close() {
    if (closed) return;
    closed = true;
    if (wake) { const w = wake; wake = null; w(); }
  }

  async function* iterate() {
    for (;;) {
      while (queue.length) yield queue.shift();
      if (closed) return;
      await new Promise((resolve) => { wake = resolve; });
    }
  }

  return { iterable: iterate(), push, close };
}
