/*
 * ha-common — helpers more than one command module needs.
 */
const { clock, toMillis } = require('./ha-time.cjs');

/**
 * The clock every command prints with: Home Assistant's configured timezone,
 * read from the running instance. The container is UTC, so trusting the local
 * clock here would silently shift every timestamp we report.
 */
async function haClock(ws, utc) {
  if (utc) return clock('UTC');
  try {
    const config = await ws.send({ type: 'get_config' });
    return clock(config?.time_zone || 'UTC');
  } catch {
    return clock('UTC');
  }
}

/** Resolve an entity_id, object_id, numeric id, or alias to one automation. */
async function resolveAutomation(ws, ref) {
  const states = await ws.send({ type: 'get_states' });
  const automations = (states || []).filter((s) => s.entity_id.startsWith('automation.'));
  const needle = String(ref).toLowerCase();

  const match = automations.find((s) =>
    s.entity_id.toLowerCase() === needle ||
    s.entity_id.toLowerCase() === `automation.${needle}` ||
    String(s.attributes?.id) === String(ref) ||
    String(s.attributes?.friendly_name || '').toLowerCase() === needle);

  if (!match) {
    throw new Error(
      `no automation matching "${ref}" — try \`ha-tools automation list\` ` +
      `(matched on entity_id, numeric id, or friendly name)`);
  }
  return {
    entity_id: match.entity_id,
    id: match.attributes?.id ? String(match.attributes.id) : null,
    alias: match.attributes?.friendly_name || null,
    state: match.state,
    last_triggered: match.attributes?.last_triggered || null,
  };
}

/** "5m", "3h", "2d", "42s" — the compact age used by device-health and compare. */
function shortAge(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** "0:42:13", or "2d 03:04:05" past a day — for how long something has been running. */
function longDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const hms = `${d ? String(h).padStart(2, '0') : h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return d ? `${d}d ${hms}` : hms;
}

/** Glob (`*` only) → case-insensitive unanchored RegExp, as ha-ws-client matched. */
function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(escaped, 'i');
}

module.exports = { haClock, resolveAutomation, shortAge, longDuration, globToRegExp, toMillis };
