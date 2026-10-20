import test from 'node:test';
import assert from 'node:assert/strict';
import { agentLabels } from '../src/renderer/agentLabels';
import type { Agent } from '../src/shared/types';

const agent = (id: string, fields: Partial<Agent> = {}): Agent => ({
  id, runId: 'run', parentId: 'main', harness: 'claude', type: 'subagent', status: 'finished',
  stats: { inputTokens: 0, outputTokens: 0, toolCalls: 0, errors: 0 }, ...fields,
});

test('a role held by one agent is its name', () => {
  const names = agentLabels([agent('main', { type: 'main', parentId: null }), agent('a', { role: 'Explore' }), agent('b', { role: 'web-fetch' })]);
  assert.equal(names.get('a'), 'Subagent · Explore');
  assert.equal(names.get('b'), 'Subagent · web-fetch');
  assert.equal(names.has('main'), false);
});

test('agents sharing a role are numbered in launch order', () => {
  const names = agentLabels([
    agent('c', { role: 'reviewer', createdAt: 3 }),
    agent('a', { role: 'reviewer', createdAt: 1 }),
    agent('b', { role: 'reviewer', createdAt: 2 }),
    agent('d', { role: 'reviewer' }),
  ]);
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => names.get(id)), ['Subagent · reviewer #1', 'Subagent · reviewer #2', 'Subagent · reviewer #3', 'Subagent · reviewer #4']);
});

test('a nickname wins and is not counted among its role', () => {
  const names = agentLabels([agent('a', { role: 'worker', nickname: 'Scout' }), agent('b', { role: 'worker' })]);
  assert.equal(names.get('a'), 'Subagent · Scout');
  assert.equal(names.get('b'), 'Subagent · worker');
});

test('numbering is per run', () => {
  const names = agentLabels([agent('a', { role: 'reviewer' }), agent('b', { role: 'reviewer', runId: 'other' })]);
  assert.equal(names.get('a'), 'Subagent · reviewer');
  assert.equal(names.get('b'), 'Subagent · reviewer');
});

test('agents without a role or nickname get no name', () => {
  assert.equal(agentLabels([agent('a')]).has('a'), false);
});

test('the main agent keeps its own name without the subagent prefix', () => {
  const names = agentLabels([agent('main', { type: 'main', parentId: null, nickname: 'Astra' })]);
  assert.equal(names.get('main'), 'Astra');
});
