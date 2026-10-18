/*
 * ha-output — the three output shapes every absorbed command shares.
 *
 *   default   pretty JSON for data, readable lines for lists
 *   compact   one line per item
 *   --json    one line: {"success":true,"command":…,"data":…,"count":…}
 *
 * The JSON envelope is the shape ha-ws-client printed, kept exactly so anything
 * parsing it keeps working. Times in text output come from the HA-timezone clock
 * (lib/ha-time.cjs), never from the container's own.
 */

function create(opt, clk) {
  const fmt = opt.fmt || 'default';
  const isJson = fmt === 'json';
  const isCompact = fmt === 'compact';
  const showHeaders = !opt.noHeaders;
  const maxItems = opt.maxItems || 0;

  const envelope = (fields) => console.log(JSON.stringify({ success: true, ...fields }));

  function compactLine(item) {
    if (item === null || typeof item !== 'object') return String(item);
    if (typeof item.entity_id === 'string' && typeof item.state === 'string') return `${item.entity_id}=${item.state}`;
    if (typeof item.run_id === 'string' && typeof item.item_id === 'string') {
      return `${item.item_id} ${item.run_id} ${item.timestamp?.start ?? ''}`.trimEnd();
    }
    return Object.entries(item).filter(([, v]) => v !== null && v !== undefined).slice(0, 5)
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ');
  }

  const pretty = (v) => JSON.stringify(v, null, 2);

  const out = {
    isJson,
    isCompact,
    showHeaders,
    showAge: Boolean(opt.showAge),
    maxItems,
    clock: clk,

    /** A time for a text line: HA timezone with offset (--utc: UTC). */
    stamp(ms) {
      return clk.stamp(ms);
    },

    message(text) {
      if (isJson) envelope({ message: text });
      else console.log(text);
    },

    data(data, { command, count, summary } = {}) {
      if (isJson) {
        envelope({ command, data, count: count > 0 ? count : undefined, summary });
      } else if (isCompact) {
        if (summary) console.log(summary);
        if (Array.isArray(data)) data.forEach((d) => console.log(compactLine(d)));
        else console.log(compactLine(data));
      } else {
        if (summary && showHeaders) console.log(summary);
        console.log(pretty(data));
      }
    },

    list(items, { title, command, formatter } = {}) {
      const count = items.length;
      if (isJson) {
        envelope({ command, data: items, count: count > 0 ? count : undefined });
        return;
      }
      const shown = maxItems > 0 && count > maxItems ? items.slice(0, maxItems) : items;
      if (title && showHeaders) console.log(isCompact ? `${title}: ${count}` : `${title}: ${count}\n`);
      shown.forEach((item, i) => {
        if (formatter) console.log(formatter(item, i));
        else console.log(isCompact ? compactLine(item) : pretty(item));
      });
      if (shown.length < count) console.log(isCompact ? `+${count - shown.length} more` : `\n... and ${count - shown.length} more`);
    },

    timeline(entries, { title, command, formatter } = {}) {
      const count = entries.length;
      if (isJson) {
        envelope({ command, data: entries, count: count > 0 ? count : undefined });
        return;
      }
      const shown = maxItems > 0 && count > maxItems ? entries.slice(0, maxItems) : entries;
      if (title && showHeaders) console.log(isCompact ? `${title}: ${count}` : `${title}:\n`);
      for (const e of shown) console.log(formatter ? formatter(e) : isCompact ? compactLine(e) : pretty(e));
      if (shown.length < count) console.log(isCompact ? `+${count - shown.length} more` : `\n... and ${count - shown.length} more`);
      if (!isCompact && showHeaders) console.log(`\nTotal: ${count} entries`);
    },
  };
  return out;
}

module.exports = { create };
