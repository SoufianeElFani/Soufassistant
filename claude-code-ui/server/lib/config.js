/*
 * Everything the app reads from its environment, in one place.
 *
 * The defaults are the container layout: Home Assistant sets none of these, so
 * in production every value below is the fallback. They are overridable so the
 * server can be booted against a scratch directory under test.
 */
import path from 'path';

export const PORT = parseInt(process.env.SERVER_PORT || '7681', 10);
export const WORK_DIR = process.env.WORK_DIR || '/config';
export const PLUGIN_DIR = process.env.PLUGIN_DIR || '/opt/plugins/homeassistant-config';
export const CLAUDE_CONFIG_DIR = process.env.ANTHROPIC_CONFIG_DIR || '/data/.config/claude';
export const DEBUG_MODE = process.env.DEBUG_MODE === 'true';
export const DEFAULT_PERMISSION_MODE = process.env.DEFAULT_PERMISSION_MODE || 'ask';
export const VERBOSE_LOGGING = process.env.VERBOSE_LOGGING === 'true';

/** The app's persistent volume, its static assets, and the agent's own home. */
export const DATA_DIR = process.env.DATA_DIR || '/data';
export const FRONTEND_DIR = process.env.FRONTEND_DIR || '/opt/frontend';
export const HOME_DIR = process.env.HOME || '/data/home';

/** Supervisor base URL — the same override scripts/lib/ha-rest.cjs uses. */
export const SUPERVISOR_URL = process.env.HA_SUPERVISOR_URL || 'http://supervisor';

/**
 * Home Assistant Core, reached *directly* rather than through the Supervisor.
 *
 * This is deliberate and load-bearing for /diag's auth (see lib/ha-auth.js):
 * `http://supervisor/core/api/` accepts the app's own SUPERVISOR_TOKEN, so it
 * cannot tell a user's API key from this add-on's credentials. Core rejects that
 * token and accepts only real Core tokens, which is exactly the test we want.
 * Overridable so tests can point at a fake instead of a live instance.
 */
export const HA_CORE_URL = process.env.HA_CORE_URL || 'http://homeassistant:8123';
export const HA_CORE_WS_URL = process.env.HA_CORE_WS_URL ||
  `${HA_CORE_URL.replace(/^http/, 'ws')}/api/websocket`;

// Optional ESPHome capability. When enabled we load an extra local plugin (the
// esphome skill) and exempt the ESPHome app's config folder from the
// addon-configs guard so the esphome CLI can work on it.
export const ENABLE_ESPHOME = process.env.ENABLE_ESPHOME === 'true';
export const ESPHOME_CONFIG_DIR = process.env.ESPHOME_CONFIG_DIR || '';
export const ESPHOME_PLUGIN_DIR = '/opt/plugins/esphome';

/** Always-on local plugin providing the task-list and workspace conventions
 *  (see PLUGINS just below) — distinct from the HA-specific
 *  homeassistant-config plugin, since nothing in it is Home-Assistant-specific. */
export const PRODUCTIVITY_PLUGIN_DIR = '/opt/plugins/productivity-tools';

/** Plugins loaded for every query (the HA-config and productivity-tools
 *  plugins always; esphome opt-in). */
export const PLUGINS = [
  { type: 'local', path: PLUGIN_DIR },
  { type: 'local', path: PRODUCTIVITY_PLUGIN_DIR },
];
if (ENABLE_ESPHOME) PLUGINS.push({ type: 'local', path: ESPHOME_PLUGIN_DIR });

// Whether the agent may touch other apps' config folders. HA always mounts
// `all_app_configs` at /addon_configs (folder maps are static), so this flag
// — set from the `allow_addon_configs` app option — is what actually gates
// access, enforced by the PreToolUse hook in permissions.js.
export const ALLOW_ADDON_CONFIGS = process.env.ALLOW_ADDON_CONFIGS === 'true';
export const ADDON_CONFIGS_PATH = '/addon_configs';

/** Tools auto-approved in 'acceptEdits' mode (file edits only). */
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);

/** Valid reasoning-effort levels the UI can request (SDK `effort` option). */
export const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** Files the app owns on its persistent volume. */
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const ACTIVE_FILE = path.join(DATA_DIR, 'active-session.json');
export const AUTO_CONTINUE_FILE = path.join(DATA_DIR, 'auto-continue.json');
export const NOTIFY_FILE = path.join(DATA_DIR, 'notify.json');
export const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
export const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');
export const TEAM_FILE = path.join(DATA_DIR, 'team.json');

/**
 * A scratch/output folder, separate from `/config` (the live Home Assistant
 * configuration). This is where a task list, workspace files and scheduled-task
 * plugin tell Claude to put anything the user will want to keep or revisit — a
 * report, a generated image, a self-contained HTML page — instead of littering
 * `/config` with files HA was never meant to serve. Persists like everything
 * else under /data; served read-only at `/workspace` and listed at
 * `/api/workspace` (see server/lib/workspace.js).
 */
export const WORKSPACE_DIR = path.join(DATA_DIR, 'workspace');

/** The Workspace panel's choices (root folder, active Cowork project). */
export const WORKSPACE_CONFIG_FILE = path.join(DATA_DIR, 'workspace-config.json');

/** An rclone (bisync) log whose last success/error the Workspace panel shows,
 *  when the file exists. Overridable per install in workspace-config.json. */
export const WORKSPACE_SYNC_LOG = process.env.WORKSPACE_SYNC_LOG || path.join(DATA_DIR, 'tools', 'drive-sync.log');

/** Which skills the Skills panel turned off. */
export const SKILLS_CONFIG_FILE = path.join(DATA_DIR, 'skills-config.json');

/** The mode (chat / code / cowork) and Cowork project each conversation last used. */
export const SESSION_MODES_FILE = path.join(DATA_DIR, 'session-modes.json');

/** Where skills live on disk: the user's own (and, under synced/, the ones
 *  claude.ai syncs down for the signed-in account). */
export const USER_SKILLS_DIR = path.join(HOME_DIR, '.claude', 'skills');

/** How often the scheduler checks persisted entries against the clock. Kept
 *  well under a minute so a cron expression's minute field is never missed. */
export const SCHEDULER_TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS || '20000', 10);

/** Hard ceiling on one scheduled run, so a stuck unattended prompt can never
 *  block every future firing forever. */
export const SCHEDULED_RUN_TIMEOUT_MS = parseInt(process.env.SCHEDULED_RUN_TIMEOUT_MS || '900000', 10); // 15 min

/**
 * Claude Code's canonical transcript store, keyed on the project directory —
 * the same store the CLI uses, which is what makes sessions interchangeable.
 */
export const STORE_DIR = path.join(HOME_DIR, '.claude', 'projects', WORK_DIR.replace(/\//g, '-'));

// ── Auto-continue on usage-limit reset (subscription auth only) ───────────────
export const AUTO_CONTINUE_BUFFER_MS = 15000;    // resume a little past resetsAt, to be safe
export const AUTO_CONTINUE_MAX_ATTEMPTS = 3;     // consecutive resumes before giving up
export const AUTO_CONTINUE_PROMPT =
  'The usage limit has reset. Please continue from where you left off.';

// An offer is only worth showing while it still means something. The grace
// window keeps it on screen for a while after the reset, so "you can send again
// now" is still visible when you next look.
export const LIMIT_OFFER_GRACE_MS = 30 * 60 * 1000;

// ── Stall watchdog (run-query.js) ──────────────────────────────────────────
// How long the SDK may go quiet before the log says so, and how often it
// checks — only while a turn is actively in flight; waiting on a background
// task is expected to be quiet (see runPhase in run-query.js). Overridable so
// a test can see the watchdog actually fire without a real 20s wait.
export const STALL_WARN_MS = parseInt(process.env.STALL_WARN_MS || '20000', 10);
export const STALL_CHECK_MS = parseInt(process.env.STALL_CHECK_MS || '15000', 10);
