/*
 * How a tool call gets approved: the /addon_configs guard, and the canUseTool
 * that backs the ask / acceptEdits / bypass / plan modes.
 *
 * Two mechanisms, deliberately. A PreToolUse *hook* is used for the
 * /addon_configs guard because it runs in **all** permission modes — including
 * `auto`, which has no canUseTool at all — and its deny short-circuits the tool
 * before it executes. canUseTool is used for anything the user should be asked
 * about, because only it can carry a decision back from the browser.
 */
import { randomUUID } from 'crypto';
import {
  ALLOW_ADDON_CONFIGS, ADDON_CONFIGS_PATH, ENABLE_ESPHOME, ESPHOME_CONFIG_DIR, EDIT_TOOLS,
} from './config.js';
import { log } from './log.js';
import { runtime } from './state.js';
import { broadcast } from './broadcast.js';
import { askQuestion, formatQuestionDenial, askQuestionHook, pendingDialogs } from './dialogs.js';
import { notify, clearAttention } from './notify.js';

/**
 * Render the SDK's suggested permission rules into a short human label for the
 * "Always" button (e.g. "Bash(git status:*)" or "Read").
 */
export function describeSuggestions(suggestions) {
  const rules = [];
  for (const s of suggestions || []) {
    if ((s.type === 'addRules' || s.type === 'replaceRules') && Array.isArray(s.rules)) {
      for (const r of s.rules) rules.push(r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName);
    } else if (s.type === 'setMode') {
      rules.push(`mode: ${s.mode}`);
    }
  }
  return [...new Set(rules)].join(', ');
}

/**
 * When ESPHome is enabled, its config folder under /addon_configs is a
 * legitimate target even if broad access is off — but only that folder. A tool
 * call qualifies when *every* /addon_configs reference in it is inside that dir.
 */
export function touchesOnlyEsphome(blob) {
  if (!ENABLE_ESPHOME || !ESPHOME_CONFIG_DIR) return false;
  const refs = blob.match(/\/addon_configs\/[^"'\s)]+/g) || [];
  return refs.length > 0 && refs.every((r) => r === ESPHOME_CONFIG_DIR || r.startsWith(ESPHOME_CONFIG_DIR + '/'));
}

/**
 * Matching the absolute path in the serialized tool input catches Read/Edit/Write
 * (file_path), Glob/Grep (path) and Bash (command) uniformly; nothing under
 * /addon_configs is reachable from the /config cwd without naming that path.
 */
export function addonConfigsDenyHook(input) {
  const blob = JSON.stringify(input?.tool_input ?? '');
  if (!blob.includes(ADDON_CONFIGS_PATH)) return { continue: true };
  if (touchesOnlyEsphome(blob)) return { continue: true };
  return {
    continue: true,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Access to /addon_configs (other apps’ configuration) is disabled. ' +
        'Turn on "Allow access to other app configs" in the app Configuration tab to enable it.',
    },
  };
}

// Registered only when access is disabled: with it enabled there is no guard to
// run, so this avoids a per-tool-call round trip to the subprocess.
const ADDON_CONFIGS_HOOK = ALLOW_ADDON_CONFIGS ? null : async (input) => addonConfigsDenyHook(input);

export const ADDON_CONFIGS_HOOKS = ADDON_CONFIGS_HOOK
  ? { PreToolUse: [{ hooks: [ADDON_CONFIGS_HOOK] }] }
  : undefined;

/**
 * PreToolUse hooks for a run: the guard, plus the question interceptor in
 * `auto`. The question interceptor is scoped to AskUserQuestion by matcher —
 * every other tool call in `auto` mode used to round-trip through it too
 * (checking `tool_name !== 'AskUserQuestion'` and returning `{continue:true}`
 * unchanged), one more control-protocol message per call for nothing.
 */
export function hooksFor(mode) {
  const pre = [];
  if (ADDON_CONFIGS_HOOK) pre.push({ hooks: [ADDON_CONFIGS_HOOK] });
  if (mode === 'auto') pre.push({ matcher: 'AskUserQuestion', hooks: [askQuestionHook] });
  return pre.length ? { PreToolUse: pre } : undefined;
}

/**
 * Pending permission prompts, keyed by request id — module-level, not
 * per-connection. A prompt belongs to the run that asked it, not to the socket
 * that happened to be open at the time: closing that tab (backgrounding the
 * app, a phone sleeping) must not auto-deny a tool call that is still
 * genuinely waiting on an answer, any more than an AskUserQuestion does (see
 * dialogs.js's pendingDialogs, which this mirrors). It also covers a headless
 * auto-continue resume, which has no originating socket at all: the same map,
 * answerable from any tab that connects.
 */
export const pendingPermissions = new Map();   // id → { toolName, resolve }

/** Resolve a prompt the user answered, from any connected tab. */
export function resolvePermission(id, decision) {
  const entry = pendingPermissions.get(id);
  if (!entry) return false;
  pendingPermissions.delete(id);
  entry.resolve(decision);
  // The prompt is now replayed to every connected tab (see ws-protocol.js's
  // greet()), so answering it on one must dismiss it on the others too.
  broadcast({ type: 'permission_resolved', id });
  clearIfSettled();
  return true;
}

/** The phone notification is about "something is waiting"; take it down once nothing is. */
function clearIfSettled() {
  if (!pendingPermissions.size && !pendingDialogs.size) clearAttention();
}

/**
 * Switching to a more permissive mode mid-prompt should not leave a card on
 * screen that the new mode would now allow — across every tab.
 */
export function resolvePromptsAllowedBy(mode) {
  if (mode !== 'bypass' && mode !== 'acceptEdits') return;
  const permits = (toolName) => mode === 'bypass' || EDIT_TOOLS.has(toolName);

  for (const [id, entry] of pendingPermissions) {
    if (!permits(entry.toolName)) continue;
    pendingPermissions.delete(id);
    entry.resolve('allow');
    broadcast({ type: 'permission_resolved', id });
  }
  clearIfSettled();
}

/**
 * Build the canUseTool for one run.
 *
 * It reads `runtime.activePermMode` at call time rather than closing over the
 * mode it was built with, which is what makes switching modes mid-prompt take
 * effect immediately.
 */
export function makeCanUseTool() {
  return (toolName, input, options) => {
    // A question is Claude asking the human something, not an action needing
    // approval — it never reaches the permission modes below.
    if (toolName === 'AskUserQuestion') {
      return askQuestion(input, options.signal).then((answer) => formatQuestionDenial(input, answer));
    }

    const mode = runtime.activePermMode;
    if (mode === 'bypass' || (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName))) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    // Plan mode: the SDK restricts the model to read-only tools, so allow those
    // silently and only prompt when it proposes leaving plan mode.
    if (mode === 'plan' && toolName !== 'ExitPlanMode') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }

    return new Promise((resolve) => {
      const id = randomUUID();
      // The SDK hands us `suggestions`: permission rules that would stop it
      // asking again for this kind of call (e.g. Bash(git status:*)). Handing
      // them straight back as `updatedPermissions` on an allow is what makes a
      // decision stick to the *tool* rather than to this one call.
      const suggestions = Array.isArray(options.suggestions) ? options.suggestions : [];
      const req = {
        type: 'permission_request',
        id,
        toolName,
        input,
        title: options.title,
        description: options.description,
        canAlways: suggestions.length > 0,
        alwaysLabel: describeSuggestions(suggestions),
      };

      // Broadcast, not just sent to the asking tab — the prompt belongs to the
      // run, not to whichever socket happened to be open when it was raised,
      // exactly like askQuestion(). A second tab open at the time sees it too,
      // and a disconnected/headless run still reaches whoever is around.
      broadcast(req);
      notify('permission', {
        title: 'Claude needs permission',
        message: options.title || `Allow ${toolName}?`,
      });

      // 'allow' (this call) | 'always' (this call + persist the rule) | 'deny'
      const finish = (decision) => {
        if (decision === 'always' && suggestions.length) {
          log('INFO', `permission: always-allow ${describeSuggestions(suggestions)}`);
          resolve({ behavior: 'allow', updatedInput: input, updatedPermissions: suggestions });
        } else if (decision === 'always' || decision === 'allow') {
          resolve({ behavior: 'allow', updatedInput: input });
        } else {
          resolve({ behavior: 'deny', message: 'Denied by user' });
        }
      };

      // `req` is kept too (not just toolName/resolve) so a tab connecting
      // after the prompt was raised — not just one that was open for it — can
      // be shown the same card on replay (see ws-protocol.js's greet()).
      pendingPermissions.set(id, { toolName, req, resolve: finish });
      // The only things that end the wait: an answer, or the call's own abort
      // signal (Stop, a new prompt, a session switch, or — for a backgrounded
      // run — the whole run finally ending). A disconnecting tab does not.
      options.signal.addEventListener('abort', () => {
        if (pendingPermissions.delete(id)) { broadcast({ type: 'permission_resolved', id }); clearIfSettled(); }
        resolve({ behavior: 'deny', message: 'Aborted' });
      }, { once: true });
    });
  };
}
