/*
 * The handful of values more than one module both reads and writes.
 *
 * They live on one object rather than as exported `let`s because an ES module's
 * exported binding is read-only in the importing module — and gathering them
 * here makes "what is shared, and who writes it" answerable by reading one file.
 * Anything only one module cares about stays a plain `let` in that module.
 */
export const S = {
  /** The WebSocket, and what it is currently doing. */
  ws: null,
  isConnected: false,
  isRunning: false,

  /** The assistant bubble being accumulated into, and the working indicator. */
  lastAssistantBubble: null,
  thinkingEl: null,

  /** The wrapper collecting a run of consecutive tool calls (null between runs). */
  currentToolGroup: null,

  /** Session usage totals for /usage, accumulated from result events. */
  usage: { messages: 0, turns: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },

  /** Plan limits (5-hour / weekly / extra usage) from the server's 'plan_usage' message. */
  planUsage: null,

  /** Multi-session state, sourced from Claude Code's on-disk store via the server. */
  sessions: [],
  activeSessionId: null,

  /** Home Assistant link targets, refreshed by the server after every run. */
  haEntities: new Set(),
  haAutomationIds: {},

  /** Context-window usage from the SDK: how close the chat is to auto-compaction. */
  ctxUsage: null,

  /** Slash commands the server reported from plugins, added to the app's own. */
  pluginCommands: [],

  /** A usage limit that stopped a run while auto-continue was off. */
  limitOffer: null,

  /** Background tasks (a subagent, a backgrounded shell command) the server
   *  reports still running after the foreground turn's own `result` — see
   *  run-query.js's runPhase. Empty when nothing is running in the background. */
  backgroundTasks: [],

  /** Scroll anchoring: whether the viewport is pinned to the bottom, and whether
   *  the transcript is being rebuilt wholesale (so the appends do not each drag
   *  the viewport around). */
  stickToBottom: true,
  suppressAutoScroll: false,

  /** The task-list widget (see server/lib/tasks.js) — independent of the
   *  transcript, driven by the claude-tasks CLI. */
  tasks: [],

  /** Files under /data/workspace (see server/lib/workspace.js), refreshed
   *  after every reply and on demand when the panel opens. */
  workspace: [],

  /** Persisted scheduled prompts (see server/lib/scheduler.js). The id of the
   *  entry currently open in the edit form, or null when the form is new/closed. */
  scheduled: [],
  scheduledEditingId: null,

  /** The Team panel (see server/lib/team.js) — a 1:1 / team-roster tracker,
   *  independent of the transcript. The id of the entry open in the edit
   *  form, or null when the form is new/closed. */
  team: [],
  teamEditingId: null,
};
