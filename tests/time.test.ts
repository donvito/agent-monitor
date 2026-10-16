import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAbsoluteTime, formatFullTime, formatRelative, runTimeTitle } from '../src/renderer/time';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 9, 16, 12, 0, 0);
const format = { now, locale: 'en-GB', timeZone: 'UTC' };

test('relative time grows from seconds to years without unbounded hours', () => {
  const cases: Array<[number | undefined, string]> = [
    [undefined, 'unknown'],
    [now - 2 * SECOND, 'just now'],
    [now + 10 * SECOND, 'just now'],
    [now - 30 * SECOND, '30s ago'],
    [now - 59 * MINUTE - 50 * SECOND, '59m ago'],
    [now - 23 * HOUR - 59 * MINUTE, '23h ago'],
    [now - 26 * HOUR, '1d ago'],
    [now - 13 * DAY, '13d ago'],
    [now - 15 * DAY, '2w ago'],
    [now - 70 * DAY, '2mo ago'],
    [now - 400 * DAY, '1y ago'],
  ];
  for (const [timestamp, expected] of cases) assert.equal(formatRelative(timestamp, now), expected);
});

test('absolute run time shows the year only outside the current year', () => {
  assert.equal(formatAbsoluteTime(Date.UTC(2026, 9, 13, 9, 27, 46), format), '13 Oct, 09:27');
  assert.equal(formatAbsoluteTime(Date.UTC(2025, 9, 13, 9, 27, 46), format), '13 Oct 2025, 09:27');
  assert.equal(formatAbsoluteTime(undefined, format), 'unknown');
});

test('the current year is judged in the display time zone', () => {
  const newYearUtc = Date.UTC(2027, 0, 1, 2, 0, 0);
  const nowInNewYear = Date.UTC(2027, 0, 1, 12, 0, 0);
  // 2 a.m. UTC on Jan 1 is still Dec 31 in New York, which is the previous year there.
  assert.equal(formatAbsoluteTime(newYearUtc, { now: nowInNewYear, locale: 'en-GB', timeZone: 'America/New_York' }), '31 Dec 2026, 21:00');
  assert.equal(formatAbsoluteTime(newYearUtc, { now: nowInNewYear, locale: 'en-GB', timeZone: 'UTC' }), '1 Jan, 02:00');
});

test('full time includes year and seconds', () => {
  assert.equal(formatFullTime(Date.UTC(2026, 9, 13, 9, 27, 46), format), '13 Oct 2026, 09:27:46');
});

test('run time title lists start and last activity with relative time', () => {
  const startedAt = Date.UTC(2026, 9, 13, 9, 27, 46);
  const lastActivityAt = Date.UTC(2026, 9, 16, 10, 0, 0);
  assert.equal(
    runTimeTitle({ startedAt, lastActivityAt }, format),
    'Started: 13 Oct 2026, 09:27:46 (3d ago)\nLast activity: 16 Oct 2026, 10:00:00 (2h ago)',
  );
  assert.equal(runTimeTitle({ startedAt }, format), 'Started: 13 Oct 2026, 09:27:46 (3d ago)');
  assert.equal(runTimeTitle({}, format), '');
});
