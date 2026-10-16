import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../src/shared/types';
import { applyRunFilters, DEFAULT_RUN_FILTERS, projectName, projectOptions, RUN_PERIODS, withinPeriod } from '../src/renderer/runFilters';

const DAY = 86_400_000;
const now = Date.UTC(2026, 9, 16, 12);
const run = (id: string, cwd: string | undefined, daysAgo: number): AgentRun => ({ id, harness: 'codex', ...(cwd ? { cwd } : {}), lastActivityAt: now - daysAgo * DAY });

const shopsNew = run('shops-new', '/Users/artem/projects/shops/dev', 2);
const pays = run('pays', '/Users/artem/projects/pays/pays_dev', 10);
const shopsOld = run('shops-old', '/Users/artem/projects/shops/dev', 40);
const otherShops = run('other-shops', '/srv/clients/shops/dev', 5);
const home = run('home', '/Users/artem', 1);
const nowhere = run('nowhere', undefined, 3);

test('periods run from a day to all time, with last month as the default', () => {
  assert.deepEqual(RUN_PERIODS.map((period) => [period.value, period.label]), [
    ['day', 'Last day'], ['week', 'Last week'], ['month', 'Last month'], ['3months', 'Last 3 months'],
    ['6months', 'Last 6 months'], ['year', 'Last year'], ['all', 'All'],
  ]);
  assert.deepEqual(DEFAULT_RUN_FILTERS, { period: 'month', project: 'all' });
  assert.equal(withinPeriod(shopsNew, 'week', now), true);
  assert.equal(withinPeriod(pays, 'week', now), false);
  assert.equal(withinPeriod(shopsOld, 'month', now), false);
  assert.equal(withinPeriod(shopsOld, 'all', now), true);
  // Runs without activity fall back to their start, and runs with neither only appear under All.
  assert.equal(withinPeriod({ id: 's', harness: 'codex', startedAt: now - DAY / 2 }, 'day', now), true);
  assert.equal(withinPeriod({ id: 'x', harness: 'codex' }, 'year', now), false);
});

test('a project is named by the last two parts of the session path', () => {
  assert.equal(projectName('/Users/artem/projects/shops/dev'), 'shops/dev');
  assert.equal(projectName('/Users/artem/projects/shops/dev/'), 'shops/dev');
  assert.equal(projectName('C:\\work\\shops\\dev'), 'shops/dev');
  assert.equal(projectName('/srv'), 'srv');
  assert.equal(projectName(undefined), '—');
});

test('project options count runs per project, newest activity first, with every path behind a name', () => {
  assert.deepEqual(projectOptions([shopsOld, pays, home, shopsNew, otherShops, nowhere]), [
    { name: 'Users/artem', count: 1, paths: ['/Users/artem'] },
    { name: 'shops/dev', count: 3, paths: ['/Users/artem/projects/shops/dev', '/srv/clients/shops/dev'] },
    { name: '—', count: 1, paths: [] },
    { name: 'pays/pays_dev', count: 1, paths: ['/Users/artem/projects/pays/pays_dev'] },
  ]);
});

test('filters combine period and project, and keep the selected run in view', () => {
  const runs = [shopsNew, pays, shopsOld, otherShops, home];
  assert.deepEqual(applyRunFilters(runs, DEFAULT_RUN_FILTERS, now).map((item) => item.id), ['shops-new', 'pays', 'other-shops', 'home']);
  assert.deepEqual(applyRunFilters(runs, { period: 'month', project: 'shops/dev' }, now).map((item) => item.id), ['shops-new', 'other-shops']);
  assert.deepEqual(applyRunFilters(runs, { period: 'all', project: 'shops/dev' }, now).map((item) => item.id), ['shops-new', 'shops-old', 'other-shops']);
  assert.deepEqual(applyRunFilters(runs, { period: 'week', project: 'all' }, now, 'shops-old').map((item) => item.id), ['shops-new', 'shops-old', 'other-shops', 'home']);
});
