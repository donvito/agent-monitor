/** Options shared by the time formatters. Tests pin locale and time zone; the app uses the system defaults. */
export interface TimeFormatOptions {
  now?: number;
  locale?: string;
  timeZone?: string;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact elapsed time such as `30s ago`, `3d ago` or `2mo ago`. */
export function formatRelative(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return 'unknown';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < MINUTE) return `${seconds}s ago`;
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  const days = Math.floor(seconds / DAY);
  if (days < 14) return `${days}d ago`;
  if (days < 60) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function yearOf(timestamp: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(timestamp);
}

/** Day, month and minutes; the year is added only when it differs from the current one. */
export function formatAbsoluteTime(timestamp: number | undefined, options: TimeFormatOptions = {}): string {
  if (!timestamp) return 'unknown';
  const { now = Date.now(), locale, timeZone } = options;
  const sameYear = yearOf(timestamp, timeZone) === yearOf(now, timeZone);
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(timestamp);
}

/** Full date with year and seconds, used where there is room for detail. */
export function formatFullTime(timestamp: number, options: TimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat(options.locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZone: options.timeZone,
  }).format(timestamp);
}

/** Hover text for a run: when it started and when it was last active. */
export function runTimeTitle(run: { startedAt?: number; lastActivityAt?: number }, options: TimeFormatOptions = {}): string {
  const now = options.now ?? Date.now();
  const line = (label: string, timestamp: number | undefined) => timestamp
    ? `${label}: ${formatFullTime(timestamp, options)} (${formatRelative(timestamp, now)})`
    : undefined;
  return [line('Started', run.startedAt), line('Last activity', run.lastActivityAt)].filter(Boolean).join('\n');
}
