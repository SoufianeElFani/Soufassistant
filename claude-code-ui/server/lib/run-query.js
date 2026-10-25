/*
 * One turn: build the SDK options, run the query, and map its events onto the
 * wire protocol the browser speaks.
 *
 * The run is owned by the app, not by the socket that started it. Its
 * AbortController is module-level, so navigating away mid-response does not
 * cancel it, and every event is broadcast rather than replied to.
 *
 * The prompt is a streamed AsyncIterable (`input-channel.js`), not a plain
 * string — confirmed live: a string prompt makes the SDK close the CLI's
 * stdin as soon as the turn's own `result` arrives, and once stdin is closed
 * the CLI can no longer send ANY control request back to this host (a
 * PreToolUse hook callback, a canUseTool ask). Every one is then denied
 * locally inside the CLI with its canned "The user doesn't want to take this
 * action right now" text — including a background subagent trying to deliver
 * its report through SubagentHandback, which is exactly the failure this
 * fixes. Keeping the channel open until every background task this run
 * spawned has actually finished defers that close until it is genuinely safe.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  WORK_DIR, PLUGINS, EFFORT_LEVELS, DEFAULT_PERMISSION_MODE, STALL_WARN_MS, STALL_CHECK_MS,
} from './config.js';
import { log, vlog } from './log.js';
import { runtime } from './state.js';
import { connections, send, broadcast } from './broadcast.js';
import { isAuthError, isSubscriptionAuth } from './auth.js';
import { listSessions, saveActive, isQuestionAnswer, parseTaskNotification, truncateOutput } from './sessions.js';
import { hooksFor, makeCanUseTool } from './permissions.js';
import { askQuestion } from './dialogs.js';
import { refreshHaLinks } from './ha-links.js';
import { listWorkspaceEntries } from './workspace.js';
import { MCP_FREE_SETTINGS } from './mcp.js';
import { usableSlashCommands } from './slash-commands.js';
import { makeInputChannel } from './input-channel.js';
import { notify } from './notify.js';
import * as autoContinue from './auto-continue.js';
import { refreshPlanUsage } from './plan-usage.js';

// STALL_WARN_MS / STALL_CHECK_MS (config.js): how long the SDK may go quiet
// before the log says so, and how often it checks — only while a turn is
// actively in flight. A run waiting on a background task is expected to be
// quiet for a long time, so the watchdog is exempt in that phase (see
// runPhase below) and instead logs an occasional heartbeat.
const BACKGROUND_HEARTBEAT_TICKS = Math.max(1, Math.round(300000 / STALL_CHECK_MS)); // ~5 min

export function abortActive() {
  if (runtime.activeQuery) { runtime.activeQuery.abort(); runtime.activeQuery = null; }
  // Clear this eagerly too (not just in the run's own `finally`), so a prompt
  // arriving in the gap between abort() and that cleanup cannot be pushed into
  // a channel whose run is already being torn down.
  if (runtime.activeRun) { runtime.activeRun.channel.close(); runtime.activeRun = null; }
  if (runtime.backgroundTasks.size) {
    runtime.backgroundTasks = new Map();
    broadcast({ type: 'background_tasks', tasks: [] });
  }
}

export async function runQuery(ws, { text, permissionMode, model, effort, autoAttempts = 0 }) {
  // The previous turn already reported its `result`, but a background task it
  // spawned (a subagent, a backgrounded shell command) is still running. Push
  // the new message into that SAME still-open run instead of aborting it below
  // — aborting would kill the background work, which is the bug this exists to
  // avoid. (autoAttempts !== 0 is a headless auto-continue resume, which always
  // starts its own run.)
  if (autoAttempts === 0 && runtime.activeRun?.phase === 'background') {
    for (const c of connections) if (c !== ws) send(c, { type: 'user', text });
    runtime.activeRun.channel.push(text);
    log('INFO', `prompt queued into backgrounded run (waiting on ${runtime.backgroundTasks.size} task(s)): promptLen=${text.length}`);
    if (model && model !== runtime.activeRun.model) {
      runtime.activeRun.model = model;
      runtime.activeRun.q.setModel(model).catch((e) => log('WARN', `setModel on backgrounded run failed: ${e?.message || e}`));
    }
    // Mode changes for ask/acceptEdits/bypass/plan are already picked up live by
    // makeCanUseTool reading runtime.activePermMode at call time; a run that
    // started in 'auto' can't be live-switched regardless of this path.
    if (permissionMode) runtime.activePermMode = permissionMode;
    return;
  }

  abortActive();

  // A run that is not itself the auto-continue firing supersedes any scheduled
  // resume — the user has taken over. (fire() clears `pending` before calling in
  // here, so this is a no-op for that path.)
  if (autoAttempts === 0) {
    if (autoContinue.autoContinue.pending) autoContinue.cancel('superseded-by-prompt');
    autoContinue.clearLimitOffer('superseded-by-prompt');
  }

  const abortController = new AbortController();
  runtime.activeQuery = abortController;
  const startedAt = Date.now();

  // Set if a 5-hour usage-limit rejection stops this run. Trusted over anything
  // that follows it — see the note by the 'result' handler.
  let limitHit = null;
  // tool_use id → tool name for this run: a tool_result carries only the id, and
  // an answered question has to be told apart from a real failure.
  const liveToolNames = new Map();

  // Show the user's message on other clients (the sender rendered it locally,
  // and the SDK persists it to the session store, so nothing is recorded here).
  for (const c of connections) if (c !== ws) send(c, { type: 'user', text });

  // The CLI only sends `session_state_changed` (idle / running / requires_action)
  // when asked — it is the SDK's own "the turn is over" signal, which is what the
  // reply notification keys off rather than a guess from `result`.
  const opts = {
    cwd: WORK_DIR, abortController, plugins: PLUGINS, settings: MCP_FREE_SETTINGS,
    env: { ...process.env, CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' },
  };
  if (model) opts.model = model;
  // Only override effort when the UI asked for a level; otherwise the SDK's own
  // model default applies.
  if (effort && EFFORT_LEVELS.has(effort)) opts.effort = effort;

  runtime.activePermMode = permissionMode || DEFAULT_PERMISSION_MODE;

  const hooks = hooksFor(runtime.activePermMode);
  if (hooks) opts.hooks = hooks;

  if (runtime.activePermMode === 'auto') {
    // A model classifier approves or denies each tool — no prompts, no canUseTool.
    opts.permissionMode = 'auto';
  } else {
    // 'plan' is SDK-native (read-only, produces a plan) but still routes through
    // canUseTool so the ExitPlanMode approval surfaces as a normal prompt.
    if (runtime.activePermMode === 'plan') opts.permissionMode = 'plan';
    opts.canUseTool = makeCanUseTool();
  }

  // AskUserQuestion is intercepted before it runs (canUseTool, or the PreToolUse
  // hook in `auto` mode), so the tool never executes and the CLI's canned "the
  // user did not answer" cannot happen. `onUserDialog` is still registered — it
  // is the documented contract and costs nothing — in case a future SDK build
  // starts using it; it feeds the same pending-dialog map, so the browser side is
  // identical either way. (It does nothing on its own: the CLI fails closed on
  // any dialog_kind not also in supportedDialogKinds, and the tool needs its
  // toolConfig entry.)
  opts.supportedDialogKinds = ['askUserQuestion'];
  opts.toolConfig = { askUserQuestion: { previewFormat: 'html' } };
  opts.onUserDialog = (request, { signal }) => {
    log('INFO', `onUserDialog: ${request.dialogKind}`);
    return askQuestion(request.payload || {}, signal)
      .then((answer) => (answer ? { behavior: 'completed', result: answer } : { behavior: 'cancelled' }));
  };

  const resuming = !!runtime.activeSessionId;
  if (resuming) opts.resume = runtime.activeSessionId;

  /** Cache-inclusive context usage, pushed to every client after each result. */
  const reportContextUsage = async (q) => {
    try {
      const u = await q.getContextUsage();
      broadcast({
        type: 'context_usage',
        totalTokens: u.totalTokens,
        maxTokens: u.maxTokens,
        autoCompactThreshold: u.autoCompactThreshold,
        autoCompactEnabled: u.isAutoCompactEnabled,
      });
      const limit = (u.isAutoCompactEnabled && u.autoCompactThreshold) || u.maxTokens;
      const pct = limit ? Math.round((u.totalTokens / limit) * 100) : 0;
      const detail = `context ${u.totalTokens}/${limit} tokens (${pct}%)` +
        ` maxTokens=${u.maxTokens} autoCompact=${u.isAutoCompactEnabled ? 'on' : 'off'}` +
        ` threshold=${u.autoCompactThreshold || 'n/a'}`;
      if (pct >= 90) log('WARN', `${detail} — near auto-compact; a turn may pause while it compacts`);
      else vlog(detail);
    } catch (e) { vlog(`getContextUsage failed: ${e?.message || e}`); }
  };

  // The SDK's own model catalog — account-filtered, the same list Claude Code's
  // /model picker is built from. Fire-and-forget: never awaited in the event
  // loop, so a slow or unimplemented control request cannot delay the stream,
  // and the catch means an older CLI simply leaves the static list in place.
  const reportModelCatalog = async (q) => {
    try {
      const rows = await q.supportedModels();
      const models = (rows || []).map(({ value, resolvedModel, displayName, description }) =>
        ({ value, resolvedModel, displayName, description }));
      if (!models.length) return;
      runtime.cachedModels = models;
      broadcast({ type: 'models', models });
      vlog(`models: ${models.length} offered`);
    } catch (e) { vlog(`supportedModels failed: ${e?.message || e}`); }
  };

  log('INFO', `query start: mode=${runtime.activePermMode} effort=${opts.effort || 'default'} ` +
    `model=${model || 'default'} resume=${resuming} promptLen=${text.length}`);

  // Streamed input — see the file header. Kept open until every background
  // task this run spawns has finished (maybeEndRun below), not just until the
  // foreground turn's own `result`.
  const channel = makeInputChannel(text);
  runtime.activeRun = { channel, q: null, phase: 'turn', model, effort, permissionMode: runtime.activePermMode };

  // Background tasks spawned by this run (subagents, backgrounded shell
  // commands). `background_tasks_changed` is the authoritative membership
  // signal (REPLACE semantics); `task_progress` only enriches the entries
  // already there. Ambient tasks (housekeeping, not activity) are excluded.
  let resultSeen = false;
  // If this CLI never sends session_state_changed, the run's genuine end (the
  // `finally` below) stands in for it, so a reply is still announced.
  let sawStateEvents = false;
  let failed = false;
  let runPhase = 'turn';
  let backgroundHeartbeatTicks = 0;

  const syncBackgroundTasks = (tasks) => {
    const next = new Map();
    for (const t of (tasks || [])) {
      if (t.ambient) continue;
      const prev = runtime.backgroundTasks.get(t.task_id);
      next.set(t.task_id, {
        id: t.task_id, description: t.description, type: t.task_type,
        lastTool: prev?.lastTool, summary: prev?.summary,
      });
    }
    runtime.backgroundTasks = next;
    broadcast({ type: 'background_tasks', tasks: [...next.values()] });
    maybeEndRun();
  };

  const updateBackgroundTaskProgress = (event) => {
    const t = runtime.backgroundTasks.get(event.task_id);
    if (!t) return;
    if (event.last_tool_name !== undefined) t.lastTool = event.last_tool_name;
    if (event.summary !== undefined) t.summary = event.summary;
    broadcast({ type: 'background_tasks', tasks: [...runtime.backgroundTasks.values()] });
  };

  /** Once the foreground turn has reported `result` AND no background task is
   *  left running, the input channel can close — only then is this run
   *  genuinely over. */
  function maybeEndRun() {
    if (!resultSeen) return;
    if (runtime.backgroundTasks.size > 0) {
      if (runPhase !== 'background') {
        runPhase = 'background';
        if (runtime.activeRun) runtime.activeRun.phase = 'background';
        log('INFO', `turn finished; waiting on ${runtime.backgroundTasks.size} background task(s): ` +
          [...runtime.backgroundTasks.values()].map((t) => t.description).join(', '));
      }
      return;
    }
    if (runPhase === 'background') log('INFO', 'background task(s) finished; ending run');
    channel.close();
  }

  // Stall watchdog — the reported "chat hangs" symptom. If no SDK event arrives
  // for a while during an active TURN (long thinking, a slow tool, a retry, or
  // auto-compaction), log how long it has been quiet so the app log shows
  // whether it is truly stuck or just working. Exempt while waiting on a
  // background task: that silence is expected, not a stall.
  let lastEventAt = Date.now();
  let lastEventKind = 'start';
  const watchdog = setInterval(() => {
    if (abortController.signal.aborted) return;
    if (runPhase === 'background') {
      backgroundHeartbeatTicks += 1;
      if (backgroundHeartbeatTicks % BACKGROUND_HEARTBEAT_TICKS === 0) {
        vlog(`still waiting on ${runtime.backgroundTasks.size} background task(s)`);
      }
      return;
    }
    const idleS = Math.round((Date.now() - lastEventAt) / 1000);
    if (idleS * 1000 >= STALL_WARN_MS) {
      log('WARN', `query quiet for ${idleS}s (last event: ${lastEventKind}) — still awaiting the SDK`);
    }
  }, STALL_CHECK_MS);

  let q;
  try {
    q = query({ prompt: channel.iterable, options: opts });
    runtime.activeRun.q = q;
    for await (const event of q) {
      lastEventAt = Date.now();
      lastEventKind = event.type === 'system' ? `system/${event.subtype}` : event.type;

      if (event.type === 'system' && event.subtype === 'init') {
        runtime.activeSessionId = event.session_id;
        saveActive();
        broadcast({ type: 'session', id: event.session_id });
        if (event.model) broadcast({ type: 'model', model: event.model });
        // Terminal-only commands (/exit, /statusline …) are dropped here rather
        // than in the browser, so there is one place that knows this is a
        // remote UI — see slash-commands.js.
        const commands = usableSlashCommands(event);
        if (commands) {
          runtime.cachedSlashCommands = commands;
          broadcast({ type: 'slash_commands', commands });
          const hidden = event.slash_commands.length - commands.length;
          vlog(`slash commands: ${commands.length} offered${hidden ? `, ${hidden} terminal-only hidden` : ''}`);
        }
        vlog(`init: session=${event.session_id} model=${event.model}`);
        void reportModelCatalog(q);

      } else if (event.type === 'system' && event.subtype === 'compact_boundary') {
        const m = event.compact_metadata || {};
        log('INFO', `compaction (${m.trigger || 'manual'}): ${m.pre_tokens || '?'} → ${m.post_tokens || '?'} tokens`);
        broadcast({ type: 'compacted', trigger: m.trigger, preTokens: m.pre_tokens, postTokens: m.post_tokens });
        await reportContextUsage(q);

      } else if (event.type === 'system' && event.subtype === 'session_state_changed') {
        sawStateEvents = true;
        vlog(`session state: ${event.state}`);
        if (event.state === 'idle') {
          notify('reply', { title: 'Claude finished', message: 'Your reply is ready.' });
        }

      } else if (event.type === 'system' && event.subtype === 'background_tasks_changed') {
        syncBackgroundTasks(event.tasks);

      } else if (event.type === 'system' && event.subtype === 'task_progress') {
        updateBackgroundTaskProgress(event);

      } else if (event.type === 'system' && event.subtype === 'task_notification') {
        // A background task ending — the chat-visible "background agent
        // finished" chip (see sessions.js lineToItems for the stored-transcript
        // equivalent). Ambient/non-transcript tasks say nothing here either.
        if (!event.ambient && !event.skip_transcript) {
          broadcast({ type: 'task_notice', taskId: event.task_id, status: event.status, summary: event.summary });
        }

      } else if (event.type === 'assistant') {
        for (const block of (event.message?.content || [])) {
          if (block.type === 'text' && block.text) {
            vlog(`text: ${block.text.length} chars`);
            broadcast({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            vlog(`tool_use: ${block.name}`);
            liveToolNames.set(block.id, block.name);
            broadcast({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
          }
        }

      } else if (event.type === 'user') {
        const content = event.message?.content;
        const originKind = event.origin?.kind;
        // A background task's own notification, or a delivered SubagentHandback
        // report, arriving live — never raw harness XML, never a user bubble.
        // Mirrors sessions.js's lineToItems for the exact same record read back
        // from the stored transcript after a reload.
        if (originKind === 'task-notification') {
          const notificationText = typeof content === 'string' ? content : '';
          const n = parseTaskNotification(notificationText) || {};
          broadcast({ type: 'task_notice', taskId: n.taskId || null,
            status: n.status || 'completed', summary: n.summary || 'Background task finished' });
        } else if (originKind === 'peer' && typeof event.origin.body === 'string') {
          broadcast({ type: 'agent_report', from: event.origin.name || event.origin.from || 'background agent',
            text: event.origin.body });
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type !== 'tool_result') continue;
            const raw = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b) => b.text || '').join('')
                : JSON.stringify(block.content);
            vlog(`tool_result: ${raw.length} chars${block.is_error ? ' (error)' : ''}`);
            // An answered question comes back as an error and must not be
            // rendered as one — see isQuestionAnswer().
            const answered = isQuestionAnswer(liveToolNames.get(block.tool_use_id), !!block.is_error, raw);
            liveToolNames.delete(block.tool_use_id);
            broadcast({ type: 'tool_result', id: block.tool_use_id, output: truncateOutput(raw),
              isError: !!block.is_error && !answered, answered });
          }
        }

      } else if (event.type === 'rate_limit_event') {
        // Subscription usage-limit telemetry. A 'rejected' five_hour is the
        // auto-continue trigger; warnings are surfaced but ignored.
        const info = event.rate_limit_info || {};
        vlog(`rate_limit: status=${info.status} type=${info.rateLimitType} ` +
          `resetsAt=${info.resetsAt || 'n/a'} util=${info.utilization ?? 'n/a'}`);
        broadcast({ type: 'rate_limit', status: info.status, rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt, utilization: info.utilization });
        refreshPlanUsage({ q, force: info.status !== 'allowed' });
        if (info.status === 'rejected' && info.rateLimitType === 'five_hour' && info.resetsAt) {
          limitHit = { resetsAt: info.resetsAt, rateLimitType: info.rateLimitType };
          log('WARN', `usage limit reached (five_hour); resets at ${new Date(info.resetsAt * 1000).toISOString()}`);
        }

      } else if (event.type === 'result') {
        // Not trusted to mean the turn finished: a usage-limit rejection can be
        // followed by a 'result' claiming subtype:'success' (cost $0, 1 turn)
        // before the generator throws for real — confirmed live. `limitHit`, set
        // from the actual rate_limit_event, is what the `finally` block acts on.
        if (runtime.credentialsExpired) {
          runtime.credentialsExpired = false;
          broadcast({ type: 'auth_status', authenticated: true });
        }
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        log('INFO', `result: ${event.subtype} in ${secs}s, ${event.num_turns} turns, ` +
          `$${(event.total_cost_usd || 0).toFixed(4)}`);
        broadcast({
          type: 'result',
          success: event.subtype === 'success',
          cost: event.total_cost_usd,
          turns: event.num_turns,
          inputTokens: event.usage?.input_tokens ?? 0,
          outputTokens: event.usage?.output_tokens ?? 0,
          cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: event.usage?.cache_creation_input_tokens ?? 0,
          background: runtime.backgroundTasks.size > 0,
        });
        await reportContextUsage(q);
        // Plan limits moved with this turn — fire-and-forget, never delays the stream.
        refreshPlanUsage({ q });
        // A single streamed query can legitimately emit more than one `result`
        // — confirmed live: once for the foreground turn, then another each
        // time a background task's completion hands control back for a short
        // follow-up turn. Only close the channel once nothing is left running.
        resultSeen = true;
        maybeEndRun();
      }
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      const message = String(err?.message || err);
      log('ERROR', `query failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${message}`);
      // A usage-limit rejection throws from HERE rather than ending quietly —
      // confirmed live, with wrapped text like "Claude Code returned an error
      // result: You've hit your session limit · resets …". None of that is a
      // fresh failure, so this branch does nothing when `limitHit` is set: the
      // `finally` block covers it, with no stale-session drop and no raw error
      // bubble on top of the notice.
      if (!limitHit) {
        if (isAuthError(message)) {
          // The SESSION is fine — keep it so the conversation resumes after
          // re-login. Dropping it here made a later "continue" start a new,
          // empty session.
          runtime.credentialsExpired = true;
          log('WARN', 'query failed on authentication — prompting re-login');
          broadcast({ type: 'auth_expired', subscription: isSubscriptionAuth() });
        } else if (resuming) {
          // A genuinely stale resume id — drop it so the next prompt starts
          // fresh. (A limit-hit session is not stale, and must keep its id: it is
          // exactly what auto-continue resumes from.)
          runtime.activeSessionId = null;
          saveActive();
        }
        broadcast({ type: 'error', message });
        failed = true;
        notify('stopped', { title: 'Claude stopped', message: message.slice(0, 200) });
      }
    }
  } finally {
    clearInterval(watchdog);
    channel.close();   // idempotent — tidy up on an error/abort path too
    if (runtime.activeQuery === abortController) runtime.activeQuery = null;
    if (runtime.activeRun && runtime.activeRun.q === q) runtime.activeRun = null;
    if (runtime.backgroundTasks.size) {
      runtime.backgroundTasks = new Map();
      broadcast({ type: 'background_tasks', tasks: [] });
    }
    if (abortController.signal.aborted) {
      log('INFO', `query aborted by user after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      broadcast({ type: 'aborted' });
    }

    if (!sawStateEvents && !failed && !limitHit && !abortController.signal.aborted && resultSeen) {
      notify('reply', { title: 'Claude finished', message: 'Your reply is ready.' });
    }

    // The new or updated session (and its title) should appear in the list.
    broadcast({ type: 'sessions', sessions: listSessions(), activeId: runtime.activeSessionId });

    // Anything the run just created — a new automation, a new entity — should be
    // linkable in the reply that announces it.
    refreshHaLinks().then(() =>
      broadcast({ type: 'ha_links', entities: runtime.haLinks.entities, automations: runtime.haLinks.automations }));

    // Likewise any file the run just wrote under /data/workspace — cheap (a
    // bounded directory walk) and only worth doing once the turn is actually over.
    broadcast({ type: 'workspace', entries: listWorkspaceEntries() });

    if (limitHit && !abortController.signal.aborted) {
      notify('stopped', { title: 'Claude hit the usage limit', message: 'The 5-hour limit was reached.' });
      autoContinue.handleLimitHit(limitHit, {
        model, effort,
        permissionMode: permissionMode || DEFAULT_PERMISSION_MODE,
        autoAttempts,
      });
    }
  }
}
