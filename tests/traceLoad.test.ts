import assert from 'node:assert/strict';
import test from 'node:test';
import type { TraceEntry } from '../src/shared/types';
import { sliceTraceRange } from '../src/shared/traceRange';
import { emptyTraceLoad, firstRequest, mergePage, nextRequest, remainingRequests, TracePager } from '../src/renderer/traceLoad';
import type { TracePage, TraceRangeRequest } from '../src/shared/types';

const all: TraceEntry[] = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, kind: 'assistant', text: String(index) }));
const page = (request: Parameters<typeof sliceTraceRange>[1]) => sliceTraceRange(all, request);
const texts = (state: { entries: TraceEntry[] }) => state.entries.map((entry) => entry.text).join('');

test('the first page comes from the edge the order reads from', () => {
  assert.deepEqual(emptyTraceLoad, { entries: [], start: 0, end: 0, total: 0 });
  assert.deepEqual(firstRequest('oldest'), { start: 0, limit: 200 });
  assert.deepEqual(firstRequest('newest'), { limit: 200 });
});

test('the next page continues in reading direction until that edge', () => {
  const oldest = mergePage(emptyTraceLoad, page({ start: 0, limit: 4 }));
  assert.deepEqual(nextRequest(oldest, 'oldest'), { start: 4, limit: 200 });
  const newest = mergePage(emptyTraceLoad, page({ limit: 4 }));
  assert.deepEqual([newest.start, newest.end, texts(newest)], [6, 10, '6789']);
  assert.deepEqual(nextRequest(newest, 'newest'), { end: 6, limit: 200 });
  const full = mergePage(emptyTraceLoad, page({ start: 0, limit: 10 }));
  assert.equal(nextRequest(full, 'oldest'), undefined);
  assert.equal(nextRequest(full, 'newest'), undefined);
});

test('pages merge on either side without duplicates', () => {
  let state = mergePage(emptyTraceLoad, page({ start: 3, limit: 3 }));
  state = mergePage(state, page({ start: 6, limit: 2 }));
  state = mergePage(state, page({ end: 3, limit: 2 }));
  assert.deepEqual([state.start, state.end, texts(state)], [1, 8, '1234567']);
  state = mergePage(state, page({ start: 2, limit: 3 }));
  assert.deepEqual([state.start, state.end, texts(state)], [1, 8, '1234567']);
  state = mergePage(state, page({ start: 6, limit: 4 }));
  assert.deepEqual([state.start, state.end, texts(state), state.total], [1, 10, '123456789', 10]);
});

test('pages that do not touch the loaded range are ignored', () => {
  const state = mergePage(emptyTraceLoad, page({ start: 0, limit: 2 }));
  assert.equal(mergePage(state, page({ start: 5, limit: 2 })), state);
});

test('remaining requests reach an edge, or both for whole-session search', () => {
  const state = mergePage(emptyTraceLoad, page({ start: 3, limit: 3 }));
  assert.deepEqual(remainingRequests(state, 'end'), [{ start: 6, limit: Number.MAX_SAFE_INTEGER }]);
  assert.deepEqual(remainingRequests(state, 'start'), [{ end: 3, limit: 3 }]);
  assert.deepEqual(remainingRequests(state, 'both'), [{ end: 3, limit: 3 }, { start: 6, limit: Number.MAX_SAFE_INTEGER }]);
  const full = mergePage(emptyTraceLoad, page({ start: 0, limit: 10 }));
  assert.deepEqual(remainingRequests(full, 'both'), []);
});

/** A fake trace source whose pages resolve only when the test releases them. */
function deferredSource(size: number) {
  let trace: TraceEntry[] = Array.from({ length: size }, (_, index) => ({ id: `e${index}`, kind: 'assistant', text: String(index) }));
  const waiting: Array<() => void> = [];
  const requests: TraceRangeRequest[] = [];
  return {
    requests,
    grow(by: number) { trace = [...trace, ...Array.from({ length: by }, (_, index) => ({ id: `n${index}`, kind: 'assistant' as const, text: `new ${index}` }))]; },
    fetchPage(request: TraceRangeRequest): Promise<TracePage> {
      requests.push(request);
      return new Promise((resolve) => waiting.push(() => resolve(sliceTraceRange(trace, request))));
    },
    /** Lets queued loads issue their requests, then answers them until none are left. */
    async release() {
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        if (!waiting.length) return;
        waiting.shift()!();
      }
    },
  };
}

test('a jump waits for a page that is loading and then loads to the edge', async () => {
  const source = deferredSource(1000);
  const pager = new TracePager(source.fetchPage, () => undefined);
  const started = pager.start('oldest');
  await source.release();
  await started;
  void pager.loadMore('oldest');
  assert.equal(pager.busy, true);
  const jumped = pager.jumpTo('end');
  await source.release();
  await jumped;
  assert.deepEqual([pager.state.start, pager.state.end, pager.state.entries.length], [0, 1000, 1000]);
});

test('loading more is skipped while a load runs', async () => {
  const source = deferredSource(1000);
  const pager = new TracePager(source.fetchPage, () => undefined);
  void pager.start('oldest');
  void pager.loadMore('oldest');
  await source.release();
  assert.equal(source.requests.length, 1);
});

test('a jump to the end reaches entries added since the last page', async () => {
  const source = deferredSource(300);
  const pager = new TracePager(source.fetchPage, () => undefined);
  const started = pager.start('oldest');
  await source.release();
  await started;
  source.grow(10);
  const jumped = pager.jumpTo('end');
  await source.release();
  await jumped;
  assert.deepEqual([pager.state.end, pager.state.total], [310, 310]);
});

test('pages of a superseded start are dropped', async () => {
  const source = deferredSource(1000);
  const seen: string[] = [];
  const pager = new TracePager(source.fetchPage, (state) => seen.push(`${state.start}..${state.end}`));
  void pager.start('oldest');
  const restarted = pager.start('newest');
  await source.release();
  await restarted;
  assert.deepEqual([pager.state.start, pager.state.end], [800, 1000]);
  assert(!seen.includes('0..200'), `the superseded first page was applied: ${seen.join(', ')}`);
});
