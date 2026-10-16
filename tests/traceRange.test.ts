import assert from 'node:assert/strict';
import test from 'node:test';
import type { TraceEntry } from '../src/shared/types';
import { sliceTraceRange, TRACE_PAGE_SIZE } from '../src/shared/traceRange';

const all: TraceEntry[] = Array.from({ length: 10 }, (_, index) => ({ id: `e${index}`, kind: 'assistant', text: `entry ${index}` }));
const texts = (page: ReturnType<typeof sliceTraceRange>) => page.entries.map((entry) => entry.text.replace('entry ', ''));

test('trace pages are cut by absolute index from either edge', () => {
  assert.equal(TRACE_PAGE_SIZE, 200);
  assert.deepEqual({ ...sliceTraceRange(all, { start: 0, limit: 3 }), entries: undefined }, { entries: undefined, start: 0, total: 10 });
  assert.deepEqual(texts(sliceTraceRange(all, { start: 0, limit: 3 })), ['0', '1', '2']);
  assert.deepEqual(texts(sliceTraceRange(all, { start: 4, limit: 3 })), ['4', '5', '6']);
  const fromEnd = sliceTraceRange(all, { end: 10, limit: 3 });
  assert.deepEqual([fromEnd.start, texts(fromEnd)], [7, ['7', '8', '9']]);
  const tail = sliceTraceRange(all, { limit: 4 });
  assert.deepEqual([tail.start, texts(tail)], [6, ['6', '7', '8', '9']]);
});

test('trace pages clamp to the trace and tolerate bad limits', () => {
  assert.deepEqual(texts(sliceTraceRange(all, { start: 8, limit: 5 })), ['8', '9']);
  const head = sliceTraceRange(all, { end: 2, limit: 5 });
  assert.deepEqual([head.start, texts(head)], [0, ['0', '1']]);
  assert.deepEqual(texts(sliceTraceRange(all, { start: 0, limit: 50 })).length, 10);
  const past = sliceTraceRange(all, { start: 10, limit: 5 });
  assert.deepEqual([past.start, past.entries.length, past.total], [10, 0, 10]);
  assert.equal(sliceTraceRange(all, { start: 0, limit: 0 }).entries.length, 0);
  assert.equal(sliceTraceRange(all, { start: 0, limit: Number.NaN }).entries.length, 0);
  const beyond = sliceTraceRange(all, { start: 25, limit: 5 });
  assert.deepEqual([beyond.start, beyond.entries.length], [10, 0]);
});
