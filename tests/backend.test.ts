import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CodexAdapter } from '../src/traces/codex';
import { createGraphState, reduceAgentEvent } from '../src/graph/reducer';
import { TraceMonitor } from '../src/main/trace-monitor/TraceMonitor';

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'session_meta',
    payload: {
      session_id: 'session-parent',
      id: 'thread-parent',
      thread_source: 'user',
      cwd: '/tmp/project',
      model_provider: 'openai',
      model: 'gpt-6-astra',
      ...overrides,
    },
  };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('timed out waiting for monitor update'));
        return;
      }
      setTimeout(() => void tick(), 20);
    };
    tick();
  });
}

test('Codex adapter preserves ids, explicit provenance, bounded entries, and cumulative usage', () => {
  const adapter = new CodexAdapter();
  const records = [
    meta({ session_id: 'session-main', id: 'thread-main', thread_source: 'user', agent_path: '/root/main' }),
    { type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-6-astra', collaboration_mode: { settings: { reasoning_effort: 'medium' } } } },
    { type: 'response_item', timestamp: '2026-09-16T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Read the files.' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: '{"cmd":"ls"}' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'passed' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { turn_id: 'turn-1', last_token_usage: { input_tokens: 10, output_tokens: 4 }, total_token_usage: { input_tokens: 10, output_tokens: 4 } } } },
    // Repeated progress records must not double-count the cumulative total.
    { type: 'event_msg', payload: { type: 'token_count', info: { turn_id: 'turn-1', last_token_usage: { input_tokens: 10, output_tokens: 4 }, total_token_usage: { input_tokens: 10, output_tokens: 4 } } } },
    { type: 'event_msg', payload: { type: 'task_complete', message: 'Finished' } },
  ];
  const result = adapter.inspect(records, { tracePath: '/tmp/main.jsonl' });
  assert(result);
  assert.equal(result.agent.sessionId, 'session-main');
  assert.equal(result.agent.threadId, 'thread-main');
  assert.equal(result.agent.type, 'main');
  assert.equal(result.agent.model, 'gpt-6-astra');
  assert.equal(result.agent.reasoningEffort, 'medium');
  assert.equal(result.agent.agentPath, '/root/main');
  assert.equal(result.agent.status, 'finished');
  assert.deepEqual(result.agent.stats, { inputTokens: 10, outputTokens: 4, toolCalls: 1, errors: 0 });
  assert.equal(result.entries.find((entry) => entry.kind === 'tool-call')?.text.includes('exec'), true);
  const call = result.entries.find(entry => entry.kind === 'tool-call');
  const output = result.entries.find(entry => entry.kind === 'tool-result');
  assert.equal(call?.callId, 'call-1');
  assert.equal(output?.callId, call?.callId);
  assert.equal(call?.toolName, 'exec');
  assert.equal(call?.model, 'gpt-6-astra');
  assert.equal(call?.reasoningEffort, 'medium');
  assert.equal(call?.turnId, 'turn-1');
  assert.equal(result.entries.filter((entry) => entry.kind === 'tool-call')[0]?.id === result.entries.filter((entry) => entry.kind === 'tool-result')[0]?.id, false);

  const resumed = adapter.inspect([
    ...records,
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Resumed work' }] } },
  ], { tracePath: '/tmp/main.jsonl', previous: result.agent });
  assert(resumed);
  assert.equal(resumed.agent.status, 'active');
  assert.equal(resumed.completed, false);
});

test('graph reducer reparents out-of-order nested Codex agents and groups one run', () => {
  const makeAgent = (id: string, type: 'main' | 'subagent', threadId: string, parentThreadId?: string) => ({
    id,
    runId: id,
    parentId: null,
    harness: 'codex' as const,
    type,
    status: 'active' as const,
    threadId,
    ...(parentThreadId ? { parentThreadId } : {}),
    stats: { inputTokens: 0, outputTokens: 0, toolCalls: 0, errors: 0 },
  });
  let state = createGraphState();
  state = reduceAgentEvent(state, { type: 'agent.discovered', agent: makeAgent('child', 'subagent', 'thread-child', 'thread-parent') });
  assert.equal(state.agents[0].parentId, null);
  state = reduceAgentEvent(state, { type: 'agent.discovered', agent: makeAgent('parent', 'main', 'thread-parent') });
  const child = state.agents.find((agent) => agent.id === 'child');
  assert(child);
  assert.equal(child.parentId, 'parent');
  assert.equal(child.runId, 'parent');
  assert.deepEqual(state.edges.map((edge) => [edge.source, edge.target]), [['parent', 'child']]);
  assert.deepEqual(state.runs.map((run) => run.id), ['parent']);
});

test('TraceMonitor handles partial UTF-8 lines, incremental appends, nested discovery, truncation, and delete', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-backend-'));
  const childPath = path.join(root, '2026', '09', '16', 'child.jsonl');
  const parentPath = path.join(root, '2026', '09', '16', 'parent.jsonl');
  await mkdir(path.dirname(childPath), { recursive: true });
  const childMeta = meta({ session_id: 'session-child', id: 'thread-child', thread_source: 'subagent', parent_thread_id: 'thread-parent', agent_role: 'explorer', agent_nickname: 'Luna' });
  await writeFile(childPath, line(childMeta));
  await writeFile(parentPath, `${line(meta({ session_id: 'session-parent', id: 'thread-parent', thread_source: 'user' }))}${line({ type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } })}`);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 500 });
  try {
    await monitor.start();
    assert.deepEqual(monitor.snapshot().agents, []);
    assert.equal(monitor.snapshot().runs.find((run) => run.id === 'thread-parent')?.agentCount, 2);
    await monitor.loadRun('thread-parent');
    await waitFor(() => monitor.snapshot().agents.some((agent) => agent.threadId === 'thread-child'));

    const text = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'café' }] } });
    const bytes = Buffer.from(`${text}\n`, 'utf8');
    const split = bytes.indexOf(Buffer.from('é')) + 1;
    await appendFile(childPath, bytes.subarray(0, split));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendFile(childPath, bytes.subarray(split));
    await waitFor(() => monitor.getTrace('thread-child').then((entries) => entries.some((entry) => entry.text.includes('café'))).catch(() => false));
    assert.equal((await monitor.getTrace('thread-child')).some((entry) => entry.text.includes('café')), true);

    await waitFor(() => monitor.snapshot().edges.some((edge) => edge.target === 'thread-child' && edge.source === 'thread-parent'));
    assert.equal(monitor.snapshot().agents.find((agent) => agent.threadId === 'thread-child')?.parentId, 'thread-parent');

    await truncate(parentPath, 0);
    await waitFor(() => !monitor.snapshot().agents.some((agent) => agent.threadId === 'thread-parent'));
    await appendFile(parentPath, `${line(meta({ session_id: 'session-parent', id: 'thread-parent', thread_source: 'user' }))}${line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'rewritten' }] } })}`);
    await waitFor(() => monitor.getTrace('thread-parent').then((entries) => entries.some((entry) => entry.text.includes('rewritten'))).catch(() => false));
    await rm(childPath);
    await waitFor(() => !monitor.snapshot().agents.some((agent) => agent.threadId === 'thread-child'));
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('TraceMonitor inventories runs without loading bodies and releases the previous selection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-select-'));
  const firstPath = path.join(root, 'first.jsonl');
  const secondPath = path.join(root, 'second.jsonl');
  await writeFile(firstPath, `${line(meta({ session_id: 'session-a', id: 'thread-a', thread_source: 'user' }))}${line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first body' }] } })}`);
  await writeFile(secondPath, `${line(meta({ session_id: 'session-b', id: 'thread-b', thread_source: 'user' }))}${line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second body' }] } })}`);
  const monitor = new TraceMonitor({ roots: [root], idleMs: 500 });
  try {
    await monitor.start();
    assert.deepEqual(monitor.snapshot().agents, []);
    assert.equal(await monitor.getTrace('thread-a').then((entries) => entries.length), 0);
    await monitor.loadRun('thread-a');
    assert.equal((await monitor.getTrace('thread-a')).some((entry) => entry.text.includes('first body')), true);
    assert.equal(monitor.snapshot().agents.every((agent) => agent.threadId === 'thread-a'), true);
    await monitor.loadRun('thread-b');
    assert.equal((await monitor.getTrace('thread-a')).length, 0);
    assert.equal((await monitor.getTrace('thread-b')).some((entry) => entry.text.includes('second body')), true);
    assert.equal(monitor.snapshot().selectedRunId, 'thread-b');
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('large metadata is discovered lazily, metrics survive eviction, and latest selection wins', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-large-header-'));
  const calls = Array.from({ length: 700 }, (_, index) => line({ type: 'response_item', payload: { type: 'function_call', call_id: `call-${index}`, name: 'exec', arguments: '{}' } })).join('');
  await writeFile(path.join(root, 'large.jsonl'), line(meta({ id: 'large', base_instructions: 'x'.repeat(600_000) })) + line({ type: 'turn_context', payload: { model: 'gpt-6-astra', effort: 'medium' } }) + calls);
  await writeFile(path.join(root, 'other.jsonl'), line(meta({ id: 'other' })));
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    assert.equal(monitor.snapshot().runs.length, 2);
    assert.equal(monitor.snapshot().agents.length, 0);
    await monitor.loadRun('large');
    assert.equal(monitor.snapshot().agents[0].stats.toolCalls, 700);
    assert.equal(monitor.snapshot().agents[0].reasoningEffort, 'medium');
    await monitor.loadRun('other');
    await Promise.all([monitor.loadRun('large'), monitor.loadRun('other')]);
    assert.equal(monitor.snapshot().selectedRunId, 'other');
    assert.deepEqual(monitor.snapshot().agents.map(agent => agent.id), ['other']);
    assert.equal((await monitor.getTrace('large')).length, 0);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('trace metadata preserves interleaved tool identities, empty outputs, errors, and model changes', () => {
  const result = new CodexAdapter().inspect([
    meta(),
    { type: 'turn_context', payload: { turn_id: 'first', model: 'model-a', effort: 'medium' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'a', name: 'read', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'b', name: 'write', arguments: '{}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'b', output: '', status: 'error' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'a', output: '' } },
    { type: 'turn_context', payload: { turn_id: 'second', model: 'model-b', effort: 'high' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Done' } },
  ]);
  assert(result);
  assert.deepEqual(result.entries.map(e => [e.kind, e.callId, e.model, e.turnId]), [
    ['tool-call', 'a', 'model-a', 'first'],
    ['tool-call', 'b', 'model-a', 'first'],
    ['error', 'b', 'model-a', 'first'],
    ['tool-result', 'a', 'model-a', 'first'],
    ['assistant', undefined, 'model-b', 'second'],
  ]);
});

test('parent references cannot connect sessions across providers', () => {
  const make = (id: string, harness: 'codex' | 'claude', threadId: string, parentThreadId?: string) => ({
    id, harness, threadId, parentThreadId, runId: id, parentId: null,
    type: parentThreadId ? 'subagent' as const : 'main' as const, status: 'idle' as const,
    stats: { inputTokens: 0, outputTokens: 0, toolCalls: 0, errors: 0 },
  });
  let graph = createGraphState();
  for (const agent of [make('codex-root', 'codex', 'same'), make('claude-child', 'claude', 'child', 'same')]) {
    graph = reduceAgentEvent(graph, { type: 'agent.discovered', agent });
  }
  assert.equal(graph.edges.length, 0);
  graph = reduceAgentEvent(graph, { type: 'agent.discovered', agent: make('claude-root', 'claude', 'same') });
  assert.deepEqual(graph.edges.map(e => [e.source, e.target]), [['claude-root', 'claude-child']]);
});

test('Codex adapter keeps every entry when maxEntries is unbounded', () => {
  const records = [
    meta({ id: 'many' }),
    ...Array.from({ length: 1200 }, (_, index) => ({ type: 'event_msg', payload: { type: 'agent_message', message: `message ${index + 1}` } })),
  ];
  const unbounded = new CodexAdapter().inspect(records, { maxEntries: Infinity });
  assert.equal(unbounded?.entries.length, 1200);
  assert.equal(unbounded?.entries[0].text, 'message 1');
  const bounded = new CodexAdapter().inspect(records);
  assert.equal(bounded?.entries.length, 1000);
  assert.equal(bounded?.entries[0].text, 'message 201');
});

async function withLongSession(messages: number, run: (monitor: TraceMonitor, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-monitor-range-'));
  const file = path.join(root, 'long.jsonl');
  const body = Array.from({ length: messages }, (_, index) => line({ type: 'event_msg', payload: { type: 'agent_message', message: `message ${index + 1}` } })).join('');
  await writeFile(file, line(meta({ id: 'long' }))
    + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start here' }] } })
    + body);
  const monitor = new TraceMonitor({ roots: [root] });
  try {
    await monitor.start();
    await monitor.loadRun('long');
    await run(monitor, file);
  } finally {
    await monitor.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('paged trace ranges cover a long session from either end', async () => {
  await withLongSession(1500, async (monitor) => {
    const first = await monitor.getTraceRange('long', { start: 0, limit: 200 });
    assert.equal(first.total, 1501);
    assert.equal(first.start, 0);
    assert.equal(first.entries[0].text, 'Start here');
    assert.equal(first.entries.length, 200);
    const second = await monitor.getTraceRange('long', { start: 200, limit: 200 });
    assert.equal(second.entries[0].text, 'message 200');
    const last = await monitor.getTraceRange('long', { end: 1501, limit: 200 });
    assert.equal(last.start, 1301);
    assert.equal(last.entries.at(-1)?.text, 'message 1500');
    assert.deepEqual(await monitor.getTraceRange('missing', { start: 0, limit: 200 }), { entries: [], start: 0, total: 0 });
  });
});

test('paged trace ranges stay stable while the file grows', async () => {
  await withLongSession(1500, async (monitor, file) => {
    await monitor.getTraceRange('long', { start: 0, limit: 200 });
    await appendFile(file, Array.from({ length: 10 }, (_, index) => line({ type: 'event_msg', payload: { type: 'agent_message', message: `late ${index + 1}` } })).join(''));
    const next = await monitor.getTraceRange('long', { start: 200, limit: 200 });
    assert.equal(next.entries[0].text, 'message 200');
    assert.equal(next.total, 1511);
  });
});

test('a growing trace file is read incrementally for paged ranges', async () => {
  await withLongSession(300, async (monitor, file) => {
    await monitor.getTraceRange('long', { start: 0, limit: 200 });
    // Same-length edit of already read bytes, then an append: an incremental read parses only the appended bytes.
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('Start here', 'Start HERE'));
    await appendFile(file, line({ type: 'event_msg', payload: { type: 'agent_message', message: 'appended' } }));
    const [first, last] = await Promise.all([
      monitor.getTraceRange('long', { start: 0, limit: 1 }),
      monitor.getTraceRange('long', { end: 302, limit: 1 }),
    ]);
    assert.equal(first.entries[0].text, 'Start here');
    assert.equal(last.entries[0].text, 'appended');
    assert.equal(first.total, 302);
  });
});
