import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentRun } from '../src/shared/types';
import { filterRuns, highlightParts, runMatch } from '../src/renderer/runSearch';

const codex: AgentRun = { id: '01a13342-cc1a-7863-985b-aa03329c87d8', harness: 'codex', cwd: '/Users/artem' };
const claude: AgentRun = { id: 'claude:82f0151b-99d9-471b-9ffb-1cd306f34c0f', harness: 'claude', cwd: '/Users/artem/projects/others/agents-task-manager' };
const named: AgentRun = { id: 'abc', harness: 'codex', title: 'Astra', cwd: '/tmp/github-hello' };

test('runs match by session id, with or without the provider prefix', () => {
  assert.deepEqual(runMatch(codex, '01A13342'), { field: 'id', text: codex.id });
  assert.deepEqual(runMatch(codex, '  ID 01a13342-cc1a-7863-985b-aa03329c87d8 '), { field: 'id', text: codex.id });
  assert.deepEqual(runMatch(claude, '82f0151b'), { field: 'id', text: '82f0151b-99d9-471b-9ffb-1cd306f34c0f' });
  assert.deepEqual(runMatch(claude, 'claude:82f0'), { field: 'id', text: claude.id });
});

test('runs match by their shown name or working directory', () => {
  assert.deepEqual(runMatch(named, 'astra'), { field: 'name', text: 'Astra' });
  assert.deepEqual(runMatch(claude, 'agents-task'), { field: 'name', text: 'agents-task-manager' });
  assert.deepEqual(runMatch(named, 'github-hello'), { field: 'path', text: '/tmp/github-hello' });
  assert.equal(runMatch(codex, 'zerocracy'), undefined);
  assert.deepEqual(runMatch(codex, '   '), { field: 'all', text: '' });
});

test('filtering keeps run order and an empty query keeps every run', () => {
  assert.deepEqual(filterRuns([codex, claude, named], 'artem').map((run) => run.id), [codex.id, claude.id]);
  assert.equal(filterRuns([codex, claude], '').length, 2);
});

test('highlight parts split text around every case-insensitive match', () => {
  assert.deepEqual(highlightParts('Agents-Task-agents', 'agents'), [
    { text: 'Agents', match: true },
    { text: '-Task-', match: false },
    { text: 'agents', match: true },
  ]);
  assert.deepEqual(highlightParts('plain', ''), [{ text: 'plain', match: false }]);
});
