import type { AgentRun } from '../shared/types';

const DAY = 86_400_000;

export const RUN_PERIODS = [
  { value: 'day', label: 'Last day', days: 1 },
  { value: 'week', label: 'Last week', days: 7 },
  { value: 'month', label: 'Last month', days: 30 },
  { value: '3months', label: 'Last 3 months', days: 91 },
  { value: '6months', label: 'Last 6 months', days: 182 },
  { value: 'year', label: 'Last year', days: 365 },
  { value: 'all', label: 'All', days: Infinity },
] as const;

export type RunPeriod = (typeof RUN_PERIODS)[number]['value'];

export interface RunFilters {
  period: RunPeriod;
  /** A project name from projectName, or 'all'. */
  project: string;
}

export const DEFAULT_RUN_FILTERS: RunFilters = { period: 'month', project: 'all' };

/** Whether the run was last active within the period; a run with no times only shows under All. */
export function withinPeriod(run: AgentRun, period: RunPeriod, now: number): boolean {
  const days = RUN_PERIODS.find((item) => item.value === period)?.days ?? Infinity;
  if (days === Infinity) return true;
  const activity = run.lastActivityAt ?? run.startedAt;
  return activity !== undefined && activity >= now - days * DAY;
}

/** A project is named by the last two parts of the session's working directory, such as `shops/dev`. */
export function projectName(cwd: string | undefined): string {
  const parts = cwd?.split(/[\\/]/).filter(Boolean) ?? [];
  return parts.length ? parts.slice(-2).join('/') : '—';
}

export interface ProjectOption {
  name: string;
  count: number;
  /** Every working directory behind the name, so the picker can tell same-named projects apart. */
  paths: string[];
}

/** Projects of the runs with their run counts, most recently active first. */
export function projectOptions(runs: readonly AgentRun[]): ProjectOption[] {
  const projects = new Map<string, ProjectOption & { activity: number }>();
  for (const run of runs) {
    const name = projectName(run.cwd);
    const project = projects.get(name) ?? { name, count: 0, paths: [], activity: -Infinity };
    project.count += 1;
    if (run.cwd && !project.paths.includes(run.cwd)) project.paths.push(run.cwd);
    project.activity = Math.max(project.activity, run.lastActivityAt ?? run.startedAt ?? -Infinity);
    projects.set(name, project);
  }
  return [...projects.values()]
    .sort((left, right) => right.activity - left.activity)
    .map(({ name, count, paths }) => ({ name, count, paths }));
}

/** Runs within the period and project, in their order; the selected run always stays. */
export function applyRunFilters(runs: readonly AgentRun[], filters: RunFilters, now: number, keepRunId?: string): AgentRun[] {
  return runs.filter((run) => run.id === keepRunId || (
    withinPeriod(run, filters.period, now)
    && (filters.project === 'all' || projectName(run.cwd) === filters.project)
  ));
}
