import type { TraceEntry, TracePage, TraceRangeRequest } from '../shared/types';
import { TRACE_PAGE_SIZE } from '../shared/traceRange';

/** One contiguous, growing range of a trace loaded into a tab: entries `[start, end)` of `total`. */
export interface TraceLoadState {
  entries: TraceEntry[];
  start: number;
  end: number;
  total: number;
}

export type TraceLoadOrder = 'oldest' | 'newest';

export const emptyTraceLoad: TraceLoadState = { entries: [], start: 0, end: 0, total: 0 };

/** The first page: the start of the session for oldest-first reading, its end for newest-first. */
export function firstRequest(order: TraceLoadOrder): TraceRangeRequest {
  return order === 'oldest' ? { start: 0, limit: TRACE_PAGE_SIZE } : { limit: TRACE_PAGE_SIZE };
}

/** Next page in reading direction, or undefined when that edge is loaded. */
export function nextRequest(state: TraceLoadState, order: TraceLoadOrder): TraceRangeRequest | undefined {
  if (order === 'oldest') return state.end < state.total ? { start: state.end, limit: TRACE_PAGE_SIZE } : undefined;
  return state.start > 0 ? { end: state.start, limit: TRACE_PAGE_SIZE } : undefined;
}

/** Everything left up to an edge, or on both sides for searching the whole session. */
export function remainingRequests(state: TraceLoadState, edge: 'start' | 'end' | 'both'): TraceRangeRequest[] {
  const requests: TraceRangeRequest[] = [];
  if (edge !== 'end' && state.start > 0) requests.push({ end: state.start, limit: state.start });
  // Open-ended: a live trace may have grown since the last page reported its total.
  if (edge !== 'start' && state.end < state.total) requests.push({ start: state.end, limit: Number.MAX_SAFE_INTEGER });
  return requests;
}

/** Adds a page adjacent to or overlapping the loaded range. Pages that leave a gap are ignored. */
export function mergePage(state: TraceLoadState, page: TracePage): TraceLoadState {
  const pageEnd = page.start + page.entries.length;
  if (!state.entries.length && state.start === state.end) {
    return { entries: page.entries, start: page.start, end: pageEnd, total: page.total };
  }
  if (pageEnd < state.start || page.start > state.end) return state;
  const before = page.entries.slice(0, Math.max(0, state.start - page.start));
  const after = page.entries.slice(Math.max(0, state.end - page.start));
  return {
    entries: [...before, ...state.entries, ...after],
    start: Math.min(state.start, page.start),
    end: Math.max(state.end, pageEnd),
    total: page.total,
  };
}

/**
 * Loads the pages of one trace tab in order. Loading more is skipped while a
 * load runs; a jump waits for running loads and then loads everything up to
 * its edge as the trace stands by then. Starting again drops pending pages.
 */
export class TracePager {
  private loaded: TraceLoadState = emptyTraceLoad;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private generation = 0;

  constructor(
    private readonly fetchPage: (request: TraceRangeRequest) => Promise<TracePage>,
    private readonly onChange: (state: TraceLoadState) => void,
  ) {}

  get state(): TraceLoadState {
    return this.loaded;
  }

  get busy(): boolean {
    return this.pending > 0;
  }

  /** Drops everything loaded or pending and loads the first page for the order. */
  start(order: TraceLoadOrder): Promise<void> {
    this.generation += 1;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.loaded = emptyTraceLoad;
    this.onChange(this.loaded);
    return this.enqueue(() => [firstRequest(order)]);
  }

  loadMore(order: TraceLoadOrder): Promise<void> {
    if (this.busy) return Promise.resolve();
    return this.enqueue(() => {
      const request = nextRequest(this.loaded, order);
      return request ? [request] : [];
    });
  }

  jumpTo(edge: 'start' | 'end' | 'both'): Promise<void> {
    return this.enqueue(() => remainingRequests(this.loaded, edge));
  }

  /** Runs after earlier loads; requests are computed when the load starts, from the state at that time. */
  private enqueue(requests: () => TraceRangeRequest[]): Promise<void> {
    const generation = this.generation;
    this.pending += 1;
    const task = this.queue.then(async () => {
      if (generation !== this.generation) return;
      for (const request of requests()) {
        const page = await this.fetchPage(request);
        if (generation !== this.generation) return;
        this.loaded = mergePage(this.loaded, page);
        this.onChange(this.loaded);
      }
    }).finally(() => {
      if (generation === this.generation) this.pending -= 1;
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
