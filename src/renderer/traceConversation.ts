import type { TraceEntry } from '../shared/types';

/** Optional provider metadata carried by normalized entries. */
export type TraceEntryDetails = TraceEntry & {
  callId?: string;
  toolName?: string;
  model?: string;
  reasoningEffort?: string;
  turnId?: string;
};

export interface ConversationTool {
  call: TraceEntryDetails;
  result?: TraceEntryDetails;
}

export type ConversationBlock =
  | { type: 'text' | 'thinking' | 'event' | 'usage' | 'error'; entry: TraceEntryDetails; updates?: number }
  | { type: 'tools'; tools: ConversationTool[] }
  | { type: 'tool-result'; entry: TraceEntryDetails };

export type ConversationGroupKind = 'user' | 'assistant' | 'event' | 'usage' | 'error' | 'tool';

export interface ConversationGroup {
  id: string;
  kind: ConversationGroupKind;
  blocks: ConversationBlock[];
  timestamp?: number;
  model?: string;
  reasoningEffort?: string;
  turnId?: string;
}

function valueFor(entry: TraceEntryDetails, key: 'model' | 'reasoningEffort' | 'turnId') {
  const value = entry[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function hasCallId(entry: TraceEntryDetails) {
  return typeof entry.callId === 'string' && entry.callId.trim().length > 0;
}

function isToolResult(entry: TraceEntryDetails) {
  // The adapter uses `error` for a failed tool output, so an error with a
  // call id still participates in the call/result registry.
  return entry.kind === 'tool-result' || (entry.kind === 'error' && hasCallId(entry));
}

function identityChanged(group: ConversationGroup, entry: TraceEntryDetails) {
  const nextModel = valueFor(entry, 'model');
  const nextEffort = valueFor(entry, 'reasoningEffort');
  const nextTurn = valueFor(entry, 'turnId');
  return Boolean(
    (group.model && nextModel && group.model !== nextModel)
      || (group.reasoningEffort && nextEffort && group.reasoningEffort !== nextEffort)
      || (group.turnId && nextTurn && group.turnId !== nextTurn),
  );
}

function addMetadata(group: ConversationGroup, entry: TraceEntryDetails) {
  group.model ||= valueFor(entry, 'model');
  group.reasoningEffort ||= valueFor(entry, 'reasoningEffort');
  group.turnId ||= valueFor(entry, 'turnId');
  if (group.timestamp === undefined && entry.timestamp !== undefined) group.timestamp = entry.timestamp;
}

function hasTools(group: ConversationGroup) {
  return group.blocks.some((block) => block.type === 'tools');
}

function createGroup(entry: TraceEntryDetails, index: number, kind: ConversationGroupKind): ConversationGroup {
  const group: ConversationGroup = {
    id: `conversation-${entry.id}-${index}`,
    kind,
    blocks: [],
  };
  addMetadata(group, entry);
  return group;
}

function addTool(group: ConversationGroup, tool: ConversationTool) {
  // Codex can emit token usage between two tool calls. Treat usage as
  // metadata for grouping purposes so those calls remain one tool section.
  let index = group.blocks.length - 1;
  while (index >= 0 && group.blocks[index].type === 'usage') index -= 1;
  const previous = group.blocks[index];
  if (previous?.type === 'tools') {
    previous.tools.push(tool);
  } else {
    group.blocks.push({ type: 'tools', tools: [tool] });
  }
}

function addEntry(group: ConversationGroup, entry: TraceEntryDetails, type: ConversationBlock['type']) {
  group.blocks.push({ type: type as 'text' | 'thinking' | 'event' | 'usage' | 'error', entry });
}

function toolInput(entry: TraceEntryDetails) {
  const text = entry.text.trim();
  const name = entry.toolName?.trim();
  if (!name) return text;
  const knownPrefix = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*`, 'i');
  return text.replace(knownPrefix, '');
}

function isTextPart(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string';
}

/** Tool payload as displayed: JSON pretty-printed, content-part arrays as their text. */
export function prettyTraceText(text: string) {
  const trimmed = text.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return text;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') return text;
    // Content-part arrays ([{type:"input_text", text}]) read better as their text.
    if (Array.isArray(parsed) && parsed.length && parsed.every(isTextPart)) {
      return parsed.map((part) => part.text).join('\n');
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return text;
  }
}

/** Returns the displayable tool input while keeping the normalized entry intact. */
export function getToolInput(entry: TraceEntryDetails) {
  return toolInput(entry);
}

/**
 * Groups normalized timeline entries into readable conversation cards.
 * Tool results are paired by call id through a registry, so ordering and
 * proximity never affect the association.
 */
export function groupTraceEntries(entries: readonly TraceEntryDetails[]): ConversationGroup[] {
  const pairsByIndex = new Map<number, ConversationTool>();
  const callsById = new Map<string, ConversationTool[]>();
  const waitingResults = new Map<string, TraceEntryDetails[]>();
  const consumedResultIndexes = new Set<number>();

  entries.forEach((entry, index) => {
    if (entry.kind === 'tool-call') {
      const pair: ConversationTool = { call: entry };
      const callId = entry.callId?.trim();
      if (callId) {
        const waiting = waitingResults.get(callId);
        const result = waiting?.shift();
        if (result) {
          pair.result = result;
          consumedResultIndexes.add(entries.indexOf(result));
        }
        if (waiting?.length === 0) waitingResults.delete(callId);
        const calls = callsById.get(callId) ?? [];
        calls.push(pair);
        callsById.set(callId, calls);
      }
      pairsByIndex.set(index, pair);
      return;
    }

    if (!isToolResult(entry) || !hasCallId(entry)) return;
    const callId = entry.callId!.trim();
    const calls = callsById.get(callId);
    const openCall = calls?.find((candidate) => !candidate.result);
    if (openCall) {
      openCall.result = entry;
      consumedResultIndexes.add(index);
      return;
    }
    const waiting = waitingResults.get(callId) ?? [];
    waiting.push(entry);
    waitingResults.set(callId, waiting);
  });

  const groups: ConversationGroup[] = [];
  let current: ConversationGroup | undefined;
  const start = (entry: TraceEntryDetails, index: number, kind: ConversationGroupKind) => {
    current = createGroup(entry, index, kind);
    groups.push(current);
    return current;
  };

  entries.forEach((entry, index) => {
    if (isToolResult(entry) && consumedResultIndexes.has(index)) return;

    if (entry.kind === 'tool-call') {
      if (!current || current.kind !== 'assistant' || identityChanged(current, entry)) {
        start(entry, index, 'assistant');
      } else {
        addMetadata(current, entry);
      }
      addTool(current!, pairsByIndex.get(index) ?? { call: entry });
      return;
    }

    if (entry.kind === 'thinking') {
      if (!current || current.kind !== 'assistant' || identityChanged(current, entry)) start(entry, index, 'assistant');
      else addMetadata(current, entry);
      const previous = current!.blocks.at(-1);
      // Providers can persist cumulative summary snapshots under different IDs.
      // Merge only contiguous prefix extensions; a tool/text/turn boundary or
      // a distinct summary keeps its own disclosure.
      if (previous?.type === 'thinking' && previous.entry.text.trim()
          && entry.text.trim().startsWith(previous.entry.text.trim())) {
        previous.entry = entry;
        previous.updates = (previous.updates ?? 1) + 1;
      } else addEntry(current!, entry, 'thinking');
      return;
    }

    if (entry.kind === 'assistant') {
      // A visible assistant response after tool calls starts a new card. This
      // keeps the tool work and its follow-up explanation visually distinct.
      if (!current || current.kind !== 'assistant' || hasTools(current) || identityChanged(current, entry)) {
        start(entry, index, 'assistant');
      } else {
        addMetadata(current, entry);
      }
      addEntry(current!, entry, 'text');
      return;
    }

    if (entry.kind === 'user') {
      start(entry, index, 'user');
      addEntry(current!, entry, 'text');
      return;
    }

    if (entry.kind === 'event') {
      start(entry, index, 'event');
      addEntry(current!, entry, 'event');
      return;
    }

    if (entry.kind === 'usage' && current?.kind === 'assistant' && !identityChanged(current, entry)) {
      addMetadata(current, entry);
      addEntry(current!, entry, 'usage');
      return;
    }

    if (entry.kind === 'usage') {
      start(entry, index, 'usage');
      addEntry(current!, entry, 'usage');
      return;
    }

    if (entry.kind === 'error' && !hasCallId(entry)) {
      start(entry, index, 'error');
      addEntry(current!, entry, 'error');
      return;
    }

    if (isToolResult(entry)) {
      // An output without a matching call is a first-class card. Keeping it
      // separate avoids making a nearby assistant response look like its
      // parent and preserves the orphan when its call was evicted.
      if (!current || current.kind !== 'tool' || identityChanged(current, entry)) start(entry, index, 'tool');
      else addMetadata(current, entry);
      current!.blocks.push({ type: 'tool-result', entry });
    }
  });

  return groups;
}

function blockText(block: ConversationBlock) {
  if (block.type === 'tools') {
    return block.tools.flatMap(({ call, result }) => [
      TRACE_KIND_LABEL.call,
      call.toolName ?? '',
      call.text,
      result?.text ?? '',
    ]).join('\n');
  }
  return block.entry.text;
}

const TRACE_KIND_LABEL = {
  call: 'Tool call',
};

/** Search text for a complete card, including paired tool input and result. */
export function conversationSearchText(group: ConversationGroup) {
  return [
    group.kind,
    group.model,
    group.reasoningEffort,
    group.turnId,
    ...group.blocks.map(blockText),
  ].filter(Boolean).join('\n').toLocaleLowerCase();
}

export function conversationGroupMatchesKind(group: ConversationGroup, kind: string) {
  if (kind === 'all') return true;
  if (kind === group.kind) return true;
  return group.blocks.some((block) => {
    if (kind === 'tool-call') return block.type === 'tools';
    if (kind === 'tool-result') return block.type === 'tool-result' || (block.type === 'tools' && block.tools.some((tool) => !!tool.result));
    if (kind === 'error') return block.type === 'error'
      || (block.type === 'tool-result' && block.entry.kind === 'error')
      || (block.type === 'tools' && block.tools.some((tool) => tool.result?.kind === 'error'));
    return block.type === kind || (block.type === 'text' && block.entry.kind === kind);
  });
}

export function filterConversationGroups(groups: readonly ConversationGroup[], search: string, kind = 'all') {
  const query = search.trim().toLocaleLowerCase();
  return groups.filter((group) => conversationGroupMatchesKind(group, kind)
    && (!query || conversationSearchText(group).includes(query)));
}

function blockEntries(block: ConversationBlock): TraceEntryDetails[] {
  if (block.type === 'tools') return block.tools.flatMap(({ call, result }) => result ? [call, result] : [call]);
  return [block.entry];
}

/**
 * Latest request's token usage inside a card. Structured per-request counts
 * win over the display text, which can be a running session total.
 */
export function conversationUsage(group: ConversationGroup) {
  for (let index = group.blocks.length - 1; index >= 0; index -= 1) {
    const block = group.blocks[index];
    if (block.type !== 'usage') continue;
    if (block.entry.usage) return { ...block.entry.usage };
    const match = block.entry.text.match(/([\d,]+)\s*input\D+([\d,]+)\s*output/i);
    if (match) return { input: Number(match[1].replace(/,/g, '')), output: Number(match[2].replace(/,/g, '')) };
  }
  return undefined;
}

/** Milliseconds between the first and last timestamped entry in a card. */
export function conversationDuration(group: ConversationGroup) {
  const times = group.blocks.flatMap(blockEntries)
    .map((entry) => entry.timestamp)
    .filter((time): time is number => typeof time === 'number' && Number.isFinite(time));
  if (times.length < 2) return undefined;
  const span = Math.max(...times) - Math.min(...times);
  return span > 0 ? span : undefined;
}

