import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { watch, type FSWatcher } from 'chokidar';
import type { Agent, AgentRun, MonitorSnapshot, TraceEntry, TracePage, TraceRangeRequest } from '../../shared/types';
import { sliceTraceRange } from '../../shared/traceRange';
import { replaceAgents, type AgentGraphState } from '../../graph/reducer';
import {
  createProviderSession,
  inspectCanonical,
  type ProviderSession,
} from '../../traces/registry';
import type { CodexObservation, TraceRecord } from '../../traces/codex';
import { UsageAccumulator } from '../../traces/usage-accounting';

export interface TraceMonitorOptions {
  roots?: string[];
  idleMs?: number;
}

interface FileState {
  path: string;
  offset: number;
  lineIndex: number;
  pendingText: string;
  discardingOversizedLine: boolean;
  decoder: StringDecoder;
  identity?: string;
  records: TraceRecord[];
  aggregate: CodexAggregate;
  session?: ProviderSession;
  harness?: 'codex' | 'claude' | 'pi' | 'hermes';
  headerEmitted: boolean;
  probe: Array<{ value: unknown; index: number }>;
  probeBytes: number;
  nextCanonicalIndex: number;
  observation?: CodexObservation;
  initialized: boolean;
  mtimeMs?: number;
  /** Keeps every record; used for full reads that serve paged trace ranges. */
  unbounded?: boolean;
}

interface InventoryEntry {
  path: string;
  agent: Agent;
  mtimeMs: number;
  size: number;
  identity?: string;
}

interface FileSignature {
  size: number;
  mtimeMs: number;
  identity?: string;
}

interface HeaderProbe {
  records: TraceRecord[];
  session?: ProviderSession;
  harness?: 'codex' | 'claude' | 'pi' | 'hermes';
}

interface CodexAggregate {
  toolIds: Set<string>;
  anonymousToolCalls: number;
  errorKeys: Set<string>;
  latestTotal?: { input: number; output: number };
  turnUsage: Map<string, { input: number; output: number }>;
  latestLastUsage?: { input: number; output: number };
  currentTurnId?: string;
  model?: string;
  provider?: string;
  reasoningEffort?: string;
  cwd?: string;
  terminal?: 'finished' | 'error';
  terminalIndex?: number;
  lastActivityIndex?: number;
  lastTimestamp?: number;
  usage: UsageAccumulator;
}

const READ_CHUNK_BYTES = 64 * 1024;
const HEADER_READ_CHUNK_BYTES = 8 * 1024;
const INITIAL_READ_CONCURRENCY = 8;
const MAX_PARSED_RECORDS = 512;
const MAX_MONITOR_TRACE_ENTRIES = 200;
/** Full traces kept in memory for paged reading, least recently used first out. */
const MAX_FULL_TRACES = 4;
const MAX_PENDING_TEXT = 2 * 1024 * 1024;
const MAX_RAW_PROBE_RECORDS = 128;
const MAX_RAW_PROBE_BYTES = 2 * 1024 * 1024;
const MAX_MONITOR_ERRORS = 100;

const CODEX_TOOL_CALL_TYPES = new Set([
  'function_call', 'custom_tool_call', 'local_shell_call', 'computer_call',
  'web_search_call', 'tool_call', 'mcp_tool_call',
]);
const CODEX_TOOL_RESULT_TYPES = new Set([
  'function_call_output', 'custom_tool_call_output', 'local_shell_call_output',
  'computer_call_output', 'web_search_call_output', 'tool_call_output',
  'web_search_tool_result', 'mcp_tool_result',
]);
const CODEX_COMPLETION_TYPES = new Set([
  'task_complete', 'task_completed', 'turn_complete', 'turn_completed',
  'turn_complete_success', 'session_complete', 'session_completed', 'completed',
  'shutdown', 'done',
]);
const CODEX_ERROR_TYPES = new Set([
  'error', 'turn_aborted', 'turn_failed', 'task_failed', 'session_error', 'fatal_error',
]);

function createAggregate(): CodexAggregate {
  return {
    toolIds: new Set(),
    anonymousToolCalls: 0,
    errorKeys: new Set(),
    turnUsage: new Map(),
    usage: new UsageAccumulator(),
  };
}

function cloneAgent(agent: Agent): Agent {
  return {
    ...agent,
    stats: { ...agent.stats },
    ...(agent.tokenUsage ? { tokenUsage: agent.tokenUsage.map((usage) => ({ ...usage })) } : {}),
    ...(agent.tokenTimeline ? { tokenTimeline: agent.tokenTimeline.map((sample) => ({ ...sample })) } : {}),
  };
}

function cloneSnapshot(snapshot: MonitorSnapshot): MonitorSnapshot {
  return {
    agents: snapshot.agents.map(cloneAgent),
    runs: snapshot.runs.map((run) => ({ ...run })),
    edges: snapshot.edges.map((edge) => ({ ...edge })),
    watching: snapshot.watching,
    errors: [...snapshot.errors],
    ...(snapshot.selectedRunId ? { selectedRunId: snapshot.selectedRunId } : {}),
  };
}

function isTraceFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.jsonl');
}

function statIdentity(stat: { dev?: number; ino?: number }): string | undefined {
  if (stat.dev === undefined && stat.ino === undefined) return undefined;
  return `${stat.dev ?? ''}:${stat.ino ?? ''}`;
}

function sleepYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isSessionMeta(value: unknown): boolean {
  return objectValue(value)?.type === 'session_meta';
}

function isCodexHeader(value: unknown): boolean {
  const object = objectValue(value);
  if (!object || object.type !== 'session_meta') return false;
  return objectValue(object.payload) !== undefined;
}

function unwrapRecordValue(value: unknown): unknown {
  const object = objectValue(value);
  if (!object || !Object.prototype.hasOwnProperty.call(object, 'value')) return value;
  if (Object.prototype.hasOwnProperty.call(object, 'index') || Object.prototype.hasOwnProperty.call(object, 'raw')) {
    return object.value;
  }
  return value;
}

function estimateValueBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

function looksLikeOversizedCodexHeader(value: string): boolean {
  if (!value) return false;
  const sample = value.slice(0, 256 * 1024).toLowerCase();
  return /"type"\s*:\s*"session_meta"/.test(sample)
    && /"payload"\s*:\s*\{/.test(sample)
    && (sample.includes('"session_id"') || sample.includes('"sessionid"') || sample.includes('"cwd"') || sample.includes('"id"'));
}

function textValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function finiteValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
  }
  return undefined;
}

function recordTimestamp(value: Record<string, unknown>, payload: Record<string, unknown>): number | undefined {
  const candidate = value.timestamp ?? payload.timestamp;
  const numeric = finiteValue(candidate);
  if (numeric !== undefined) return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  if (typeof candidate === 'string') {
    const parsed = Date.parse(candidate);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function usage(value: unknown): { input?: number; output?: number } {
  const object = objectValue(value);
  if (!object) return {};
  const input = finiteValue(object.input_tokens ?? object.inputTokens ?? object.input ?? object.prompt_tokens);
  const output = finiteValue(object.output_tokens ?? object.outputTokens ?? object.output ?? object.completion_tokens);
  return { input, output };
}

/**
 * Watches Codex rollout files and exposes a normalized graph snapshot.
 * Files are read by byte offset; a StringDecoder and retained line suffix
 * make writes split across UTF-8 code points or JSON lines safe.
 */
/** A trace file read in full for paged ranges, kept with its reader state so appends parse incrementally. */
interface FullTrace {
  state: FileState;
  mtimeMs: number;
  entries: TraceEntry[];
}

function createFileState(filePath: string, identity: string | undefined, unbounded = false): FileState {
  return {
    path: filePath,
    offset: 0,
    lineIndex: 0,
    pendingText: '',
    discardingOversizedLine: false,
    decoder: new StringDecoder('utf8'),
    identity,
    records: [],
    aggregate: createAggregate(),
    headerEmitted: false,
    probe: [],
    probeBytes: 0,
    nextCanonicalIndex: 0,
    initialized: false,
    ...(unbounded ? { unbounded } : {}),
  };
}

export class TraceMonitor extends EventEmitter {
  private readonly roots: string[];
  private readonly idleMs: number;
  private readonly files = new Map<string, FileState>();
  private readonly inventory = new Map<string, InventoryEntry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly observedSignatures = new Map<string, FileSignature>();
  private readonly traces = new Map<string, TraceEntry[]>();
  private readonly fullTraces = new Map<string, FullTrace>();
  // One full read per file at a time, so concurrent range requests share it.
  private readonly fullTraceReads = new Map<string, Promise<TraceEntry[]>>();
  private readonly errors: string[] = [];
  private watcher?: FSWatcher;
  private idleTimer?: NodeJS.Timeout;
  private started = false;
  private selectedRunId?: string;
  private selectionGeneration = 0;
  private startPromise?: Promise<void>;
  private graph: AgentGraphState = { agents: [], runs: [], edges: [] };
  private catalogRuns: AgentRun[] = [];
  private currentSnapshot: MonitorSnapshot = {
    agents: [],
    runs: [],
    edges: [],
    watching: false,
    errors: [],
  };

  constructor(options: TraceMonitorOptions = {}) {
    super();
    this.roots = (options.roots !== undefined ? options.roots : defaultTraceRoots()).map((root) => path.resolve(root));
    this.idleMs = Number.isFinite(options.idleMs) && (options.idleMs ?? 0) > 0 ? options.idleMs as number : 30_000;
  }

  async start(): Promise<void> {
    if (this.started) return this.startPromise ?? Promise.resolve();
    this.started = true;
    this.currentSnapshot = { ...this.currentSnapshot, watching: true };
    this.startPromise = this.startInternal();
    await this.startPromise;
  }

  private async startInternal(): Promise<void> {
    try {
      let result = await this.openWatcher(false);
      if (result.error && isTooManyFiles(result.error)) {
        await result.watcher.close().catch(() => undefined);
        this.watcher = undefined;
        result = await this.openWatcher(true);
      }
      if (result.error && !isTooManyFiles(result.error)) {
        this.recordError(`watch: ${formatError(result.error)}`, false);
      }
    } catch (error) {
      this.recordError(`start: ${formatError(error)}`, false);
    }

    const paths = await this.findTraceFiles();
    for (let index = 0; index < paths.length; index += INITIAL_READ_CONCURRENCY) {
      if (!this.started) return;
      const batch = paths.slice(index, index + INITIAL_READ_CONCURRENCY);
      await Promise.all(batch.map((filePath) => this.enqueueInventory(filePath, false)));
      // Avoid monopolizing the event loop when a home directory contains a
      // large historical trace set.
      await sleepYield();
      if (this.started && (index === 0 || index % (INITIAL_READ_CONCURRENCY * 4) === 0)) {
        this.refreshIdleStatuses();
        this.publishSnapshot();
      }
    }

    if (!this.started) return;
    this.refreshIdleStatuses();
    this.publishSnapshot();
    const intervalMs = Math.max(50, Math.min(this.idleMs, 1_000));
    this.idleTimer = setInterval(() => {
      if (!this.started) return;
      if (this.refreshIdleStatuses()) this.publishSnapshot();
    }, intervalMs);
    this.idleTimer.unref?.();
  }

  private async openWatcher(usePolling: boolean): Promise<{ watcher: FSWatcher; error?: unknown }> {
    const watcher = watch(this.roots, {
      ignoreInitial: true,
      persistent: true,
      usePolling,
      ...(usePolling ? { interval: 500, binaryInterval: 500 } : {}),
      ignorePermissionErrors: true,
      awaitWriteFinish: false,
    });
    this.watcher = watcher;
    watcher.on('add', (filePath) => {
      if (isTraceFile(filePath)) void this.enqueueObserved(filePath);
    });
    watcher.on('change', (filePath) => {
      if (isTraceFile(filePath)) void this.enqueueObserved(filePath);
    });
    watcher.on('unlink', (filePath) => {
      if (isTraceFile(filePath)) void this.enqueueDelete(filePath);
    });
    if (process.platform === 'win32') {
      // Windows writers can keep mtime unchanged until closing their handle.
      // Chokidar filters these changes when atime is newer, even if size grew.
      // Its raw notification still arrives; reconcile it through the same queue.
      watcher.on('raw', (event, filePath, details: unknown) => {
        if (event !== 'change' || !this.started || this.watcher !== watcher) return;
        const watchedPath = objectValue(details)?.watchedPath;
        let candidate: string | undefined;
        if (typeof filePath === 'string' && path.isAbsolute(filePath)) candidate = filePath;
        else if (typeof watchedPath === 'string' && path.isAbsolute(watchedPath)) {
          if (isTraceFile(watchedPath)) candidate = watchedPath;
          else if (typeof filePath === 'string') candidate = path.join(watchedPath, filePath);
        }
        if (!candidate || !isTraceFile(candidate)) return;
        const normalized = path.resolve(candidate);
        if (!this.roots.some(root => {
          const relative = path.relative(root, normalized);
          return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
        })) return;
        void this.enqueueObserved(normalized);
      });
    }
    // The ready/error wait below owns EMFILE fallback. Other errors are
    // surfaced immediately while the watcher remains usable if possible.
    watcher.on('error', (error) => {
      if (!isTooManyFiles(error)) this.recordError(`watch: ${formatError(error)}`, true);
    });
    const error = await new Promise<unknown | undefined>((resolve) => {
      let settled = false;
      const finish = (value?: unknown) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      watcher.once('ready', () => finish());
      watcher.once('error', (value) => finish(value));
    });
    return { watcher, error };
  }

  async stop(): Promise<void> {
    if (!this.started && !this.watcher) return;
    this.started = false;
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    if (watcher) {
      try {
        await watcher.close();
      } catch (error) {
        this.recordError(`stop: ${formatError(error)}`, false);
      }
    }
    await Promise.allSettled(Array.from(this.queues.values()));
    this.observedSignatures.clear();
    this.currentSnapshot = { ...this.currentSnapshot, watching: false };
    this.publishSnapshot();
    this.startPromise = undefined;
  }

  /** Release the selected run while keeping the inventory available. */
  unloadRun(): void {
    this.selectedRunId = undefined;
    this.releaseLoadedRun();
    this.rebuildInventoryRuns();
    this.publishSnapshot();
  }

  /** Load the full traces belonging to one inventory run on demand. */
  async loadRun(runId: string): Promise<void> {
    // Claim the load request before awaiting startup. A concurrent unload or
    // newer selection then invalidates this request even if startup is still
    // draining the initial inventory scan.
    const requestGeneration = ++this.selectionGeneration;
    if (!this.started) await this.start();
    if (this.startPromise) await this.startPromise;
    if (requestGeneration !== this.selectionGeneration) return;
    this.rebuildInventoryRuns();
    const entries = Array.from(this.inventory.values()).filter((entry) => entry.agent.runId === runId);
    if (!entries.length) throw new Error(`Unknown trace run: ${runId}`);
    if (this.selectedRunId !== runId) {
      this.releaseLoadedRun();
      this.selectedRunId = runId;
      this.publishSnapshot();
    }
    const generation = this.selectionGeneration;
    for (let index = 0; index < entries.length; index += INITIAL_READ_CONCURRENCY) {
      const batch = entries.slice(index, index + INITIAL_READ_CONCURRENCY);
      await Promise.all(batch.map((entry) => this.enqueueFull(entry.path, false, generation)));
      if (generation !== this.selectionGeneration) return;
      if (this.started && (index === 0 || index % (INITIAL_READ_CONCURRENCY * 4) === 0)) this.publishSnapshot();
    }
    if (generation !== this.selectionGeneration) return;
    this.rebuildGraph();
    this.publishSnapshot();
  }

  snapshot(): MonitorSnapshot {
    if (this.refreshIdleStatuses()) this.currentSnapshot = this.makeSnapshot();
    return cloneSnapshot(this.currentSnapshot);
  }

  async getTrace(agentId: string): Promise<TraceEntry[]> {
    const entries = this.traces.get(agentId);
    if (entries) return entries.map((entry) => ({ ...entry }));
    for (const state of this.files.values()) {
      if (state.observation?.agent.id === agentId) return state.observation.entries.map((entry) => ({ ...entry }));
    }
    return [];
  }

  /** A page of an agent's whole trace, read from its file without the bounded window. */
  async getTraceRange(agentId: string, request: TraceRangeRequest): Promise<TracePage> {
    const tracePath = [...this.files.values()].find((state) => state.observation?.agent.id === agentId)?.path;
    const entries = tracePath ? await this.readFullTrace(tracePath) : await this.getTrace(agentId);
    return sliceTraceRange(entries, request);
  }

  private readFullTrace(tracePath: string): Promise<TraceEntry[]> {
    const previous = this.fullTraceReads.get(tracePath) ?? Promise.resolve([]);
    const read = previous.catch(() => []).then(() => this.updateFullTrace(tracePath));
    this.fullTraceReads.set(tracePath, read);
    void read.finally(() => {
      if (this.fullTraceReads.get(tracePath) === read) this.fullTraceReads.delete(tracePath);
    }).catch(() => undefined);
    return read;
  }

  /** Brings the cached full trace up to date, parsing only bytes appended since the last read. */
  private async updateFullTrace(tracePath: string): Promise<TraceEntry[]> {
    const stat = await fs.stat(tracePath);
    const identity = statIdentity(stat);
    let cached = this.fullTraces.get(tracePath);
    this.fullTraces.delete(tracePath);
    const appendedOnly = cached
      && cached.state.identity === identity
      && (stat.size > cached.state.offset || (stat.size === cached.state.offset && stat.mtimeMs === cached.mtimeMs));
    if (!cached || !appendedOnly) {
      cached = { state: createFileState(tracePath, identity, true), mtimeMs: stat.mtimeMs, entries: [] };
    }
    if (stat.size > cached.state.offset || !cached.entries.length) {
      await this.readDelta(cached.state, stat.size);
      cached.entries = inspectCanonical(cached.state.records, { tracePath, maxEntries: Infinity })?.entries ?? [];
    }
    cached.mtimeMs = stat.mtimeMs;
    this.fullTraces.set(tracePath, cached);
    for (const oldest of this.fullTraces.keys()) {
      if (this.fullTraces.size <= MAX_FULL_TRACES) break;
      this.fullTraces.delete(oldest);
    }
    return cached.entries;
  }

  private async findTraceFiles(): Promise<string[]> {
    const files: string[] = [];
    for (const root of this.roots) {
      let rootStat;
      try {
        rootStat = await fs.stat(root);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') this.recordError(`scan ${root}: ${formatError(error)}`, false);
        continue;
      }
      if (rootStat.isFile()) {
        if (isTraceFile(root)) files.push(root);
        continue;
      }
      if (!rootStat.isDirectory()) continue;
      const pending = [root];
      while (pending.length) {
        const directory = pending.pop()!;
        let entries;
        try {
          entries = await fs.readdir(directory, { withFileTypes: true });
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') this.recordError(`scan ${directory}: ${formatError(error)}`, false);
          continue;
        }
        for (const entry of entries) {
          if (!entry.name || entry.name.startsWith('.')) continue;
          const fullPath = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(fullPath);
          else if (entry.isFile() && isTraceFile(fullPath)) files.push(fullPath);
        }
        if (pending.length % 32 === 0) await sleepYield();
      }
    }
    // Codex uses date based session directories, so reverse lexical order is
    // a useful newest-first approximation without stat'ing every file twice.
    files.sort((left, right) => right.localeCompare(left));
    return files;
  }

  private enqueueInventory(filePath: string, publish: boolean): Promise<void> {
    return this.enqueueOperation(filePath, () => this.processInventory(filePath, publish), publish);
  }

  private enqueueFull(filePath: string, publish: boolean, generation?: number): Promise<void> {
    return this.enqueueOperation(filePath, () => this.processFile(filePath, publish, generation), publish);
  }

  private enqueueObserved(filePath: string): Promise<void> {
    return this.enqueueOperation(filePath, async () => {
      if (!this.started) return;
      const normalized = path.resolve(filePath);
      let stat;
      try {
        stat = await fs.stat(normalized);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          await this.removeFile(normalized);
          return;
        }
        throw error;
      }
      if (!stat.isFile()) return;
      const signature = { size: stat.size, mtimeMs: stat.mtimeMs, identity: statIdentity(stat) };
      const loaded = this.files.get(normalized);
      const previous = this.observedSignatures.get(normalized)
        ?? (loaded ? { size: loaded.offset, mtimeMs: loaded.mtimeMs, identity: loaded.identity } : this.inventory.get(normalized));
      // De-duplicate normal/raw events, including access-time-only notifications.
      // Remember incomplete headers too, so reading them cannot cause a loop.
      if (previous && previous.size === signature.size && previous.mtimeMs === signature.mtimeMs && previous.identity === signature.identity) return;
      this.observedSignatures.set(normalized, signature);
      const generation = this.selectionGeneration;
      try {
        if (this.files.has(normalized)) {
          await this.processFile(normalized, true, generation);
          return;
        }
        await this.processInventory(normalized, true);
        const entry = this.inventory.get(normalized);
        if (entry && this.selectedRunId && entry.agent.runId === this.selectedRunId) {
          await this.processFile(normalized, true, this.selectionGeneration);
        }
      } catch (error) {
        this.observedSignatures.delete(normalized);
        throw error;
      }
    }, true);
  }

  private enqueueOperation(filePath: string, operation: () => Promise<void>, publish: boolean): Promise<void> {
    const normalized = path.resolve(filePath);
    const previous = this.queues.get(normalized) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => this.recordError(`read ${normalized}: ${formatError(error)}`, publish));
    this.queues.set(normalized, next);
    void next.finally(() => {
      if (this.queues.get(normalized) === next) this.queues.delete(normalized);
    });
    return next;
  }

  private enqueueDelete(filePath: string): Promise<void> {
    const normalized = path.resolve(filePath);
    const previous = this.queues.get(normalized) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.removeFile(normalized))
      .catch((error) => this.recordError(`delete ${normalized}: ${formatError(error)}`, true));
    this.queues.set(normalized, next);
    void next.finally(() => {
      if (this.queues.get(normalized) === next) this.queues.delete(normalized);
    });
    return next;
  }

  private async processInventory(filePath: string, publish: boolean): Promise<void> {
    const normalized = path.resolve(filePath);
    let stat;
    try {
      stat = await fs.stat(normalized);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        await this.removeFile(normalized, publish);
        return;
      }
      throw error;
    }
    if (!stat.isFile()) return;
    const identity = statIdentity(stat);
    const previous = this.inventory.get(normalized);
    if (previous && previous.identity === identity && previous.size === stat.size) {
      previous.mtimeMs = stat.mtimeMs;
      previous.agent.lastActivityAt = Math.max(previous.agent.lastActivityAt ?? 0, stat.mtimeMs);
      this.rebuildInventoryRuns();
      if (publish) this.publishSnapshot();
      return;
    }
    const header = await this.readHeaderRecords(normalized, MAX_PENDING_TEXT);
    if (!header.records.length) return;
    const observation = inspectCanonical(header.records, { tracePath: normalized });
    if (!observation) return;
    const changed = previous !== undefined && (previous.size !== stat.size || previous.identity !== identity);
    const agent = this.applyFreshness(observation.agent, stat.mtimeMs, changed, observation);
    agent.lastActivityAt = Math.max(agent.lastActivityAt ?? 0, previous?.agent.lastActivityAt ?? 0, stat.mtimeMs);
    // Inventory metadata is intentionally compact. Full timeline/statistics
    // are recomputed by processFile after loadRun selects this run.
    agent.stats = { inputTokens: 0, outputTokens: 0, toolCalls: 0, errors: 0 };
    this.inventory.set(normalized, {
      path: normalized,
      agent: previous?.agent && previous.agent.id === agent.id
        ? { ...previous.agent, ...agent, stats: { ...agent.stats } }
        : agent,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      identity,
    });
    this.rebuildInventoryRuns();
    if (publish) this.publishSnapshot();
  }

  private async readHeaderRecords(filePath: string, maxBytes: number): Promise<HeaderProbe> {
    const handle = await fs.open(filePath, 'r');
    try {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let offset = 0;
      let lineIndex = 0;
      while (offset < maxBytes) {
        const length = Math.min(HEADER_READ_CHUNK_BYTES, maxBytes - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        while (true) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const raw = pending.slice(0, newline).replace(/\r$/, '');
          pending = pending.slice(newline + 1);
          const index = lineIndex++;
          const trimmed = raw.trim();
          if (!trimmed) continue;
          try {
            const value = JSON.parse(trimmed) as unknown;
            const result = this.headerProbe(value, path.resolve(filePath), index);
            if (result) return result;
          } catch {
            // Ignore malformed lines while looking for the metadata record.
          }
        }
      }
      // A complete metadata record need not end with a newline. Incomplete
      // records are retried on the next filesystem change.
      if (pending.trim()) {
        try {
          const value: unknown = JSON.parse(pending);
          const result = this.headerProbe(value, path.resolve(filePath), lineIndex);
          if (result) return result;
        } catch { /* Partial write; keep discovery retryable. */ }
      }
      // Unknown files can contain arbitrarily long JSON lines. Only report an
      // oversized discovery header when the bytes actually resemble Codex
      // metadata; otherwise leave the file invisible and error-free.
      if (offset >= maxBytes && looksLikeOversizedCodexHeader(pending)) {
        throw new Error(`Session metadata exceeds the ${maxBytes / 1024} KiB discovery limit`);
      }
      return { records: [] };
    } finally {
      await handle.close();
    }
  }

  private headerProbe(value: unknown, filePath: string, index: number): HeaderProbe | undefined {
    if (isCodexHeader(value)) {
      return { records: [{ value, index }], harness: 'codex' };
    }
    const session = createProviderSession(value, filePath);
    if (!session) return undefined;
    return {
      records: [{ value: session.header, index: 0 }],
      session,
      harness: session.harness,
    };
  }

  private async processFile(filePath: string, publish: boolean, generation?: number): Promise<void> {
    const normalized = path.resolve(filePath);
    const selectionIsCurrent = () => generation === undefined || (
      generation === this.selectionGeneration
      && this.selectedRunId !== undefined
      && this.inventory.get(normalized)?.agent.runId === this.selectedRunId
    );
    if (!selectionIsCurrent()) return;
    let stat;
    try {
      stat = await fs.stat(normalized);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        await this.removeFile(normalized, publish);
        return;
      }
      throw error;
    }
    if (!stat.isFile()) return;
    if (!selectionIsCurrent()) return;

    let state = this.files.get(normalized);
    const identity = statIdentity(stat);
    const reset = !state || stat.size < state.offset || (identity !== undefined && state.identity !== undefined && identity !== state.identity);
    if (!state || reset) {
      const hadObservation = !!state?.observation;
      if (state?.observation) this.removeObservation(state.observation.agent.id);
      state = createFileState(normalized, identity);
      this.files.set(normalized, state);
      if (hadObservation) {
        this.rebuildGraph();
        if (publish) this.publishSnapshot();
      }
    }

    const bytesRead = await this.readDelta(state, stat.size);
    if (!selectionIsCurrent()) {
      // A run switch can happen while the file is being read. Do not leave a
      // stale state behind, and never remove a newer state installed by the
      // next selection for the same path.
      if (this.files.get(normalized) === state) this.files.delete(normalized);
      return;
    }
    state.mtimeMs = stat.mtimeMs;
    if (!state.records.length) {
      if (publish && bytesRead > 0) this.publishSnapshot();
      return;
    }
    const observation = inspectCanonical(state.records, {
      tracePath: normalized,
      previous: state.observation?.agent,
    });
    if (!observation) {
      if (publish && bytesRead > 0) this.publishSnapshot();
      return;
    }

    this.applyAggregate(observation, state.aggregate);
    const wasInitialized = state.initialized;
    const agent = this.applyFreshness(observation.agent, stat.mtimeMs, wasInitialized && bytesRead > 0, observation);
    const previousId = state.observation?.agent.id;
    const entries = observation.entries.slice(-MAX_MONITOR_TRACE_ENTRIES).map((entry) => ({ ...entry }));
    state.observation = { ...observation, entries, agent };
    state.initialized = true;
    if (previousId && previousId !== agent.id) this.removeObservation(previousId);
    this.traces.set(agent.id, entries);
    if (!selectionIsCurrent()) {
      if (this.files.get(normalized) === state) this.files.delete(normalized);
      return;
    }
    this.inventory.set(normalized, {
      path: normalized,
      agent: { ...agent, stats: { ...agent.stats } },
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      identity,
    });
    this.rebuildInventoryRuns();
    this.rebuildGraph();
    if (publish) this.publishSnapshot();
  }

  private applyAggregate(observation: CodexObservation, aggregate: CodexAggregate): void {
    const usage = aggregate.latestTotal ?? (() => {
      let input = 0;
      let output = 0;
      for (const value of aggregate.turnUsage.values()) {
        input += value.input;
        output += value.output;
      }
      if (!aggregate.turnUsage.size && aggregate.latestLastUsage) return aggregate.latestLastUsage;
      return { input, output };
    })();
    const accountedTotals = aggregate.usage.totals();
    observation.agent.stats = {
      inputTokens: Math.max(observation.agent.stats.inputTokens, usage.input, accountedTotals.inputTokens),
      outputTokens: Math.max(observation.agent.stats.outputTokens, usage.output, accountedTotals.outputTokens),
      toolCalls: Math.max(observation.agent.stats.toolCalls, aggregate.toolIds.size + aggregate.anonymousToolCalls),
      errors: Math.max(observation.agent.stats.errors, aggregate.errorKeys.size),
    };
    const usageSnapshot = aggregate.usage.snapshot();
    if (usageSnapshot.tokenUsage.length) observation.agent.tokenUsage = usageSnapshot.tokenUsage;
    else delete observation.agent.tokenUsage;
    if (usageSnapshot.tokenTimeline.length) observation.agent.tokenTimeline = usageSnapshot.tokenTimeline;
    else delete observation.agent.tokenTimeline;
    if (aggregate.model) observation.agent.model = aggregate.model;
    if (aggregate.provider) observation.agent.provider = aggregate.provider;
    if (aggregate.reasoningEffort) observation.agent.reasoningEffort = aggregate.reasoningEffort;
    if (aggregate.cwd) observation.agent.cwd = aggregate.cwd;
    if (aggregate.lastTimestamp !== undefined) observation.lastTimestamp = aggregate.lastTimestamp;
    observation.completed = aggregate.terminal === 'finished';
    observation.failed = aggregate.terminal === 'error';
    if (observation.completed) observation.agent.status = 'finished';
    else if (observation.failed) observation.agent.status = 'error';
  }

  private async readDelta(state: FileState, size: number): Promise<number> {
    if (size <= state.offset) return 0;
    const handle = await fs.open(state.path, 'r');
    let position = state.offset;
    let bytesRead = 0;
    try {
      while (position < size) {
        const length = Math.min(READ_CHUNK_BYTES, size - position);
        const buffer = Buffer.allocUnsafe(length);
        const result = await handle.read(buffer, 0, length, position);
        if (!result.bytesRead) break;
        position += result.bytesRead;
        bytesRead += result.bytesRead;
        state.pendingText += state.decoder.write(buffer.subarray(0, result.bytesRead));
        this.consumeLines(state);
      }
      state.offset = position;
      this.consumeCompleteFinalLine(state);
      return bytesRead;
    } finally {
      await handle.close();
    }
  }

  private consumeLines(state: FileState): void {
    while (true) {
      if (state.discardingOversizedLine) {
        const discardedNewline = state.pendingText.indexOf('\n');
        if (discardedNewline < 0) return;
        state.pendingText = state.pendingText.slice(discardedNewline + 1);
        state.lineIndex += 1;
        state.discardingOversizedLine = false;
      }
      const newline = state.pendingText.indexOf('\n');
      if (newline < 0) {
        if (state.pendingText.length > MAX_PENDING_TEXT) {
          state.pendingText = '';
          state.discardingOversizedLine = true;
        }
        return;
      }
      const raw = state.pendingText.slice(0, newline).replace(/\r$/, '');
      state.pendingText = state.pendingText.slice(newline + 1);
      const index = state.lineIndex++;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const value = JSON.parse(trimmed) as unknown;
        this.consumeValue(state, value, index, Buffer.byteLength(raw, 'utf8'));
      } catch {
        // A complete malformed line should not block later valid records.
      }
      if (state.pendingText.length > MAX_PENDING_TEXT) {
        state.pendingText = '';
        state.discardingOversizedLine = true;
      }
    }
  }

  private consumeCompleteFinalLine(state: FileState): void {
    if (state.discardingOversizedLine) return;
    const trimmed = state.pendingText.trim();
    if (!trimmed) return;
    try {
      const value = JSON.parse(trimmed) as unknown;
      const index = state.lineIndex++;
      this.consumeValue(state, value, index, Buffer.byteLength(trimmed, 'utf8'));
      state.pendingText = '';
    } catch {
      // Leave an incomplete final JSON object for the next append. This also
      // avoids turning a partial write into a parse error event.
    }
  }

  /**
   * Convert one raw provider record into canonical records before folding
   * metrics and applying the bounded in-memory window.
   */
  private consumeValue(state: FileState, value: unknown, index: number, byteLength: number): void {
    if (!state.harness) {
      state.probe.push({ value, index });
      state.probeBytes += Math.max(0, byteLength);
      const session = createProviderSession(value, state.path);
      if (isCodexHeader(value)) {
        state.harness = 'codex';
      } else if (session) {
        state.session = session;
        state.harness = session.harness;
      }
      if (!state.harness) {
        while (state.probe.length > MAX_RAW_PROBE_RECORDS || state.probeBytes > MAX_RAW_PROBE_BYTES) {
          const discarded = state.probe.shift();
          if (!discarded) break;
          state.probeBytes = Math.max(0, state.probeBytes - estimateValueBytes(discarded.value));
        }
        return;
      }

      const pending = state.probe;
      state.probe = [];
      state.probeBytes = 0;
      if (state.session?.header !== undefined) this.appendCanonical(state, state.session.header);
      for (const record of pending) this.normalizeValue(state, record.value, record.index);
      return;
    }

    this.normalizeValue(state, value, index);
  }

  private normalizeValue(state: FileState, value: unknown, index: number): void {
    if (!state.session) {
      this.appendCanonical(state, value, index);
      return;
    }
    const normalized = state.session.normalize(value, index);
    const values = Array.isArray(normalized) ? normalized : [normalized];
    for (const normalized of values) this.appendCanonical(state, normalized);
  }

  private appendCanonical(state: FileState, value: unknown, rawIndex?: number): void {
    if (value === undefined || value === null) return;
    const canonicalValue = unwrapRecordValue(value);
    if (canonicalValue === undefined || canonicalValue === null) return;
    // Provider sessions expose a canonical header separately. Some session
    // normalizers also return it for their first raw line; retain one copy so
    // the header cannot consume the bounded history budget twice.
    if (state.session && state.headerEmitted && isSessionMeta(canonicalValue)) return;
    const index = state.harness === 'codex'
      ? (rawIndex ?? state.nextCanonicalIndex)
      : state.nextCanonicalIndex;
    if (state.harness === 'codex') state.nextCanonicalIndex = Math.max(state.nextCanonicalIndex, index + 1);
    else state.nextCanonicalIndex += 1;
    const record: TraceRecord = { value: canonicalValue, index };
    state.records.push(record);
    if (isSessionMeta(canonicalValue)) state.headerEmitted = true;
    this.foldRecord(state, record);
    this.boundRecords(state);
  }

  /** Fold metrics and lifecycle evidence before the bounded record window is trimmed. */
  private foldRecord(state: FileState, record: TraceRecord): void {
    const value = objectValue(record.value);
    if (!value) return;
    const payload = objectValue(value.payload) ?? {};
    const outerType = textValue(value.type)?.toLowerCase();
    const innerType = textValue(payload.type)?.toLowerCase();
    const type = innerType ?? outerType;
    const index = record.index ?? state.lineIndex;
    const aggregate = state.aggregate;
    // Usage accounting is intentionally independent of the bounded canonical
    // record window. It sees every record before boundRecords can evict it.
    aggregate.usage.add(record.value, record.index);
    const lineTimestamp = recordTimestamp(value, payload);
    if (lineTimestamp !== undefined) aggregate.lastTimestamp = Math.max(aggregate.lastTimestamp ?? lineTimestamp, lineTimestamp);

    const markActivity = () => {
      aggregate.lastActivityIndex = index;
      if (aggregate.terminalIndex !== undefined && index > aggregate.terminalIndex) {
        aggregate.terminal = undefined;
        aggregate.terminalIndex = undefined;
      }
    };
    const markTerminal = (terminal: 'finished' | 'error') => {
      aggregate.terminal = terminal;
      aggregate.terminalIndex = index;
    };
    const markError = (key: string) => {
      aggregate.errorKeys.add(key);
      markTerminal('error');
    };
    const ids = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const found = textValue(payload[key]);
        if (found) return found;
      }
      return undefined;
    };

    if (outerType === 'event_msg') {
      if (type === 'task_started' || type === 'turn_started') {
        aggregate.currentTurnId = ids(['turn_id', 'turnId', 'id']) ?? `line-${index}`;
        markActivity();
        return;
      }
      if (type === 'token_count') {
        const info = objectValue(payload.info) ?? payload;
        const total = usage(info.total_token_usage);
        if (total.input !== undefined || total.output !== undefined) {
          aggregate.latestTotal = {
            input: total.input ?? aggregate.latestTotal?.input ?? 0,
            output: total.output ?? aggregate.latestTotal?.output ?? 0,
          };
        }
        const last = usage(info.last_token_usage);
        if (last.input !== undefined || last.output !== undefined) {
          const current = { input: last.input ?? 0, output: last.output ?? 0 };
          aggregate.latestLastUsage = current;
          const turnId = textValue(info.turn_id ?? info.turnId) ?? aggregate.currentTurnId;
          if (turnId) {
            const previous = aggregate.turnUsage.get(turnId) ?? { input: 0, output: 0 };
            aggregate.turnUsage.set(turnId, {
              input: Math.max(previous.input, current.input),
              output: Math.max(previous.output, current.output),
            });
          }
        }
      }
      if (type === 'user_message' || type === 'agent_message') markActivity();
      if (type && CODEX_COMPLETION_TYPES.has(type)) markTerminal('finished');
      if (type && CODEX_ERROR_TYPES.has(type)) markError(`line:${index}`);
      return;
    }

    if (outerType === 'session_meta' || outerType === 'turn_context') {
      const source = outerType === 'session_meta' ? payload : payload;
      aggregate.model = textValue(source.model ?? source.model_id ?? source.modelId) ?? aggregate.model;
      aggregate.provider = textValue(source.model_provider ?? source.provider) ?? aggregate.provider;
      aggregate.cwd = textValue(source.cwd ?? source.working_directory ?? source.rollout_cwd) ?? aggregate.cwd;
      const collaborationMode = objectValue(source.collaboration_mode);
      const settings = objectValue(collaborationMode?.settings);
      aggregate.reasoningEffort = textValue(settings?.reasoning_effort)
        ?? textValue(source.effort ?? source.reasoning_effort)
        ?? aggregate.reasoningEffort;
      return;
    }

    if (outerType === 'response_item') {
      if (type && CODEX_TOOL_CALL_TYPES.has(type)) {
        const callId = ids(['call_id', 'callId', 'id']);
        if (callId) aggregate.toolIds.add(callId);
        else aggregate.anonymousToolCalls += 1;
        markActivity();
      } else if (type && CODEX_TOOL_RESULT_TYPES.has(type)) {
        const status = textValue(payload.status)?.toLowerCase();
        const isError = status === 'error' || payload.error === true;
        if (isError) markError(`tool:${ids(['call_id', 'callId', 'id']) ?? index}`);
        else markActivity();
      } else if (type === 'message' || type === 'reasoning') {
        markActivity();
      }
      if (type && CODEX_COMPLETION_TYPES.has(type)) markTerminal('finished');
      if (type && CODEX_ERROR_TYPES.has(type)) markError(`line:${index}`);
      return;
    }

    if (type && CODEX_COMPLETION_TYPES.has(type)) markTerminal('finished');
    if (type && CODEX_ERROR_TYPES.has(type)) markError(`line:${index}`);
  }

  private boundRecords(state: FileState): void {
    if (state.unbounded || state.records.length <= MAX_PARSED_RECORDS) return;
    const header = state.records.find((record) => objectValue(record.value)?.type === 'session_meta');
    const latestTurnContext = [...state.records].reverse().find((record) => objectValue(record.value)?.type === 'turn_context');
    const preserved = [header, latestTurnContext].filter((record): record is TraceRecord => !!record);
    const tailBudget = Math.max(1, MAX_PARSED_RECORDS - preserved.length);
    const tail = state.records.slice(-tailBudget);
    state.records = [...new Map([...preserved, ...tail].map((record) => [record.index, record])).values()]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  }

  private applyFreshness(agent: Agent, mtimeMs: number, changed: boolean, observation: CodexObservation): Agent {
    const now = Date.now();
    if (observation.failed || observation.completed) {
      return { ...agent, stats: { ...agent.stats } };
    }
    const lastActivityAt = changed ? now : Math.max(agent.lastActivityAt ?? 0, observation.lastTimestamp ?? 0, mtimeMs);
    const fresh = lastActivityAt >= now - this.idleMs;
    const status = agent.status === 'starting'
      ? 'starting'
      : fresh
        ? 'active'
        : 'idle';
    return { ...agent, status, lastActivityAt, stats: { ...agent.stats } };
  }

  private async removeFile(filePath: string, publish = true): Promise<void> {
    this.observedSignatures.delete(filePath);
    const state = this.files.get(filePath);
    const hadInventory = this.inventory.delete(filePath);
    if (!state && !hadInventory) return;
    this.files.delete(filePath);
    if (state?.observation) this.removeObservation(state.observation.agent.id);
    this.rebuildInventoryRuns();
    this.rebuildGraph();
    if (publish) this.publishSnapshot();
  }

  private removeObservation(agentId: string): void {
    this.traces.delete(agentId);
  }

  private releaseLoadedRun(): void {
    this.selectionGeneration += 1;
    this.files.clear();
    this.traces.clear();
    this.graph = { agents: [], runs: [], edges: [] };
  }

  private refreshIdleStatuses(): boolean {
    const now = Date.now();
    let changed = false;
    for (const state of this.files.values()) {
      const observation = state.observation;
      if (!observation || observation.completed || observation.failed) continue;
      const agent = observation.agent;
      if (agent.status === 'active' && agent.lastActivityAt !== undefined && now - agent.lastActivityAt >= this.idleMs) {
        agent.status = 'idle';
        changed = true;
      }
    }
    if (changed) this.rebuildGraph();
    return changed;
  }

  private rebuildGraph(): void {
    const byId = new Map<string, Agent>();
    for (const state of this.files.values()) {
      const agent = state.observation?.agent;
      if (!agent || byId.has(agent.id)) continue;
      byId.set(agent.id, agent);
    }
    this.graph = replaceAgents(this.graph, Array.from(byId.values()), this.graph.runs);
  }

  private rebuildInventoryRuns(): void {
    const inventoryAgents = Array.from(this.inventory.values()).map((entry) => ({
      ...entry.agent,
      stats: { ...entry.agent.stats },
    }));
    if (!inventoryAgents.length) {
      this.catalogRuns = [];
      return;
    }
    const grouped = replaceAgents({ agents: inventoryAgents, runs: [], edges: [] }, inventoryAgents);
    const counts = new Map<string, number>();
    for (const agent of grouped.agents) counts.set(agent.runId, (counts.get(agent.runId) ?? 0) + 1);
    const groupedById = new Map(grouped.agents.map((agent) => [agent.id, agent]));
    for (const entry of this.inventory.values()) {
      const groupedAgent = groupedById.get(entry.agent.id);
      if (!groupedAgent) continue;
      entry.agent = {
        ...entry.agent,
        runId: groupedAgent.runId,
        parentId: groupedAgent.parentId,
        stats: { ...entry.agent.stats },
      };
    }
    this.catalogRuns = grouped.runs.map((run) => ({
      ...run,
      agentCount: counts.get(run.id) ?? 0,
    }));
  }

  private publishSnapshot(): void {
    this.currentSnapshot = this.makeSnapshot();
    this.emit('snapshot', cloneSnapshot(this.currentSnapshot));
  }

  private makeSnapshot(): MonitorSnapshot {
    return {
      agents: this.selectedRunId ? this.graph.agents.map(cloneAgent) : [],
      runs: this.catalogRuns.map((run) => ({ ...run })),
      edges: this.selectedRunId ? this.graph.edges.map((edge) => ({ ...edge })) : [],
      watching: this.started,
      errors: [...this.errors],
      ...(this.selectedRunId ? { selectedRunId: this.selectedRunId } : {}),
    };
  }

  private recordError(message: string, publish: boolean): void {
    if (!message) return;
    if (!this.errors.includes(message)) this.errors.push(message);
    if (this.errors.length > MAX_MONITOR_ERRORS) this.errors.splice(0, this.errors.length - MAX_MONITOR_ERRORS);
    if (publish) this.publishSnapshot();
  }
}

function childRoot(base: string | undefined, fallbackBase: string, child: string): string {
  const root = base || fallbackBase;
  return path.basename(root) === child ? root : path.join(root, child);
}

function defaultTraceRoots(): string[] {
  const home = os.homedir();
  const codexRoot = childRoot(process.env.CODEX_HOME, path.join(home, '.codex'), 'sessions');
  const claudeRoot = childRoot(process.env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), 'projects');
  const piRoot = childRoot(process.env.PI_CODING_AGENT_DIR, path.join(home, '.pi', 'agent'), 'sessions');
  const hermesHome = process.env.HERMES_HOME || path.join(home, '.hermes');
  const hermesRoots = [
    path.join(hermesHome, 'session-exports', 'traces'),
    path.join(hermesHome, 'sessions'),
  ];
  return Array.from(new Set([codexRoot, claudeRoot, piRoot, ...hermesRoots]));
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isTooManyFiles(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EMFILE'
    || formatError(error).toLowerCase().includes('too many open files');
}

export default TraceMonitor;
