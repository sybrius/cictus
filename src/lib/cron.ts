/**
 * Minimal 5-field cron support for scheduled migrations.
 *
 * Fields: minute hour day-of-month month day-of-week
 * Each field accepts: `*`, `*\/n`, `a`, `a,b`, `a-b`, `a-b/n`.
 * Month and weekday names are accepted (jan, mon, ...). Day-of-week
 * 0 and 7 are both Sunday. No seconds, no `L`/`W`/`#`, no timezones:
 * schedules run in the server's local time (the machine the app runs
 * on), which is what a local-first tool wants.
 *
 * Day-of-month vs day-of-week follows Vixie cron: when both fields
 * are restricted (not `*`), the job runs when EITHER matches; when
 * one is `*`, only the other constrains the day.
 */

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

const RANGES: Record<number, [number, number]> = {
  0: [0, 59],
  1: [0, 23],
  2: [1, 31],
  3: [1, 12],
  4: [0, 7],
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseValue(raw: string, field: number): number | null {
  const v = raw.trim().toLowerCase();
  if (field === 3 && MONTH_NAMES[v] !== undefined) return MONTH_NAMES[v];
  if (field === 4 && DOW_NAMES[v] !== undefined) return DOW_NAMES[v];
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

function parseField(raw: string, field: number): { values: Set<number>; error?: string } {
  const [lo, hi] = RANGES[field];
  const values = new Set<number>();
  const parts = raw.split(',');
  for (const part of parts) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return { values, error: `bad step "${part}"` };
    let start: number;
    let end: number;
    if (range === '*') {
      start = lo;
      end = hi;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      const av = parseValue(a, field);
      const bv = parseValue(b, field);
      if (av === null || bv === null) return { values, error: `bad range "${part}"` };
      start = av;
      end = bv;
    } else {
      const v = parseValue(range, field);
      if (v === null) return { values, error: `bad value "${part}"` };
      start = v;
      end = v;
    }
    if (start < lo || end > hi || start > end) {
      return { values, error: `value out of range in "${part}" (allowed ${lo}–${hi})` };
    }
    for (let n = start; n <= end; n += step) values.add(n);
  }
  return { values };
}

/** Parse a cron expression. Returns the fields, or an error string. */
export function parseCron(expr: string): { fields: CronFields | null; error: string | null } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { fields: null, error: 'A schedule needs 5 fields: minute hour day-of-month month day-of-week (e.g. "0 2 * * *").' };
  }
  const out: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const r = parseField(parts[i], i);
    if (r.error) return { fields: null, error: `Field ${i + 1} (${parts[i]}): ${r.error}.` };
    out.push([...r.values]);
  }
  const dow = new Set(out[4].map((d) => (d === 7 ? 0 : d)));
  return {
    fields: {
      minute: new Set(out[0]),
      hour: new Set(out[1]),
      dom: new Set(out[2]),
      month: new Set(out[3]),
      dow,
      domRestricted: parts[2] !== '*',
      dowRestricted: parts[4] !== '*',
    },
    error: null,
  };
}

/** `null` when the expression is valid, otherwise a plain-English error. */
export function validateCron(expr: string): string | null {
  return parseCron(expr).error;
}

export function matchesCron(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/** Next run strictly after `from` (minute precision). Null if none within a year. */
export function nextRunAfter(expr: string, from: Date): Date | null {
  const { fields, error } = parseCron(expr);
  if (!fields || error) return null;
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (matchesCron(fields, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Next `n` runs after `from`. */
export function nextRuns(expr: string, from: Date, n = 3): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < n; i++) {
    const next = nextRunAfter(expr, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Short human description, e.g. "Daily at 02:00" or "Every 6 hours". */
export function describeCron(expr: string): string {
  const { fields, error } = parseCron(expr);
  if (!fields || error) return expr;
  const pad = (n: number) => String(n).padStart(2, '0');
  const minutes = [...fields.minute].sort((a, b) => a - b);
  const hours = [...fields.hour].sort((a, b) => a - b);
  const isFull = (set: Set<number>, lo: number, hi: number) => {
    for (let n = lo; n <= hi; n++) if (!set.has(n)) return false;
    return true;
  };
  const atTime = hours.length === 1 && minutes.length === 1 ? `${pad(hours[0])}:${pad(minutes[0])}` : null;
  if (!fields.domRestricted && !fields.dowRestricted && isFull(fields.month, 1, 12)) {
    if (hours.length === 24 && minutes.length === 1) return `Every hour at :${pad(minutes[0])}`;
    if (minutes.length === 1 && hours.length > 1) {
      const step = hours[1] - hours[0];
      if (hours.every((h, i) => i === 0 || h - hours[i - 1] === step) && hours[0] === 0) return `Every ${step} hours at :${pad(minutes[0])}`;
    }
    if (atTime) return `Daily at ${atTime}`;
  }
  if (fields.dowRestricted && !fields.domRestricted && atTime) {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const days = [...fields.dow].sort((a, b) => a - b).map((d) => names[d]).join(', ');
    if (fields.dow.size === 5 && ![0, 6].some((d) => fields.dow.has(d))) return `Weekdays at ${atTime}`;
    return `${days} at ${atTime}`;
  }
  if (fields.domRestricted && !fields.dowRestricted && atTime && fields.dom.size === 1) {
    return `Monthly on day ${[...fields.dom][0]} at ${atTime}`;
  }
  return expr;
}
