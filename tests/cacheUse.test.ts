import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheUse } from '../src/renderer/cacheUse';
import type { Agent, ModelTokenUsage } from '../src/shared/types';

const agent = (usage: ModelTokenUsage[], extraInput = 0): Agent => ({
  id: 'a', runId: 'run', parentId: null, harness: 'claude', type: 'main', status: 'finished', tokenUsage: usage,
  stats: { inputTokens: usage.reduce((n, u) => n + u.inputTokens, 0) + extraInput, outputTokens: 0, toolCalls: 0, errors: 0 },
});
const bucket = (fields: Partial<ModelTokenUsage>): ModelTokenUsage => ({ model: 'm', inputTokens: 0, outputTokens: 0, ...fields });

test('reads and writes add up across agents and buckets', () => {
  assert.deepEqual(cacheUse([
    agent([bucket({ inputTokens: 1000, cacheReadTokens: 900, cacheWriteTokens: 50 }), bucket({ inputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 400 })]),
    agent([bucket({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 100 })]),
  ]), { input: 1600, read: 1000, write: 550 });
});

test('input without a bucket still counts towards the total', () => {
  assert.deepEqual(cacheUse([agent([bucket({ inputTokens: 100, cacheReadTokens: 80, cacheWriteTokens: 0 })], 100)]), { input: 200, read: 80, write: 0 });
});

test('cache reads or writes that no bucket reports stay unknown', () => {
  assert.deepEqual(cacheUse([agent([bucket({ inputTokens: 100, cacheReadTokens: 80 })])]), { input: 100, read: 80 });
  assert.deepEqual(cacheUse([agent([bucket({ inputTokens: 100 })])]), { input: 100 });
  assert.deepEqual(cacheUse([]), { input: 0 });
});
