import assert from 'node:assert/strict';
import test from 'node:test';
import { CodexAdapter } from '../src/traces/codex';
import { createClaudeSession } from '../src/traces/claude';
import { createPiSession } from '../src/traces/pi';
import type { ProviderSession } from '../src/traces/provider-common';

function canonical(session: ProviderSession, values: unknown[]): Array<{ value: unknown; index: number }> {
  let index = 0;
  const records: Array<{ value: unknown; index: number }> = [];
  for (const value of values) {
    for (const normalized of session.normalize(value, index++)) {
      records.push({ value: normalized, index: records.length });
    }
  }
  return records;
}

test('Claude normalization preserves identity, thinking, paired tools, per-message metadata, and usage', () => {
  const values = [
    {
      type: 'user',
      sessionId: 'claude-root',
      uuid: 'user-1',
      cwd: '/workspace/demo',
      message: { role: 'user', content: [{ type: 'text', text: 'Inspect this project' }] },
    },
    {
      type: 'assistant',
      sessionId: 'claude-root',
      uuid: 'assistant-1',
      message: {
        id: 'message-1',
        role: 'assistant',
        model: 'claude-sonnet-4',
        effort: 'medium',
        content: [
          { type: 'thinking', thinking: 'Read the repository first.' },
          { type: 'text', text: 'I found the relevant files.' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
        usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      },
    },
    // Claude can split one message into several JSONL records. Usage must be
    // emitted once for the stable message id while all blocks remain visible.
    {
      type: 'assistant',
      sessionId: 'claude-root',
      uuid: 'assistant-1-block-2',
      message: {
        id: 'message-1',
        role: 'assistant',
        model: 'claude-sonnet-4',
        effort: 'medium',
        content: [{ type: 'text', text: 'The command is ready.' }],
        usage: { input_tokens: 10, cache_read_input_tokens: 2, cache_creation_input_tokens: 3, output_tokens: 4 },
      },
    },
    {
      type: 'user',
      sessionId: 'claude-root',
      uuid: 'user-tool-result',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file-a\nfile-b' }] },
    },
    {
      type: 'assistant',
      sessionId: 'claude-root',
      uuid: 'assistant-2',
      message: {
        id: 'message-2',
        role: 'assistant',
        model: 'claude-opus-4',
        effort: 'high',
        content: [{ type: 'text', text: 'Finished.' }],
        usage: { input_tokens: 7, output_tokens: 2 },
      },
    },
    { type: 'result', sessionId: 'claude-root', subtype: 'success', result: 'Finished.' },
  ];
  const session = createClaudeSession(values[0], '/tmp/.claude/projects/demo/claude-root.jsonl');
  assert(session);
  const header = session.header as { type: string; payload: Record<string, unknown> };
  assert.equal(header.type, 'session_meta');
  assert.equal(header.payload.id, 'claude:claude-root');
  assert.equal(header.payload.session_id, 'claude-root');
  assert.equal(header.payload.thread_source, 'user');
  assert.equal(header.payload.harness, 'claude');

  const records = canonical(session, values);
  const observation = new CodexAdapter().inspect(records, { tracePath: '/tmp/claude-root.jsonl' });
  assert(observation);
  assert.equal(observation.agent.id, 'claude:claude-root');
  assert.equal(observation.agent.type, 'main');
  assert.equal(observation.agent.status, 'finished');
  assert.equal(observation.agent.model, 'claude-opus-4');
  assert.equal(observation.agent.reasoningEffort, 'high');
  assert.deepEqual(observation.agent.stats, { inputTokens: 22, outputTokens: 6, toolCalls: 1, errors: 0 });
  assert.equal(observation.entries.filter((entry) => entry.kind === 'usage').length, 2);
  assert(observation.entries.some((entry) => entry.kind === 'thinking' && entry.text.includes('Read the repository')));
  const call = observation.entries.find((entry) => entry.kind === 'tool-call');
  const result = observation.entries.find((entry) => entry.kind === 'tool-result');
  assert(call && result);
  assert.equal(call.callId, 'tool-1');
  assert.equal(result.callId, 'tool-1');
  assert.equal(call.toolName, 'Bash');
  assert.equal(call.model, 'claude-sonnet-4');
  assert.equal(call.reasoningEffort, 'medium');
});

test('Claude nested subagent identity comes from its path and ignores message parentUuid lineage', () => {
  const child = {
    type: 'assistant',
    sessionId: 'child-session',
    uuid: 'message-child',
    parentUuid: 'ordinary-message-parent',
    message: {
      id: 'child-message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: 'Child result' }],
    },
  };
  const session = createClaudeSession(child, '/tmp/.claude/projects/root-session/subagents/agent-explore.jsonl');
  assert(session);
  const header = session.header as { payload: Record<string, unknown> };
  assert.equal(header.payload.id, 'claude:root-session:explore');
  assert.equal(header.payload.session_id, 'child-session');
  assert.equal(header.payload.thread_source, 'subagent');
  assert.equal(header.payload.parent_thread_id, 'claude:root-session');

  const observation = new CodexAdapter().inspect(canonical(session, [child]), { tracePath: 'child.jsonl' });
  assert(observation);
  assert.equal(observation.agent.id, 'claude:root-session:explore');
  assert.equal(observation.agent.threadId, 'claude:root-session:explore');
  assert.equal(observation.agent.parentThreadId, 'claude:root-session');
  assert.equal(observation.agent.type, 'subagent');
});

test('Hermes Claude exports require the Hermes marker and reuse the Claude envelope', () => {
  const value = {
    version: 'hermes-agent',
    type: 'assistant',
    sessionId: 'hermes-session',
    uuid: 'h-1',
    message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'Hello from Hermes' }] },
  };
  assert.equal(createClaudeSession(value, '/tmp/export.jsonl'), null);
  const session = createClaudeSession(value, '/tmp/export.jsonl', 'hermes');
  assert(session);
  const header = session.header as { payload: Record<string, unknown> };
  assert.equal(session.harness, 'hermes');
  assert.equal(header.payload.id, 'hermes:hermes-session');
  assert.equal(header.payload.harness, 'hermes');
  const observation = new CodexAdapter().inspect(canonical(session, [value]), { tracePath: 'hermes.jsonl' });
  assert(observation);
  assert.equal(observation.agent.id, 'hermes:hermes-session');
  assert.equal(observation.entries.some((entry) => entry.text.includes('Hello from Hermes')), true);
});

test('normal assistant completion is resumed by a later user message', () => {
  const values = [
    {
      type: 'assistant',
      sessionId: 'resumable',
      uuid: 'assistant-complete',
      message: {
        id: 'message-complete',
        role: 'assistant',
        model: 'claude-sonnet-4',
        content: [{ type: 'text', text: 'First turn finished.' }],
        stop_reason: 'end_turn',
      },
    },
    {
      type: 'user',
      sessionId: 'resumable',
      uuid: 'user-resume',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue with the next turn.' }] },
    },
  ];
  const session = createClaudeSession(values[0], '/tmp/.claude/projects/resumable.jsonl');
  assert(session);
  const observation = new CodexAdapter().inspect(canonical(session, values), { tracePath: 'resumable.jsonl' });
  assert(observation);
  assert.equal(observation.completed, false);
  assert.equal(observation.failed, false);
  assert.equal(observation.agent.status, 'active');
  assert(observation.entries.some((entry) => entry.text === 'Turn completed'));
  assert(observation.entries.some((entry) => entry.text === 'Continue with the next turn.'));
});

test('Pi keeps branch and fork metadata out of spawn identity while preserving model, thinking, bash, compaction, and errors', () => {
  const values = [
    {
      type: 'session',
      version: 3,
      id: 'pi-root',
      cwd: '/workspace/pi',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4',
      thinkingLevel: 'medium',
      parentSession: 'forked-from-this-session',
    },
    { type: 'message', id: 'u-1', parentId: null, message: { role: 'user', content: 'Run the checks' } },
    {
      type: 'message',
      id: 'a-1',
      parentId: 'u-1',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4',
        thinkingLevel: 'medium',
        content: [
          { type: 'thinking', thinking: 'Check the project.' },
          { type: 'text', text: 'I will run them.' },
          { type: 'toolCall', id: 'pi-tool-1', name: 'bash', arguments: { command: 'npm test' } },
        ],
        usage: { input: 8, output: 3 },
      },
    },
    { type: 'message', id: 'tr-1', parentId: 'a-1', message: { role: 'toolResult', toolCallId: 'pi-tool-1', toolName: 'bash', content: 'passed' } },
    { type: 'model_change', id: 'model-change-1', modelId: 'claude-opus-4', provider: 'anthropic' },
    { type: 'thinking_level_change', id: 'thinking-change-1', thinkingLevel: 'high' },
    { type: 'bashExecution', id: 'bash-1', command: 'pwd', output: '/workspace/pi', exitCode: 0 },
    { type: 'compaction', id: 'compact-1', summary: 'Earlier context was summarized.' },
    { type: 'error', id: 'error-1', message: 'The final command failed.' },
  ];
  const session = createPiSession(values[0], '/tmp/.pi/agent/sessions/pi-root.jsonl');
  assert(session);
  const header = session.header as { payload: Record<string, unknown> };
  assert.equal(header.payload.id, 'pi:pi-root');
  assert.equal(header.payload.thread_source, 'user');
  assert.equal(header.payload.parent_thread_id, undefined);
  assert.equal(header.payload.parent_session, 'forked-from-this-session');

  const observation = new CodexAdapter().inspect(canonical(session, values), { tracePath: 'pi.jsonl' });
  assert(observation);
  assert.equal(observation.agent.id, 'pi:pi-root');
  assert.equal(observation.agent.parentThreadId, undefined);
  assert.equal(observation.agent.type, 'main');
  assert.equal(observation.agent.status, 'error');
  assert.equal(observation.agent.model, 'claude-opus-4');
  assert.equal(observation.agent.reasoningEffort, 'high');
  assert.deepEqual(observation.agent.stats, { inputTokens: 8, outputTokens: 3, toolCalls: 2, errors: 1 });
  assert(observation.entries.some((entry) => entry.kind === 'thinking' && entry.text.includes('Earlier context')));
  const callIds = observation.entries.filter((entry) => entry.kind === 'tool-call').map((entry) => entry.callId);
  const resultIds = observation.entries.filter((entry) => entry.kind === 'tool-result').map((entry) => entry.callId);
  assert.deepEqual(callIds, ['pi-tool-1', 'bash-1']);
  assert.deepEqual(resultIds, ['pi-tool-1', 'bash-1']);
});

test('provider detection rejects weak generic records', () => {
  assert.equal(createClaudeSession({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }, '/tmp/app.log'), null);
  assert.equal(createPiSession({ type: 'session', id: 'generic' }, '/tmp/app.log'), null);
  assert.equal(createPiSession({ type: 'message', message: { role: 'assistant', content: 'hello' } }, '/tmp/app.log'), null);
});

test('Codex usage entries keep per-request counts beside the running total', () => {
  const values = [
    { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { id: 'usage-session', cwd: '/tmp' } },
    { type: 'event_msg', timestamp: '2026-01-01T00:00:05Z', payload: { type: 'token_count', info: {
      last_token_usage: { input_tokens: 162332, output_tokens: 39 },
      total_token_usage: { input_tokens: 5000000, output_tokens: 9000 },
    } } },
  ];
  const observation = new CodexAdapter().inspect(values.map((value, index) => ({ value, index })), { tracePath: '/tmp/usage.jsonl' });
  const usage = observation?.entries.find((entry) => entry.kind === 'usage');
  assert(usage);
  assert.equal(usage.text, 'Usage: 5000000 input · 9000 output');
  assert.deepEqual(usage.usage, { input: 162332, output: 39 });
});

test('Codex derives subagent role from agent_path when agent_role is absent', () => {
  const values = [
    {
      type: 'session_meta',
      timestamp: '2026-10-05T04:04:05Z',
      payload: {
        id: 'thread-subagent-1',
        session_id: 'session-subagent-1',
        parent_thread_id: 'thread-root',
        thread_source: 'subagent',
        agent_path: '/root/milestone_ui_analysis',
        agent_nickname: 'Pasteur',
        agent_role: null,
      },
    },
  ];
  const observation = new CodexAdapter().inspect(values.map((value, index) => ({ value, index })), { tracePath: '/tmp/subagent.jsonl' });
  assert(observation);
  assert.equal(observation.agent.type, 'subagent');
  assert.equal(observation.agent.nickname, 'Pasteur');
  assert.equal(observation.agent.agentPath, '/root/milestone_ui_analysis');
  assert.equal(observation.agent.role, 'Milestone UI Analysis');
});

test('Codex preserves explicit agent_role over agent_path', () => {
  const values = [
    {
      type: 'session_meta',
      timestamp: '2026-10-05T04:04:05Z',
      payload: {
        id: 'thread-subagent-2',
        thread_source: 'subagent',
        agent_path: '/root/milestone_ui_analysis',
        agent_role: 'Custom Specialist',
      },
    },
  ];
  const observation = new CodexAdapter().inspect(values.map((value, index) => ({ value, index })), { tracePath: '/tmp/subagent-2.jsonl' });
  assert(observation);
  assert.equal(observation.agent.role, 'Custom Specialist');
});
