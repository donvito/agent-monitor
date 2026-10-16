import {
  codexUsage,
  contentText,
  firstString,
  isObject,
  namespacedId,
  parseJson,
  pathLower,
  rawTimestamp,
  stringify,
  type JsonObject,
  type ProviderSession,
} from './provider-common';

type ClaudeHarness = 'claude' | 'hermes';

type NormalizedBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-call'; id?: string; name: string; input: unknown }
  | { kind: 'tool-result'; id?: string; output: unknown; error: boolean; toolName?: string }
  | { kind: 'image'; text: string };

interface ClaudeIdentity {
  harness: ClaudeHarness;
  sessionId: string;
  agentId: string;
  parentThreadId?: string;
  threadSource: 'user' | 'subagent';
  cwd?: string;
  model?: string;
  provider?: string;
  serviceTier?: string;
  effort?: string;
  role?: string;
  nickname?: string;
  agentPath: string;
}

function pathSegments(tracePath: string): string[] {
  return tracePath.replaceAll('\\', '/').split('/').filter(Boolean);
}

function nestedClaudeAgent(tracePath: string): { parentSession: string; agentId: string } | undefined {
  const segments = pathSegments(tracePath);
  const subagentsIndex = segments.findIndex((segment) => segment.toLowerCase() === 'subagents');
  if (subagentsIndex <= 0 || subagentsIndex + 1 >= segments.length) return undefined;
  const file = segments[subagentsIndex + 1].replace(/\.jsonl$/i, '');
  if (!file) return undefined;
  // Native Claude names child files agent-<id>.jsonl. The prefix is a file
  // convention, not part of the child id exposed to the graph.
  const agentId = file.toLowerCase().startsWith('agent-') ? file.slice('agent-'.length) : file;
  if (!agentId) return undefined;
  return { parentSession: segments[subagentsIndex - 1], agentId };
}

function basenameWithoutExtension(tracePath: string): string | undefined {
  const segments = pathSegments(tracePath);
  const file = segments[segments.length - 1]?.replace(/\.jsonl$/i, '');
  return file || undefined;
}

function messageOf(value: JsonObject): JsonObject | undefined {
  return isObject(value.message) ? value.message : undefined;
}

function messageRole(value: JsonObject, message = messageOf(value)): string | undefined {
  return firstString(message, ['role']) ?? firstString(value, ['role']);
}

function blockType(value: JsonObject): string {
  return (firstString(value, ['type']) ?? '').toLowerCase();
}

function toolInput(value: JsonObject): unknown {
  if ('input' in value) return parseJson(value.input);
  if ('arguments' in value) return parseJson(value.arguments);
  if ('parameters' in value) return parseJson(value.parameters);
  if ('command' in value) return { command: value.command };
  return {};
}

function normalizedBlocks(content: unknown): NormalizedBlock[] {
  if (content === undefined || content === null || content === '') return [];
  if (typeof content === 'string' || typeof content === 'number' || typeof content === 'boolean') {
    return [{ kind: 'text', text: String(content) }];
  }
  if (!Array.isArray(content)) {
    const text = contentText(content);
    return text ? [{ kind: 'text', text }] : [];
  }

  const blocks: NormalizedBlock[] = [];
  for (const raw of content) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      blocks.push({ kind: 'text', text: String(raw) });
      continue;
    }
    if (!isObject(raw)) continue;
    const type = blockType(raw);
    if (type === 'text' || type === 'input_text' || type === 'output_text' || type === 'message') {
      const text = typeof raw.text === 'string' ? raw.text : contentText(raw.content);
      if (text) blocks.push({ kind: 'text', text });
      continue;
    }
    if (type === 'thinking' || type === 'reasoning' || type === 'summary_text' || type === 'summary') {
      const text = contentText(raw.thinking ?? raw.text ?? raw.summary ?? raw.content);
      if (text) blocks.push({ kind: 'thinking', text });
      continue;
    }
    if (type === 'redacted_thinking' || type === 'redacted-thinking') {
      blocks.push({ kind: 'thinking', text: 'Reasoning unavailable (redacted)' });
      continue;
    }
    if (
      type === 'tool_use' || type === 'tooluse' || type === 'tool_call' || type === 'toolcall'
      || type === 'function_call' || type === 'custom_tool_call' || type === 'server_tool_use'
      || type === 'web_search_tool_use' || type === 'mcp_tool_use' || type === 'local_shell_call'
    ) {
      const id = firstString(raw, ['id', 'call_id', 'callId']);
      const name = firstString(raw, ['name', 'tool_name', 'toolName'])
        ?? (type === 'local_shell_call' ? 'shell' : type.replace(/_(?:call|use)$/, ''));
      blocks.push({ kind: 'tool-call', ...(id ? { id } : {}), name, input: toolInput(raw) });
      continue;
    }
    if (
      type === 'tool_result' || type === 'toolresult' || type === 'function_call_output'
      || type === 'custom_tool_call_output' || type === 'local_shell_call_output'
      || type === 'web_search_tool_result' || type === 'mcp_tool_result'
    ) {
      const id = firstString(raw, ['tool_use_id', 'toolCallId', 'call_id', 'callId', 'id']);
      const output = raw.content !== undefined ? raw.content : raw.output !== undefined ? raw.output : raw.result;
      const error = raw.is_error === true || raw.isError === true || String(raw.status ?? '').toLowerCase() === 'error';
      blocks.push({
        kind: 'tool-result',
        ...(id ? { id } : {}),
        output,
        error,
        ...(firstString(raw, ['tool_name', 'toolName', 'name']) ? { toolName: firstString(raw, ['tool_name', 'toolName', 'name']) } : {}),
      });
      continue;
    }
    if (type === 'image' || type === 'input_image' || type === 'output_image') {
      blocks.push({ kind: 'image', text: '[image]' });
      continue;
    }
    const fallback = contentText(raw);
    if (fallback) blocks.push({ kind: 'text', text: fallback });
  }
  return blocks;
}

function explicitParent(value: JsonObject): string | undefined {
  return firstString(value, [
    'parentThreadId', 'parent_thread_id', 'parentAgentId', 'parent_agent_id',
    'parentSessionId', 'parent_session_id', 'parentSession', 'parent_session',
    'spawnedFrom', 'spawned_from',
  ]);
}

function isSubagentRecord(value: JsonObject, parent: string | undefined): boolean {
  const type = firstString(value, ['agentType', 'agent_type', 'threadSource', 'thread_source', 'role']);
  return !!parent || value.isSubagent === true || value.is_subagent === true
    || type === 'subagent' || type === 'agent';
}

function deriveIdentity(value: JsonObject, tracePath: string, harness: ClaudeHarness): ClaudeIdentity {
  const message = messageOf(value);
  const nested = nestedClaudeAgent(tracePath);
  const pathSession = nested?.parentSession;
  const rawSessionId = firstString(value, ['sessionId', 'session_id', 'session'])
    ?? firstString(message, ['sessionId', 'session_id', 'session']);
  const fallbackSession = pathSession ?? basenameWithoutExtension(tracePath) ?? 'unknown';
  const sessionId = rawSessionId ?? (nested ? nested.agentId : fallbackSession);
  const explicitParentId = explicitParent(value);
  const parentThreadId = nested
    ? namespacedId(harness, nested.parentSession)
    : explicitParentId
      ? namespacedId(harness, explicitParentId)
      : undefined;
  const subagent = !!nested || isSubagentRecord(value, explicitParentId);
  const rootOrSession = pathSession ?? sessionId;
  const agentId = nested
    ? `${harness}:${rootOrSession}:${nested.agentId}`
    : namespacedId(harness, sessionId);
  const model = firstString(message, ['model', 'model_id', 'modelId'])
    ?? firstString(value, ['model', 'model_id', 'modelId']);
  const provider = firstString(message, ['provider', 'model_provider', 'modelProvider'])
    ?? firstString(value, ['provider', 'model_provider', 'modelProvider'])
    ?? 'anthropic';
  const usage = isObject(message?.usage) ? message.usage : isObject(value.usage) ? value.usage : undefined;
  const serviceTier = firstString(message, ['service_tier', 'serviceTier', 'tier'])
    ?? firstString(value, ['service_tier', 'serviceTier', 'tier'])
    ?? firstString(usage, ['service_tier', 'serviceTier', 'tier']);
  const effort = firstString(message, ['effort', 'reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'thinking_level'])
    ?? firstString(value, ['effort', 'reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'thinking_level']);
  const cwd = firstString(value, ['cwd', 'working_directory', 'workingDirectory'])
    ?? firstString(message, ['cwd', 'working_directory', 'workingDirectory']);

  return {
    harness,
    sessionId,
    agentId,
    ...(parentThreadId ? { parentThreadId } : {}),
    threadSource: subagent ? 'subagent' : 'user',
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(serviceTier ? { serviceTier } : {}),
    ...(effort ? { effort } : {}),
    ...(firstString(value, ['agentRole', 'agent_role']) ? { role: firstString(value, ['agentRole', 'agent_role']) } : {}),
    ...(firstString(value, ['agentNickname', 'agent_nickname']) ? { nickname: firstString(value, ['agentNickname', 'agent_nickname']) } : {}),
    agentPath: tracePath,
  };
}

function syntheticHeader(identity: ClaudeIdentity, value: JsonObject): JsonObject {
  const payload: JsonObject = {
    id: identity.agentId,
    session_id: identity.sessionId,
    thread_source: identity.threadSource,
    harness: identity.harness,
    ...(identity.parentThreadId ? { parent_thread_id: identity.parentThreadId } : {}),
    ...(identity.cwd ? { cwd: identity.cwd } : {}),
    ...(identity.model ? { model: identity.model } : {}),
    ...(identity.provider ? { model_provider: identity.provider, provider: identity.provider } : {}),
    ...(identity.serviceTier ? { service_tier: identity.serviceTier } : {}),
    ...(identity.effort ? { effort: identity.effort, reasoning_effort: identity.effort } : {}),
    ...(identity.role ? { agent_role: identity.role } : {}),
    ...(identity.nickname ? { agent_nickname: identity.nickname } : {}),
    agent_path: identity.agentPath,
  };
  const timestamp = rawTimestamp(value, messageOf(value));
  if (timestamp !== undefined) payload.timestamp = timestamp;
  return { type: 'session_meta', payload };
}

function record(type: string, payload: JsonObject, timestamp: unknown): JsonObject {
  return {
    type,
    ...(timestamp !== undefined ? { timestamp } : {}),
    payload,
  };
}

function turnContext(
  turnId: string,
  timestamp: unknown,
  model: string | undefined,
  provider: string | undefined,
  serviceTier: string | undefined,
  effort: string | undefined,
  cwd: string | undefined,
): JsonObject {
  return record('turn_context', {
    turn_id: turnId,
    ...(model ? { model } : {}),
    ...(provider ? { model_provider: provider, provider } : {}),
    ...(serviceTier ? { service_tier: serviceTier } : {}),
    ...(effort ? { effort, reasoning_effort: effort } : {}),
    ...(cwd ? { cwd } : {}),
  }, timestamp);
}

function responseMessage(role: 'user' | 'assistant', text: string, timestamp: unknown): JsonObject {
  return record('response_item', {
    type: 'message',
    role,
    content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
  }, timestamp);
}

function responseThinking(text: string, timestamp: unknown): JsonObject {
  return record('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text }] }, timestamp);
}

function responseToolCall(block: Extract<NormalizedBlock, { kind: 'tool-call' }>, timestamp: unknown): JsonObject {
  return record('response_item', {
    type: 'custom_tool_call',
    ...(block.id ? { call_id: block.id } : {}),
    name: block.name,
    input: block.input,
  }, timestamp);
}

function responseToolResult(block: Extract<NormalizedBlock, { kind: 'tool-result' }>, timestamp: unknown): JsonObject {
  return record('response_item', {
    type: 'custom_tool_call_output',
    ...(block.id ? { call_id: block.id } : {}),
    ...(block.toolName ? { tool_name: block.toolName } : {}),
    output: block.output,
    ...(block.error ? { status: 'error', error: true } : {}),
  }, timestamp);
}

function lifecycle(type: string, text: string | undefined, timestamp: unknown): JsonObject {
  return record('event_msg', {
    type,
    ...(text ? { message: text } : {}),
  }, timestamp);
}

function errorText(value: JsonObject, message?: JsonObject): string | undefined {
  return contentText(value.message ?? value.error ?? value.reason ?? value.text)
    || contentText(message?.content)
    || undefined;
}

type NormalizedUsage = ReturnType<typeof codexUsage>;

function usageRecord(values: NormalizedUsage, turnId: string, timestamp: unknown, usageId = turnId): JsonObject | undefined {
  if (values.input === undefined && values.output === undefined) return undefined;
  const lastTokenUsage: JsonObject = {
    ...(values.input !== undefined ? { input_tokens: values.input } : {}),
    ...(values.output !== undefined ? { output_tokens: values.output } : {}),
    ...(values.cacheRead !== undefined ? {
      cached_input_tokens: values.cacheRead,
      cache_read_input_tokens: values.cacheRead,
    } : {}),
    ...(values.cacheCreate !== undefined ? {
      cache_write_input_tokens: values.cacheCreate,
      cache_creation_input_tokens: values.cacheCreate,
    } : {}),
    ...(values.cacheWrite5m !== undefined || values.cacheWrite1h !== undefined ? {
      cache_creation: {
        ...(values.cacheWrite5m !== undefined ? { ephemeral_5m_input_tokens: values.cacheWrite5m } : {}),
        ...(values.cacheWrite1h !== undefined ? { ephemeral_1h_input_tokens: values.cacheWrite1h } : {}),
      },
    } : {}),
    input_tokens_includes_cache: true,
  };
  return record('event_msg', {
    type: 'token_count',
    info: {
      turn_id: turnId,
      usage_id: usageId,
      last_token_usage: lastTokenUsage,
    },
  }, timestamp);
}

function rawId(value: JsonObject, message: JsonObject | undefined, agentId: string, index: number): string {
  return firstString(message, ['id', 'messageId', 'message_id'])
    ?? firstString(value, ['uuid', 'id', 'messageId', 'message_id'])
    ?? `${agentId}:message:${index}`;
}

class ClaudeSession implements ProviderSession {
  readonly harness: ClaudeHarness;
  readonly header: unknown;
  private readonly identity: ClaudeIdentity;
  private headerEmitted = false;
  private currentModel?: string;
  private currentProvider?: string;
  private currentServiceTier?: string;
  private currentEffort?: string;
  private currentCwd?: string;
  private readonly usageMessageValues = new Map<string, NormalizedUsage>();

  constructor(identity: ClaudeIdentity, header: JsonObject) {
    this.harness = identity.harness;
    this.identity = identity;
    this.header = header;
    this.currentModel = identity.model;
    this.currentProvider = identity.provider;
    this.currentServiceTier = identity.serviceTier;
    this.currentEffort = identity.effort;
    this.currentCwd = identity.cwd;
  }

  normalize(value: unknown, index: number): unknown[] {
    const output: unknown[] = [];
    if (!this.headerEmitted) {
      output.push(this.header);
      this.headerEmitted = true;
    }
    if (!isObject(value)) return output;
    const message = messageOf(value);
    const type = firstString(value, ['type'])?.toLowerCase();
    const timestamp = rawTimestamp(value, message);

    const model = firstString(message, ['model', 'model_id', 'modelId'])
      ?? firstString(value, ['model', 'model_id', 'modelId'])
      ?? this.currentModel;
    const provider = firstString(message, ['provider', 'model_provider', 'modelProvider'])
      ?? firstString(value, ['provider', 'model_provider', 'modelProvider'])
      ?? this.currentProvider;
    const messageUsage = message?.usage ?? value.usage;
    const usageObject = isObject(messageUsage) ? messageUsage : undefined;
    const serviceTier = firstString(message, ['service_tier', 'serviceTier', 'tier'])
      ?? firstString(value, ['service_tier', 'serviceTier', 'tier'])
      ?? firstString(usageObject, ['service_tier', 'serviceTier', 'tier'])
      ?? this.currentServiceTier;
    const effort = firstString(message, ['effort', 'reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'thinking_level'])
      ?? firstString(value, ['effort', 'reasoning_effort', 'reasoningEffort', 'thinkingLevel', 'thinking_level'])
      ?? this.currentEffort;
    const cwd = firstString(value, ['cwd', 'working_directory', 'workingDirectory']) ?? this.currentCwd;
    this.currentModel = model;
    this.currentProvider = provider;
    this.currentServiceTier = serviceTier;
    this.currentEffort = effort;
    this.currentCwd = cwd;

    const turnId = rawId(value, message, this.identity.agentId, index);
    const addContext = () => output.push(turnContext(turnId, timestamp, model, provider, serviceTier, effort, cwd));
    const addUsage = (usage: unknown, usageId = turnId) => {
      if (!isObject(usage)) return;
      const normalizedValues = codexUsage(usage);
      const previous = this.usageMessageValues.get(usageId);
      const merged: NormalizedUsage = {
        ...(normalizedValues.input !== undefined || previous?.input !== undefined
          ? { input: Math.max(normalizedValues.input ?? 0, previous?.input ?? 0) } : {}),
        ...(normalizedValues.output !== undefined || previous?.output !== undefined
          ? { output: Math.max(normalizedValues.output ?? 0, previous?.output ?? 0) } : {}),
        ...(normalizedValues.cacheRead !== undefined || previous?.cacheRead !== undefined
          ? { cacheRead: Math.max(normalizedValues.cacheRead ?? 0, previous?.cacheRead ?? 0) } : {}),
        ...(normalizedValues.cacheCreate !== undefined || previous?.cacheCreate !== undefined
          ? { cacheCreate: Math.max(normalizedValues.cacheCreate ?? 0, previous?.cacheCreate ?? 0) } : {}),
        ...(normalizedValues.cacheWrite5m !== undefined || previous?.cacheWrite5m !== undefined
          ? { cacheWrite5m: Math.max(normalizedValues.cacheWrite5m ?? 0, previous?.cacheWrite5m ?? 0) } : {}),
        ...(normalizedValues.cacheWrite1h !== undefined || previous?.cacheWrite1h !== undefined
          ? { cacheWrite1h: Math.max(normalizedValues.cacheWrite1h ?? 0, previous?.cacheWrite1h ?? 0) } : {}),
      };
      if (previous && JSON.stringify(previous) === JSON.stringify(merged)) return;
      const normalized = usageRecord(merged, turnId, timestamp, usageId);
      if (!normalized) return;
      this.usageMessageValues.set(usageId, merged);
      output.push(normalized);
    };
    const addBlock = (block: NormalizedBlock, role: 'user' | 'assistant') => {
      if (block.kind === 'text') output.push(responseMessage(role, block.text, timestamp));
      else if (block.kind === 'thinking') output.push(responseThinking(block.text, timestamp));
      else if (block.kind === 'tool-call') output.push(responseToolCall(block, timestamp));
      else if (block.kind === 'tool-result') output.push(responseToolResult(block, timestamp));
      else output.push(responseMessage(role, block.text, timestamp));
    };

    if ((type === 'assistant' || type === 'user') && message) {
      addContext();
      const role = messageRole(value, message);
      const blocks = normalizedBlocks(message.content);
      for (const block of blocks) addBlock(block, role === 'user' ? 'user' : 'assistant');
      if (type === 'user' && role !== 'user' && blocks.length === 0) {
        const text = contentText(message.content);
        if (text) output.push(responseMessage('user', text, timestamp));
      }
      addUsage(messageUsage, rawId(value, message, this.identity.agentId, index));
      // Claude Code also stores a structured toolUseResult copy of the result
      // already present as a tool_result block. That copy has no tool_use_id,
      // so it is only used when the message carries no result block.
      if (type === 'user' && value.toolUseResult !== undefined && !blocks.some((block) => block.kind === 'tool-result')) {
        const toolUseResult = isObject(value.toolUseResult) ? value.toolUseResult : { output: value.toolUseResult };
        const id = firstString(toolUseResult, ['toolCallId', 'tool_use_id', 'toolUseId', 'call_id', 'callId'])
          ?? firstString(value, ['toolUseId', 'tool_use_id', 'toolCallId']);
        const result: NormalizedBlock = {
          kind: 'tool-result',
          ...(id ? { id } : {}),
          output: toolUseResult.output ?? toolUseResult.content ?? value.toolUseResult,
          error: toolUseResult.isError === true || toolUseResult.is_error === true || toolUseResult.status === 'error',
          ...(firstString(toolUseResult, ['toolName', 'tool_name', 'name']) ? { toolName: firstString(toolUseResult, ['toolName', 'tool_name', 'name']) } : {}),
        };
        addBlock(result, 'user');
      }
      const stopReason = firstString(message, ['stop_reason', 'stopReason'])?.toLowerCase();
      if (stopReason === 'error' || stopReason === 'aborted') {
        output.push(lifecycle('error', errorText(value, message) ?? `Turn ${stopReason}`, timestamp));
      } else if ((stopReason === 'end_turn' || stopReason === 'stop_sequence' || stopReason === 'stop')
        && !blocks.some((block) => block.kind === 'tool-call')) {
        output.push(lifecycle('task_complete', 'Turn completed', timestamp));
      }
      return output;
    }

    if (type === 'result') {
      addContext();
      const resultText = contentText(value.result ?? value.message ?? value.text);
      if (resultText) output.push(responseMessage('assistant', resultText, timestamp));
      // Claude result envelopes often repeat the session's cumulative usage
      // after the per-message usage records. Keep it only for traces that have
      // no per-message usage at all; otherwise it would become a second turn
      // and inflate the aggregate.
      if (!this.usageMessageValues.size) {
        addUsage(value.usage, rawId(value, undefined, this.identity.agentId, index));
      }
      const subtype = firstString(value, ['subtype', 'status'])?.toLowerCase();
      const failed = value.is_error === true || value.isError === true || !!subtype?.match(/error|fail|abort|cancel/);
      output.push(lifecycle(failed ? 'error' : 'task_complete', resultText || (failed ? 'Task failed' : 'Task completed'), timestamp));
      return output;
    }

    if (type === 'error' || type === 'turn_aborted' || type === 'turn_failed' || type === 'task_failed') {
      addContext();
      output.push(lifecycle('error', errorText(value, message) ?? 'Task failed', timestamp));
      return output;
    }

    if (type === 'system') {
      const subtype = firstString(value, ['subtype', 'event'])?.toLowerCase();
      const text = errorText(value, message);
      if (subtype?.match(/error|fail|abort|cancel/)) {
        addContext();
        output.push(lifecycle('error', text ?? 'System error', timestamp));
      } else if (subtype?.match(/compact|summary|context/)) {
        addContext();
        if (text) output.push(responseThinking(`Context compacted: ${text}`, timestamp));
      } else if (text && subtype !== 'turn_duration') {
        addContext();
        output.push(responseMessage('assistant', text, timestamp));
      }
      return output;
    }

    if (type === 'summary' || type === 'compaction' || type === 'compact_boundary') {
      addContext();
      const text = contentText(value.summary ?? value.message ?? value.content ?? value.text);
      if (text) output.push(responseThinking(`Context compacted: ${text}`, timestamp));
      return output;
    }

    if (type === 'turn_end' || type === 'turn_complete' || type === 'end_turn' || type === 'session_end') {
      addContext();
      output.push(lifecycle('turn_complete', errorText(value, message) ?? 'Turn completed', timestamp));
      return output;
    }

    // A small number of exports write a top-level tool result envelope.
    if (type === 'tool_result' || type === 'tool_use_result') {
      addContext();
      const block: NormalizedBlock = {
        kind: 'tool-result',
        ...(firstString(value, ['tool_use_id', 'toolUseId', 'toolCallId', 'call_id', 'callId']) ? { id: firstString(value, ['tool_use_id', 'toolUseId', 'toolCallId', 'call_id', 'callId']) } : {}),
        output: value.output ?? value.content ?? value.result,
        error: value.is_error === true || value.isError === true || String(value.status ?? '').toLowerCase() === 'error',
      };
      output.push(responseToolResult(block, timestamp));
    }
    return output;
  }
}

function hasClaudeMessage(value: JsonObject): boolean {
  const type = firstString(value, ['type'])?.toLowerCase();
  const message = messageOf(value);
  const role = messageRole(value, message);
  if ((type === 'assistant' && role === 'assistant') || (type === 'user' && role === 'user')) return true;
  return type === 'result' || type === 'system' || type === 'summary' || type === 'error';
}

function hasClaudeSignal(value: JsonObject, tracePath: string): boolean {
  const message = messageOf(value);
  const type = firstString(value, ['type'])?.toLowerCase();
  const knownEnvelope = type === 'assistant' || type === 'user' || type === 'result' || type === 'system'
    || type === 'summary' || type === 'error';
  const content = message?.content;
  const knownBlock = Array.isArray(content) && content.some((block) => isObject(block) && [
    'thinking', 'redacted_thinking', 'tool_use', 'tool_result',
  ].includes(blockType(block)));
  const sessionSignal = !!firstString(value, [
    'sessionId', 'session_id', 'uuid', 'parentUuid', 'cwd', 'version',
  ]) || !!firstString(message, ['model', 'model_id', 'provider']) || message?.usage !== undefined;
  const pathSignal = pathLower(tracePath).includes('/.claude/') || pathLower(tracePath).includes('/.hermes/');
  return hasClaudeMessage(value) && (knownEnvelope && (sessionSignal || knownBlock || pathSignal));
}

function isHermesMarker(value: JsonObject): boolean {
  return firstString(value, ['version', 'harness', 'source']) === 'hermes-agent'
    || value.harness === 'hermes'
    || value.provider === 'hermes-agent';
}

/**
 * Creates a Claude Code session normalizer. Hermes Claude exports use this
 * same envelope with `harness: 'hermes'`, while the native Hermes database is
 * intentionally left to its own worker.
 */
export function createClaudeSession(
  value: unknown,
  tracePath: string,
  harness: ClaudeHarness = 'claude',
): ProviderSession | null {
  if (!isObject(value)) return null;
  const lowerPath = pathLower(tracePath);
  const hermes = isHermesMarker(value) || lowerPath.includes('/.hermes/');
  if (harness === 'claude' && hermes) return null;
  if (harness === 'hermes' && !hermes) return null;
  if (!hasClaudeSignal(value, tracePath)) return null;
  const identity = deriveIdentity(value, tracePath, harness);
  return new ClaudeSession(identity, syntheticHeader(identity, value));
}

export default createClaudeSession;
