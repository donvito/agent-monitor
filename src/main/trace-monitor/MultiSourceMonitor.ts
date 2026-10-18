import { EventEmitter } from 'node:events';
import type { MonitorSnapshot, TraceEntry } from '../../shared/types';

export interface MonitorSource extends EventEmitter {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): MonitorSnapshot;
  loadRun(runId: string): Promise<void>;
  unloadRun(): void;
  getTrace(agentId: string): Promise<TraceEntry[]>;
  /** The title the agent gave a discovered run, if the source knows one. */
  getRunTitle?(runId: string): Promise<string | undefined>;
  /** Names the agent keeps for discovered runs (run id → name). */
  getAgentNames?(): Promise<Record<string, string>>;
}

/** Keeps selection exclusive across file and database sources. */
export class MultiSourceMonitor extends EventEmitter {
  private selectedRunId?: string;
  private selectedSource?: MonitorSource;
  private generation = 0;
  private startPromise?: Promise<void>;

  constructor(private readonly sources: MonitorSource[]) {
    super();
    for (const source of sources) source.on('snapshot', () => this.emit('snapshot', this.snapshot()));
  }

  start(): Promise<void> {
    this.startPromise ??= Promise.all(this.sources.map(source => source.start())).then(() => undefined);
    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.unloadRun();
    await Promise.all(this.sources.map(source => source.stop()));
    this.startPromise = undefined;
  }

  snapshot(): MonitorSnapshot {
    const snapshots = this.sources.map(source => source.snapshot());
    const selected = this.selectedSource?.snapshot();
    const agents = selected?.agents.filter(agent => agent.runId === this.selectedRunId) ?? [];
    const ids = new Set(agents.map(agent => agent.id));
    return {
      runs: [...new Map(snapshots.flatMap(snapshot => snapshot.runs).reverse().map(run => [run.id,run])).values()].sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0)),
      agents,
      edges: selected?.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) ?? [],
      errors: snapshots.flatMap(snapshot => snapshot.errors),
      watching: snapshots.some(snapshot => snapshot.watching),
      ...(this.selectedRunId ? { selectedRunId: this.selectedRunId } : {}),
    };
  }

  async loadRun(runId: string): Promise<void> {
    const generation = ++this.generation;
    await this.start();
    if (generation !== this.generation) return;
    const source = this.sources.find(candidate => candidate.snapshot().runs.some(run => run.id === runId));
    if (!source) throw new Error(`Unknown trace run: ${runId}`);
    this.selectedSource = source;
    this.selectedRunId = runId;
    for (const candidate of this.sources) candidate.unloadRun();
    await source.loadRun(runId);
    if (generation === this.generation) this.emit('snapshot', this.snapshot());
  }

  unloadRun(): void {
    this.generation += 1;
    this.selectedRunId = undefined;
    this.selectedSource = undefined;
    for (const source of this.sources) source.unloadRun();
  }

  async getAgentNames(): Promise<Record<string, string>> {
    const names: Record<string, string> = {};
    for (const source of this.sources) Object.assign(names, await source.getAgentNames?.());
    return names;
  }

  /** Asks every source, since titles are shown for runs that are not loaded. */
  async getRunTitle(runId: string): Promise<string | undefined> {
    for (const source of this.sources) {
      const title = await source.getRunTitle?.(runId);
      if (title) return title;
    }
    return undefined;
  }

  async getTrace(agentId: string): Promise<TraceEntry[]> {
    if (!this.snapshot().agents.some(agent => agent.id === agentId)) return [];
    return this.selectedSource?.getTrace(agentId) ?? [];
  }
}
