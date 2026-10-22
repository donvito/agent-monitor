import type { Agent } from '../shared/types';

/**
 * Input tokens of the given agents and the parts of them read from and written to the prompt cache.
 * `read` and `write` are absent when no usage bucket reports them, as in older logs.
 */
export interface CacheUse { input: number; read?: number; write?: number }

export function cacheUse(agents: readonly Agent[]): CacheUse {
  let input = 0;
  let read: number | undefined;
  let write: number | undefined;
  for (const agent of agents) {
    input += agent.stats.inputTokens;
    for (const usage of agent.tokenUsage ?? []) {
      if (usage.cacheReadTokens !== undefined) read = (read ?? 0) + usage.cacheReadTokens;
      if (usage.cacheWriteTokens !== undefined) write = (write ?? 0) + usage.cacheWriteTokens;
    }
  }
  return { input, ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
}
