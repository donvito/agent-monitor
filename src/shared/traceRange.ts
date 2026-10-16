import type { TraceEntry, TracePage, TraceRangeRequest } from './types';

/** Entries loaded per page while reading a trace. */
export const TRACE_PAGE_SIZE = 200;

/** Cuts one page out of a full trace; out-of-range or invalid requests yield an empty page at the nearest edge. */
export function sliceTraceRange(all: readonly TraceEntry[], request: TraceRangeRequest): TracePage {
  const total = all.length;
  const limit = Number.isFinite(request.limit) && request.limit > 0 ? Math.floor(request.limit) : 0;
  const clamp = (value: number) => Math.min(total, Math.max(0, Math.floor(value)));
  let start: number;
  let end: number;
  if (request.start !== undefined) {
    start = clamp(request.start);
    end = clamp(start + limit);
  } else {
    end = request.end !== undefined ? clamp(request.end) : total;
    start = clamp(end - limit);
  }
  return { entries: all.slice(start, end), start, total };
}
