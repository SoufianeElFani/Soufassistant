/*
 * The handful of values that genuinely span the whole process.
 *
 * They are gathered into one object rather than scattered as module-level `let`s
 * so that "what is mutable here, and who writes it" is answerable by reading one
 * file — and so a reader can tell shared state from a module's own bookkeeping.
 */
import { DEFAULT_PERMISSION_MODE } from './config.js';

export const runtime = {
  /** The SDK session being resumed. Persisted as a pointer in ACTIVE_FILE. */
  activeSessionId: null,

  /** A new conversation on screen that has not reported its session id yet:
   *  the draft key its run is filed under (see runs.js). Null otherwise. */
  draftKey: null,

  /**
   * In-flight runs, one per conversation: key (session id, or a draft key) →
   * run. See runs.js. A run is
   *   { key, sessionId, abortController, channel, q, phase, model, effort,
   *     permissionMode, backgroundTasks, mode, project, title, startedAt }
   *   phase: 'turn' while the model is actively responding; 'background' once
   *     that turn's `result` has arrived but a background task it spawned (a
   *     subagent, a backgrounded shell command) is still running — the SDK's
   *     own `result` does not mean the run is over in that case.
   *   channel: the AsyncIterable<SDKUserMessage> handed to the SDK as
   *     `prompt`, kept open across the whole run, so a prompt arriving while
   *     `phase === 'background'` is pushed into the SAME run instead of
   *     aborting it (which would kill the background work).
   *   q: the SDK's Query object, for `setModel()` when a queued prompt picks a
   *     different model.
   *   permissionMode: re-read on every canUseTool call, so the user can change
   *     how tools are approved mid-prompt.
   *   backgroundTasks: task_id → {description, type, lastTool, summary},
   *     excluding anything flagged `ambient`.
   */
  runs: new Map(),

  /** The permission mode last chosen in the UI — the default for the next run. */
  activePermMode: DEFAULT_PERMISSION_MODE,

  /** Plugin/agent slash commands from the SDK init event, cached so a newly
   *  connected client can populate its autocomplete immediately. */
  cachedSlashCommands: [],

  /** The SDK's own model catalog (query.supportedModels()), account-filtered —
   *  the same list Claude Code's /model picker uses. Cached so a newly
   *  connected client can rebuild its dropdown immediately; the static options
   *  in index.html are only the fallback shown before the first turn. */
  cachedModels: [],

  /** Set when a query fails for an auth reason. The credentials file still
   *  exists in that case, so isAuthenticated() alone would keep hiding the login
   *  screen; this is what lets the UI show a re-auth prompt instead. */
  credentialsExpired: false,

  /** Link targets so replies can turn entity ids into Home Assistant links. */
  haLinks: { entities: [], automations: {} },
};
