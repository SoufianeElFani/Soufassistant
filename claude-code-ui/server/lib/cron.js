/*
 * A small, dependency-free 5-field cron matcher (minute hour dom month dow),
 * in the spirit of the rest of this app's "own the small pieces of logic"
 * approach (see ha-time.cjs, ha-trace.cjs) rather than pulling in a package
 * for something this contained. Pure functions, unit-tested in
 * test/unit/cron.test.mjs.
 */

function parseField(field, min, max) {
  const values = new Set();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart !== undefined ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`bad step in "${part}"`);

    let lo, hi;
    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => parseInt(n, 10));
      if (!Number.isInteger(a) || !Number.isInteger(b) || a > b) throw new Error(`bad range "${rangePart}"`);
      lo = a; hi = b;
    } else {
      const n = parseInt(rangePart, 10);
      if (!Number.isInteger(n)) throw new Error(`bad value "${rangePart}"`);
      lo = n; hi = n;
    }
    if (lo < min || hi > max) throw new Error(`"${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** Throws with a human-readable reason on an invalid expression. */
export function parseCronExpr(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('a cron expression needs exactly 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = fields;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    // 0 and 7 both mean Sunday, matching cron convention.
    dow: new Set([...parseField(dow, 0, 7)].map((d) => (d === 7 ? 0 : d))),
    domWild: dom.trim() === '*',
    dowWild: dow.trim() === '*',
  };
}

export function isValidCronExpr(expr) {
  try { parseCronExpr(expr); return true; } catch { return false; }
}

/**
 * Whether `date` (local time) falls in the minute this expression names.
 * Standard cron rule: when BOTH day-of-month and day-of-week are restricted
 * (neither is `*`), a date matching either one is enough (OR, not AND).
 */
export function matchesCron(date, expr) {
  const c = typeof expr === 'string' ? parseCronExpr(expr) : expr;
  if (!c.minute.has(date.getMinutes())) return false;
  if (!c.hour.has(date.getHours())) return false;
  if (!c.month.has(date.getMonth() + 1)) return false;

  const domMatch = c.dom.has(date.getDate());
  const dowMatch = c.dow.has(date.getDay());
  if (c.domWild && c.dowWild) return true;
  if (c.domWild) return dowMatch;
  if (c.dowWild) return domMatch;
  return domMatch || dowMatch;
}

/** A short, human-readable description for common shapes, falling back to the
 *  raw expression — purely cosmetic, shown next to the field in the UI. */
export function describeCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dom, month, dow] = parts;
  if (dom === '*' && month === '*' && dow === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    return `every day at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  if (dom === '*' && month === '*' && /^\d+$/.test(minute) && /^\d+$/.test(hour) && /^[0-6](,[0-6])*$/.test(dow)) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = dow.split(',').map((d) => names[parseInt(d, 10) % 7]).join(',');
    return `${days} at ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  }
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `every ${minute.slice(2)} minutes`;
  }
  return expr;
}
