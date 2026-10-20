import type { Agent } from '../shared/types';

const launchOrder = (a: Agent, b: Agent) =>
  (a.createdAt ?? Number.POSITIVE_INFINITY) - (b.createdAt ?? Number.POSITIVE_INFINITY) || a.id.localeCompare(b.id);

/**
 * Names agents by their nickname, else by their role, with subagents marked as such
 * (`Subagent · reviewer`). Agents of one run that share a role are numbered in launch
 * order (`Subagent · reviewer #2`); agents with neither get no entry.
 */
export function agentLabels(agents: readonly Agent[]): Map<string, string> {
  const names = new Map<string, string>();
  const label = (agent: Agent, name: string) => agent.type === 'main' ? name : `Subagent · ${name}`;
  const byRole = new Map<string, Agent[]>();
  for (const agent of agents) {
    if (agent.nickname) names.set(agent.id, label(agent, agent.nickname));
    else if (agent.role && agent.type !== 'main') {
      const key = JSON.stringify([agent.runId, agent.role]);
      byRole.set(key, [...(byRole.get(key) ?? []), agent]);
    } else if (agent.role) names.set(agent.id, agent.role);
  }
  for (const group of byRole.values()) {
    group.sort(launchOrder).forEach((agent, index) => {
      names.set(agent.id, label(agent, group.length > 1 ? `${agent.role} #${index + 1}` : agent.role!));
    });
  }
  return names;
}
