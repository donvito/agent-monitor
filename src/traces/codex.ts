import type { Agent, AgentEvent, AgentStatus, AgentType, TraceEntry } from '../shared/types';

/** A parsed JSONL record. `index` is the line number in the source file. */
export interface TraceRecord {
  value: unknown;
  index?: number;
  raw?: string;
}

export interface CodexObservation {
  agent: Agent;
  entries: TraceEntry[];
  completed: boolean;
  failed: boolean;
  lastTimestamp?: number;
  completionTimestamp?: number;
}

export interface CodexAdapterOptions {
  now?: number;
  tracePath?: string;
  previous?: Agent;
}

const TOOL_CALL_TYPES = new Set([
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'computer_call',
  'web_search_call',
  'tool_call',
  'mcp_tool_call',
]);

const TOOL_RESULT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
  'computer_call_output',
  'web_search_call_output',
  'tool_call_output',
  'web_search_tool_result',
  'mcp_tool_result',
]);

const COMPLETION_TYPES = new Set([
  'task_complete',
  'task_completed',
  'turn_complete',
  'turn_completed',
  'turn_complete_success',
  'session_complete',
  'session_completed',
  'completed',
  'shutdown',
  'done',
]);

const ERROR_TYPES = new Set([
  'error',
  'turn_aborted',
  'turn_failed',
  'task_failed',
  'session_error',
  'fatal_error',
]);

/** The maximum number of normalized timeline entries retained for one trace. */
export const MAX_TRACE_ENTRIES = 1000;
/** A single normalized item remains useful at large sizes without retaining an unbounded payload. */
export const MAX_TRACE_TEXT_LENGTH = 64 * 1024;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function timestamp(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value);
  if (numeric !== undefined) {
    // Codex timestamps are normally ISO strings, but accept Unix seconds and
    // milliseconds for fixtures and older exports.
    const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(millis) ? millis : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return undefined;
}

function firstString(object: JsonObject | undefined, keys: string[]): string | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = asString(object[key]);
    if (value) return value;
  }
  return undefined;
}

function numberFrom(object: JsonObject | undefined, keys: string[]): number | undefined {
  if (!object) return undefined;
  for (const key of keys) {
    const value = asFiniteNumber(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function contentText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (isObject(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.thinking === 'string') return value.thinking;
    if (typeof value.summary_text === 'string') return value.summary_text;
    if (typeof value.summary === 'string') return value.summary;
    if (typeof value.content === 'string' || Array.isArray(value.content)) return contentText(value.content);
    if (typeof value.output === 'string' || Array.isArray(value.output)) return contentText(value.output);
  }
  return '';
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function payloadOf(value: JsonObject): JsonObject {
  return isObject(value.payload) ? value.payload : {};
}

function recordTimestamp(value: JsonObject, payload?: JsonObject): number | undefined {
  return timestamp(value.timestamp) ?? timestamp(payload?.timestamp);
}

function truncateText(value: string, limit = MAX_TRACE_TEXT_LENGTH): string {
  const text = value.trim();
  return text.length > limit ? `${text.slice(0, limit - 18)}… [truncated]` : text;
}

function traceIdFor(record: JsonObject, payload: JsonObject, index: number, agentId: string, kind: TraceEntry['kind']): string {
  // Line number is part of the key: a tool call and its output legitimately
  // share call_id, and duplicate ids would make timeline keys unstable.
  const sourceId = firstString(record, ['id', 'ordinal']) ?? firstString(payload, ['id', 'call_id', 'callId']);
  return `${agentId}:${index}:${kind}${sourceId ? `:${sourceId}` : ''}`;
}

function usageValues(usage: JsonObject | undefined): { input?: number; output?: number } {
  return {
    input: numberFrom(usage, ['input_tokens', 'inputTokens', 'input', 'prompt_tokens', 'promptTokens']),
    output: numberFrom(usage, ['output_tokens', 'outputTokens', 'output', 'completion_tokens', 'completionTokens']),
  };
}

function sessionMeta(records: TraceRecord[]): JsonObject | undefined {
  for (const record of records) {
    const value = isObject(record.value) ? record.value : undefined;
    if (value?.type !== 'session_meta') continue;
    if (isObject(value.payload)) return value.payload;
  }
  return undefined;
}

function normaliseRecords(records: Array<TraceRecord | unknown>): TraceRecord[] {
  return records.map((record, index) => {
    if (isObject(record) && 'value' in record && ('index' in record || 'raw' in record)) {
      return {
        value: record.value,
        index: asFiniteNumber(record.index) ?? index,
        raw: typeof record.raw === 'string' ? record.raw : undefined,
      };
    }
    return { value: record, index };
  });
}

function addEntry(entries: TraceEntry[], entry: TraceEntry): void {
  if (!entry.text.trim() && entry.kind !== 'tool-result' && !(entry.kind === 'error' && entry.callId)) return;
  entries.push({ ...entry, text: truncateText(entry.text) });
  if (entries.length > MAX_TRACE_ENTRIES) entries.splice(0, entries.length - MAX_TRACE_ENTRIES);
}

function timelineEntry(
  record: TraceRecord,
  agentId: string,
  kind: TraceEntry['kind'],
  text: string,
  fallbackTimestamp?: number,
): TraceEntry {
  const value = isObject(record.value) ? record.value : {};
  const payload = payloadOf(value);
  return {
    id: traceIdFor(value, payload, record.index ?? 0, agentId, kind),
    timestamp: recordTimestamp(value, payload) ?? fallbackTimestamp,
    kind,
    text,
  };
}

function responseText(payload: JsonObject, role: string): string {
  const text = contentText(payload.content);
  if (text) return text;
  if (role === 'assistant') return contentText(payload.message);
  return '';
}

function toolInput(payload: JsonObject): string {
  const input = payload.input ?? payload.arguments ?? payload.parameters ?? payload.command ?? payload.action;
  return stringify(parseJsonValue(input));
}

function completionType(type: string | undefined): boolean {
  if (!type) return false;
  const normal = type.toLowerCase();
  return COMPLETION_TYPES.has(normal);
}

function errorType(type: string | undefined): boolean {
  if (!type) return false;
  const normal = type.toLowerCase();
  return ERROR_TYPES.has(normal);
}

function traceType(threadSource: string | undefined): AgentType {
  if (threadSource === 'user') return 'main';
  if (threadSource === 'subagent') return 'subagent';
  return 'unknown';
}

export function roleFromAgentPath(agentPath: string | undefined): string | undefined {
  if (!agentPath) return undefined;
  const trimmed = agentPath.trim().replace(/\/+$/, '');
  const segments = trimmed.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (!last || last === 'root' || last === 'main') return undefined;
  return last
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bUi\b/g, 'UI')
    .replace(/\bApi\b/g, 'API')
    .replace(/\bPr\b/g, 'PR')
    .replace(/\bDb\b/g, 'DB');
}

/**
 * Adapter for Codex rollout JSONL. It intentionally keeps provider details in
 * this module so the monitor and graph only consume Agent and TraceEntry.
 */
export class CodexAdapter {
  static detect(records: Array<TraceRecord | unknown>): boolean {
    return sessionMeta(normaliseRecords(records)) !== undefined;
  }

  detect(records: Array<TraceRecord | unknown>): boolean {
    return CodexAdapter.detect(records);
  }

  inspect(recordsInput: Array<TraceRecord | unknown>, options: CodexAdapterOptions = {}): CodexObservation | null {
    const records = normaliseRecords(recordsInput);
    const meta = sessionMeta(records);
    if (!meta) return null;

    const threadId = firstString(meta, ['thread_id', 'threadId', 'id']);
    const sessionId = firstString(meta, ['session_id', 'sessionId']);
    const tracePath = options.tracePath;
    const agentId = threadId ?? (tracePath ? `codex:${tracePath}` : sessionId ? `codex:session:${sessionId}` : `codex:trace`);
    const source = firstString(meta, ['thread_source', 'threadSource']);
    const type = traceType(source);
    const parentThreadId = firstString(meta, ['parent_thread_id', 'parentThreadId']);
    const now = options.now ?? Date.now();

    let model = firstString(meta, ['model', 'model_id', 'modelId']);
    let provider = firstString(meta, ['model_provider', 'provider']);
    let effort: string | undefined;
    let cwd = firstString(meta, ['cwd', 'working_directory', 'rollout_cwd']);
    let lastTimestamp: number | undefined;
    let completionTimestamp: number | undefined;
    let activity: string | undefined;
    let completed = false;
    let failed = false;
    let completionIndex: number | undefined;
    let errorIndex: number | undefined;
    let latestActivityIndex: number | undefined;
    let lastRecordWasMeaningful = false;

    const entries: TraceEntry[] = [];
    const toolIds = new Set<string>();
    const errorIds = new Set<string>();
    const turnUsage = new Map<string, { input: number; output: number }>();
    let latestTotal: { input: number; output: number } | undefined;
    let largestLastUsage: { input: number; output: number } | undefined;
    let currentTurnId: string | undefined;
    let fallbackTurn = 0;

    const entryFor = (record: TraceRecord, kind: TraceEntry['kind'], text: string, timestamp: number): TraceEntry => ({
      ...timelineEntry(record, agentId, kind, text, timestamp),
      model,
      reasoningEffort: effort,
      turnId: currentTurnId,
    });

    for (const record of records) {
      const value = isObject(record.value) ? record.value : undefined;
      if (!value) continue;
      const payload = payloadOf(value);
      const outerTimestamp = recordTimestamp(value, payload);
      if (outerTimestamp !== undefined) lastTimestamp = Math.max(lastTimestamp ?? outerTimestamp, outerTimestamp);

      if (value.type === 'session_meta') {
        lastRecordWasMeaningful = false;
        continue;
      }

      if (value.type === 'turn_context') {
        currentTurnId = firstString(payload, ['turn_id', 'turnId']) ?? currentTurnId;
        model = firstString(payload, ['model', 'model_id', 'modelId']) ?? model;
        provider = firstString(payload, ['model_provider', 'provider']) ?? provider;
        cwd = firstString(payload, ['cwd', 'working_directory']) ?? cwd;
        const settings = isObject(payload.collaboration_mode) && isObject(payload.collaboration_mode.settings)
          ? payload.collaboration_mode.settings
          : undefined;
        effort = firstString(settings, ['reasoning_effort'])
          ?? firstString(payload, ['effort', 'reasoning_effort'])
          ?? effort;
        continue;
      }

      const outerType = firstString(value, ['type']);
      const innerType = firstString(payload, ['type']);
      const typeName = (innerType ?? outerType)?.toLowerCase();
      const lineTimestamp = outerTimestamp ?? now;

      if (value.type === 'event_msg') {
        if (typeName === 'task_started' || typeName === 'turn_started') {
          currentTurnId = firstString(payload, ['turn_id', 'turnId', 'id']) ?? `turn-${++fallbackTurn}`;
          completed = false;
          failed = false;
          latestActivityIndex = record.index;
          activity = 'Working';
          addEntry(entries, entryFor(record, 'event', 'Task started', lineTimestamp));
          lastRecordWasMeaningful = true;
          continue;
        }
        if (typeName === 'user_message') {
          const text = contentText(payload.message ?? payload.text ?? payload.content);
          if (text) {
            completed = false;
            failed = false;
            latestActivityIndex = record.index;
            addEntry(entries, entryFor(record, 'user', text, lineTimestamp));
            activity = text;
            lastRecordWasMeaningful = true;
          }
          continue;
        }
        if (typeName === 'agent_message') {
          const text = contentText(payload.message ?? payload.text ?? payload.content);
          if (text) {
            completed = false;
            failed = false;
            latestActivityIndex = record.index;
            addEntry(entries, entryFor(record, 'assistant', text, lineTimestamp));
            activity = text;
            lastRecordWasMeaningful = true;
          }
          continue;
        }
        if (typeName === 'token_count') {
          const info = isObject(payload.info) ? payload.info : payload;
          const total = isObject(info.total_token_usage) ? info.total_token_usage : undefined;
          const last = isObject(info.last_token_usage) ? info.last_token_usage : undefined;
          const totalValues = usageValues(total);
          if (totalValues.input !== undefined || totalValues.output !== undefined) {
            latestTotal = {
              input: totalValues.input ?? latestTotal?.input ?? 0,
              output: totalValues.output ?? latestTotal?.output ?? 0,
            };
          }
          const lastValues = usageValues(last);
          if (lastValues.input !== undefined || lastValues.output !== undefined) {
            const valueForTurn = {
              input: lastValues.input ?? 0,
              output: lastValues.output ?? 0,
            };
            const tokenTurn = firstString(info, ['turn_id', 'turnId']) ?? currentTurnId;
            if (tokenTurn) {
              const previous = turnUsage.get(tokenTurn) ?? { input: 0, output: 0 };
              turnUsage.set(tokenTurn, {
                input: Math.max(previous.input, valueForTurn.input),
                output: Math.max(previous.output, valueForTurn.output),
              });
            } else if (!largestLastUsage || valueForTurn.input > largestLastUsage.input || valueForTurn.output > largestLastUsage.output) {
              largestLastUsage = valueForTurn;
            }
          }
          const usageText = latestTotal
            ? `Usage: ${latestTotal.input} input · ${latestTotal.output} output`
            : lastValues.input !== undefined || lastValues.output !== undefined
              ? `Usage: ${lastValues.input ?? 0} input · ${lastValues.output ?? 0} output`
              : '';
          if (usageText) {
            const entry = entryFor(record, 'usage', usageText, lineTimestamp);
            // The text may be a running total; keep this request's own counts separately.
            if (lastValues.input !== undefined || lastValues.output !== undefined) {
              entry.usage = { input: lastValues.input ?? 0, output: lastValues.output ?? 0 };
            }
            addEntry(entries, entry);
          }
          lastRecordWasMeaningful = !!usageText;
          continue;
        }
        const completion = completionType(typeName);
        const error = errorType(typeName);
        if (completion || error) {
          const text = contentText(payload.message ?? payload.reason ?? payload.text) || (completion ? 'Task completed' : 'Task failed');
          addEntry(entries, entryFor(record, error ? 'error' : 'event', text, lineTimestamp));
          if (completion) {
            completed = true;
            completionIndex = record.index;
            completionTimestamp = lineTimestamp;
          }
          if (error) {
            failed = true;
            errorIndex = record.index;
          }
          activity = text;
          lastRecordWasMeaningful = true;
          continue;
        }
      }

      if (value.type === 'response_item') {
        if (typeName === 'message') {
          const role = firstString(payload, ['role']) ?? 'assistant';
          const text = responseText(payload, role);
          if (text) {
            completed = false;
            failed = false;
            latestActivityIndex = record.index;
            addEntry(entries, entryFor(record, role === 'user' ? 'user' : 'assistant', text, lineTimestamp));
            activity = text;
            lastRecordWasMeaningful = true;
          }
          continue;
        }
        if (typeName === 'reasoning') {
          const text = contentText(payload.summary ?? payload.reasoning ?? payload.content);
          if (text) {
            addEntry(entries, entryFor(record, 'thinking', text, lineTimestamp));
            activity = 'Reasoning';
            lastRecordWasMeaningful = true;
          }
          continue;
        }
        if (typeName && TOOL_CALL_TYPES.has(typeName)) {
          const callId = firstString(payload, ['call_id', 'callId', 'id']);
          if (callId) toolIds.add(callId);
          const name = firstString(payload, ['name', 'tool_name', 'toolName']) ?? (typeName === 'local_shell_call' ? 'shell' : typeName.replace(/_call$/, ''));
          const input = toolInput(payload);
          const text = input ? `${name}: ${input}` : name;
          completed = false;
          failed = false;
          latestActivityIndex = record.index;
          addEntry(entries, { ...entryFor(record, 'tool-call', text, lineTimestamp), callId, toolName: name });
          activity = `Using ${name}`;
          lastRecordWasMeaningful = true;
          continue;
        }
        if (typeName && TOOL_RESULT_TYPES.has(typeName)) {
          const callId = firstString(payload, ['call_id', 'callId', 'id']);
          const result = payload.output ?? payload.result ?? payload.content;
          const error = firstString(payload, ['status'])?.toLowerCase() === 'error' || payload.error === true;
          if (error && callId) errorIds.add(callId);
          addEntry(entries, { ...entryFor(record, error ? 'error' : 'tool-result', stringify(result), lineTimestamp), callId });
          if (error) {
            failed = true;
            errorIndex = record.index;
          } else {
            completed = false;
            latestActivityIndex = record.index;
          }
          activity = 'Tool result';
          lastRecordWasMeaningful = true;
          continue;
        }
        if (completionType(typeName) || errorType(typeName)) {
          const failedRecord = errorType(typeName);
          const text = contentText(payload.message ?? payload.reason ?? payload.text) || (failedRecord ? 'Task failed' : 'Task completed');
          addEntry(entries, entryFor(record, failedRecord ? 'error' : 'event', text, lineTimestamp));
          completed ||= !failedRecord;
          failed ||= failedRecord;
          if (!failedRecord) {
            completionTimestamp = lineTimestamp;
            completionIndex = record.index;
          } else {
            errorIndex = record.index;
          }
          activity = text;
          lastRecordWasMeaningful = true;
          continue;
        }
      }

      // Codex has also emitted top-level completion/error records in older
      // versions. Keep the evidence-based status rules broad but explicit.
      if (completionType(typeName) || errorType(typeName)) {
        const failedRecord = errorType(typeName);
        const text = contentText(value.message ?? payload.message ?? payload.reason) || (failedRecord ? 'Task failed' : 'Task completed');
        addEntry(entries, entryFor(record, failedRecord ? 'error' : 'event', text, lineTimestamp));
        completed ||= !failedRecord;
        failed ||= failedRecord;
        if (!failedRecord) {
          completionTimestamp = lineTimestamp;
          completionIndex = record.index;
        } else {
          errorIndex = record.index;
        }
        activity = text;
        lastRecordWasMeaningful = true;
      }
    }

    let inputTokens = latestTotal?.input;
    let outputTokens = latestTotal?.output;
    if (inputTokens === undefined || outputTokens === undefined) {
      let input = 0;
      let output = 0;
      for (const value of turnUsage.values()) {
        input += value.input;
        output += value.output;
      }
      if (!turnUsage.size && largestLastUsage) {
        input = largestLastUsage.input;
        output = largestLastUsage.output;
      }
      inputTokens = inputTokens ?? input;
      outputTokens = outputTokens ?? output;
    }

    // A malformed or metadata-only file is still a known Codex trace, but it
    // should remain in starting state until useful output arrives.
    const previous = options.previous;
    // A later turn can resume a trace after a prior completion/error. Completion
    // evidence only wins when it is the last lifecycle evidence in the file.
    if (latestActivityIndex !== undefined && completionIndex !== undefined && latestActivityIndex > completionIndex) {
      completed = false;
    }
    if (latestActivityIndex !== undefined && errorIndex !== undefined && latestActivityIndex > errorIndex) {
      failed = false;
    }
    const status: AgentStatus = failed
      ? 'error'
      : completed
        ? 'finished'
        : lastRecordWasMeaningful || entries.length > 0
          ? 'active'
          : 'starting';
    const agent: Agent = {
      id: agentId,
      runId: previous?.runId ?? agentId,
      parentId: previous?.parentId ?? null,
      harness: 'codex',
      type,
      status,
      ...(sessionId ? { sessionId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
      ...(() => {
        const agentPath = firstString(meta, ['agent_path', 'agentPath']);
        const role = firstString(meta, ['agent_role', 'agentRole']) ?? (type === 'subagent' ? roleFromAgentPath(agentPath) : undefined);
        return {
          ...(role ? { role } : {}),
          ...(firstString(meta, ['agent_nickname', 'agentNickname']) ? { nickname: firstString(meta, ['agent_nickname', 'agentNickname']) } : {}),
          ...(agentPath ? { agentPath } : {}),
        };
      })(),
      ...(cwd ? { cwd } : {}),
      ...(tracePath ? { tracePath } : {}),
      ...(timestamp(meta.timestamp) !== undefined ? { createdAt: timestamp(meta.timestamp) } : {}),
      ...(activity ? { activity: truncateText(activity, 200) } : {}),
      ...(lastTimestamp !== undefined ? { lastActivityAt: lastTimestamp } : {}),
      stats: {
        inputTokens: Math.max(0, inputTokens ?? 0),
        outputTokens: Math.max(0, outputTokens ?? 0),
        toolCalls: toolIds.size,
        errors: errorIds.size + (failed && errorIds.size === 0 ? 1 : 0),
      },
    };

    return { agent, entries, completed, failed, lastTimestamp, completionTimestamp };
  }

  parse(records: Array<TraceRecord | unknown>, options: CodexAdapterOptions = {}): CodexObservation | null {
    return this.inspect(records, options);
  }

  processUpdate(previous: Agent | null, records: Array<TraceRecord | unknown>, options: CodexAdapterOptions = {}): AgentEvent[] {
    const observation = this.inspect(records, { ...options, previous: previous ?? options.previous });
    if (!observation) return [];
    if (!previous) {
      return [{ type: observation.agent.type === 'subagent' ? 'agent.spawned' : 'agent.discovered', agent: observation.agent }];
    }
    const changes: Partial<Agent> = {};
    const keys: Array<keyof Agent> = [
      'runId', 'parentId', 'type', 'status', 'sessionId', 'threadId', 'parentThreadId',
      'model', 'provider', 'reasoningEffort', 'role', 'nickname', 'agentPath', 'cwd',
      'tracePath', 'createdAt', 'lastActivityAt', 'activity',
    ];
    for (const key of keys) {
      if (previous[key] !== observation.agent[key]) {
        (changes as Record<string, unknown>)[key] = observation.agent[key];
      }
    }
    if (JSON.stringify(previous.stats) !== JSON.stringify(observation.agent.stats)) changes.stats = observation.agent.stats;
    return Object.keys(changes).length
      ? [{ type: 'agent.updated', agentId: observation.agent.id, changes }]
      : [];
  }
}

export function getCodexMeta(records: Array<TraceRecord | unknown>): JsonObject | undefined {
  return sessionMeta(normaliseRecords(records));
}

export function codexTraceInfo(payload: unknown): {
  id?: string;
  type: AgentType;
  threadSource?: string;
  parentThreadId?: string;
  agentRole?: string;
  agentPath?: string;
  agentNickname?: string;
} {
  const meta = isObject(payload) ? payload : {};
  const threadSource = firstString(meta, ['thread_source', 'threadSource']);
  const type = traceType(threadSource);
  const agentPath = firstString(meta, ['agent_path', 'agentPath']);
  const agentRole = firstString(meta, ['agent_role', 'agentRole']) ?? (type === 'subagent' ? roleFromAgentPath(agentPath) : undefined);
  return {
    id: firstString(meta, ['thread_id', 'threadId', 'id']),
    type,
    ...(threadSource ? { threadSource } : {}),
    ...(firstString(meta, ['parent_thread_id', 'parentThreadId']) ? { parentThreadId: firstString(meta, ['parent_thread_id', 'parentThreadId']) } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(agentPath ? { agentPath } : {}),
    ...(firstString(meta, ['agent_nickname', 'agentNickname']) ? { agentNickname: firstString(meta, ['agent_nickname', 'agentNickname']) } : {}),
  };
}

export default CodexAdapter;
