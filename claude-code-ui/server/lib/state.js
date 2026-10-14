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

  /** AbortController for the in-flight query — global, not per-connection, so
   *  navigating away mid-response does not cancel the run. */
  activeQuery: null,

  /** Permission mode for the in-flight run, re-read on every canUseTool call so
   *  the user can change how tools are approved mid-prompt. */
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

  /**
   * The in-flight run's input channel and phase, alongside `activeQuery`
   * (which stays the abort handle for everything that must cancel it). Non-null
   * exactly when `activeQuery` is.
   *
   *   phase: 'turn' while the model is actively responding to the prompt that
   *     started this run; 'background' once that turn's `result` has arrived
   *     but a background task it spawned (a subagent, a backgrounded shell
   *     command) is still running — the SDK's own `result` does not mean the
   *     run is over in that case, only that the foreground turn is.
   *   channel: the AsyncIterable<SDKUserMessage> queue handed to the SDK as
   *     `prompt`, kept open across the whole run. A run-query.js detail,
   *     leaked onto `runtime` only so a prompt arriving while `phase ===
   *     'background'` can be pushed into the SAME run instead of aborting it
   *     (which would kill the background work) and starting a new one.
   *   q: the SDK's Query object, for `setModel()` when a queued prompt picks a
   *     different model.
   */
  activeRun: null,

  /**
   * Live background tasks for the in-flight run (task_id → {description, type,
   * lastTool, summary}), excluding anything flagged `ambient` (housekeeping,
   * not activity — see SDKTaskStartedMessage). Mirrors `background_tasks`,
   * broadcast on every change and replayed to a newly (re)connected client the
   * same way `pendingDialogs` is, since a background task belongs to the run,
   * not to the tab that happened to be open when it started.
   */
  backgroundTasks: new Map(),
};
