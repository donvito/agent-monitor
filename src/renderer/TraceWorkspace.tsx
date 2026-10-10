import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronDown, ChevronRight, Copy, Home } from 'lucide-react';
import type { Agent, AgentHarness, TraceEntry } from '../shared/types';
import { Dropdown } from './Dropdown';
import { Markdown } from './Markdown';
import {
  conversationDuration,
  conversationUsage,
  filterConversationGroups,
  getToolInput,
  groupTraceEntries,
  type ConversationGroup,
  type ConversationTool,
  type TraceEntryDetails,
} from './traceConversation';
import './TraceWorkspace.css';

const MAX_RECENT_ENTRIES = 200;

const TRACE_KIND_LABEL: Record<TraceEntry['kind'], string> = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  'tool-call': 'Tool call',
  'tool-result': 'Tool result',
  usage: 'Usage',
  error: 'Error',
  event: 'Event',
};

const STATUS_LABEL: Record<Agent['status'], string> = {
  starting: 'Starting',
  active: 'Active',
  idle: 'Idle',
  finished: 'Finished',
  error: 'Error',
};

const STATUS_COLOR: Record<Agent['status'], string> = {
  starting: 'var(--status-starting)',
  active: 'var(--status-active)',
  idle: 'var(--status-idle)',
  finished: 'var(--status-finished)',
  error: 'var(--status-error)',
};

const HARNESS_LABEL: Record<AgentHarness, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  pi: 'Pi',
  hermes: 'Hermes',
  unknown: 'Agent',
};

const TRACE_KINDS = Object.keys(TRACE_KIND_LABEL) as TraceEntry['kind'][];

type TraceOrder = 'oldest' | 'newest';
const ORDER_STORAGE_KEY = 'agent-monitor.trace-order';
const ORDER_OPTIONS = [
  { value: 'oldest', label: 'Oldest first' },
  { value: 'newest', label: 'Newest first' },
];

function readOrder(): TraceOrder {
  try {
    return localStorage.getItem(ORDER_STORAGE_KEY) === 'newest' ? 'newest' : 'oldest';
  } catch {
    return 'oldest';
  }
}

function saveOrder(order: TraceOrder) {
  try { localStorage.setItem(ORDER_STORAGE_KEY, order); } catch { /* Order still applies for this view. */ }
}

type DisclosureProps = {
  openDisclosure: Set<string>;
  onToggle: (key: string) => void;
};

export function agentDisplayName(agent: Agent): string {
  if (agent.type === 'subagent' && agent.role) {
    return capitalize(agent.role);
  }
  return agent.nickname || (agent.role ? capitalize(agent.role) : undefined) || (agent.type === 'main' ? 'Main agent' : 'Subagent');
}

function titleFor(agent: Agent) {
  return agentDisplayName(agent);
}

function capitalize(text: string) {
  return text ? text[0].toLocaleUpperCase() + text.slice(1) : text;
}

function subagentLabel(agent: Agent) {
  return `${capitalize(agent.role || 'Subagent')}${agent.nickname ? ` · ${agent.nickname}` : ''}`;
}

function isoFor(timestamp: number | undefined) {
  if (!timestamp || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function demoTrace(agent: Agent): TraceEntryDetails[] {
  const base = agent.createdAt ?? Date.now() - 60_000;
  return [
    {
      id: `${agent.id}-demo-discovered`,
      timestamp: base,
      kind: 'event',
      text: `${titleFor(agent)} session discovered by the monitor.`,
    },
    {
      id: `${agent.id}-demo-activity`,
      timestamp: agent.lastActivityAt ?? base + 1_000,
      kind: 'assistant',
      text: agent.activity || 'Working through the current task.',
      model: agent.model,
      reasoningEffort: agent.reasoningEffort,
      turnId: `${agent.id}-demo-turn`,
    },
    {
      id: `${agent.id}-demo-tool`,
      timestamp: base + 2_000,
      kind: 'tool-call',
      text: 'search: rg --files src tests',
      callId: `${agent.id}-demo-call`,
      toolName: 'search',
    },
    {
      id: `${agent.id}-demo-result`,
      timestamp: base + 3_000,
      kind: 'tool-result',
      text: 'Found renderer entry points and shared agent types.',
      callId: `${agent.id}-demo-call`,
    },
  ];
}

function isTextPart(value: unknown): value is { text: string } {
  return typeof value === 'object' && value !== null && typeof (value as { text?: unknown }).text === 'string';
}

function prettyTraceText(text: string) {
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

function preview(text: string, length = 180) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > length ? `${compact.slice(0, length - 1)}…` : compact;
}

function groupLabel(kind: ConversationGroup['kind']) {
  if (kind === 'assistant') return 'Assistant';
  if (kind === 'user') return 'User';
  if (kind === 'tool') return 'Tool result';
  if (kind === 'usage') return 'Usage';
  if (kind === 'error') return 'Error';
  return 'Event';
}

function toolStatus(tool: ConversationTool) {
  if (!tool.result) return { label: 'no result', tone: 'pending' };
  return tool.result.kind === 'error' ? { label: 'error', tone: 'error' } : { label: 'complete', tone: 'complete' };
}

export interface TraceWorkspaceProps {
  agent: Agent;
  /** Agents in the same run, used to link parent and subagent traces. */
  agents?: Agent[];
  onOpenAgent?: (agent: Agent) => void;
  /** Opens several traces as tabs without leaving this one. */
  onOpenAgents?: (agents: Agent[]) => void;
  demo?: boolean;
}

export function TraceWorkspace({ agent, agents = [], onOpenAgent, onOpenAgents, demo = false }: TraceWorkspaceProps) {
  const searchId = useId();
  const [entries, setEntries] = useState<TraceEntryDetails[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<string>('all');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [order, setOrder] = useState<TraceOrder>(readOrder);
  // Keys the reader toggled away from each disclosure's default state.
  const [openDisclosure, setOpenDisclosure] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setEntries([]);
    setOpenDisclosure(new Set());

    if (demo) {
      setEntries(demoTrace(agent));
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    const bridge = typeof window === 'undefined' ? undefined : window.agentMonitor;
    if (!bridge) {
      setLoading(false);
      setError('The native monitor is unavailable in this browser session.');
      return () => {
        cancelled = true;
      };
    }

    void bridge.getTrace(agent.id)
      .then((nextEntries) => {
        if (cancelled) return;
        setEntries(nextEntries as TraceEntryDetails[]);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setLoading(false);
        setError('Trace could not be loaded from the native monitor.');
      });

    return () => {
      cancelled = true;
    };
  }, [agent.id, demo, refreshNonce]);

  const kindOptions = useMemo(() => [
    { value: 'all', label: 'All kinds' },
    ...TRACE_KINDS.map((traceKind) => ({ value: traceKind, label: TRACE_KIND_LABEL[traceKind] })),
  ], []);

  const recentEntries = entries.length > MAX_RECENT_ENTRIES ? entries.slice(-MAX_RECENT_ENTRIES) : entries;
  const groups = useMemo(() => groupTraceEntries(recentEntries), [recentEntries]);
  const filteredGroups = useMemo(() => {
    const matches = filterConversationGroups(groups, search, kind);
    return order === 'newest' ? matches.reverse() : matches;
  }, [groups, kind, order, search]);
  const isBounded = entries.length >= MAX_RECENT_ENTRIES;
  const hasFilter = Boolean(search.trim() || kind !== 'all');
  const subagents = agents.filter((candidate) => candidate.parentId === agent.id);
  const parent = agent.parentId ? agents.find((candidate) => candidate.id === agent.parentId) : undefined;

  function toggleDisclosure(key: string) {
    setOpenDisclosure((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function clearFilters() {
    setSearch('');
    setKind('all');
  }

  return (
    <section className="trace-workspace" aria-labelledby={`${searchId}-title`}>
      <div className="trace-workspace__content">
        <div className="trace-workspace__list">
          <TraceHeader
            agent={agent}
            titleId={`${searchId}-title`}
            itemCount={entries.length}
            subagents={subagents}
            parent={parent}
            loading={loading}
            onRefresh={() => setRefreshNonce((value) => value + 1)}
            onOpenAgent={onOpenAgent}
            onOpenAgents={onOpenAgents}
          />

          <div className="trace-workspace__toolbar">
            <div className="trace-workspace__search">
              <input
                id={searchId}
                type="search"
                aria-label="Search trace"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search conversation, tool, or result"
                autoComplete="off"
              />
            </div>
            <Dropdown label="Kind" value={kind} options={kindOptions} onChange={setKind} />
            <Dropdown
              label="Order"
              value={order}
              options={ORDER_OPTIONS}
              onChange={(value) => {
                const next = value === 'newest' ? 'newest' : 'oldest';
                setOrder(next);
                saveOrder(next);
              }}
            />
            <div className="trace-workspace__count" aria-live="polite">
              {filteredGroups.length} of {groups.length} conversations
            </div>
          </div>

          {isBounded && (
            <p className="trace-workspace__notice">
              Showing the most recent {Math.min(MAX_RECENT_ENTRIES, entries.length)} entries to keep the reader responsive.
            </p>
          )}

          {error && (
            <div className="trace-workspace__empty trace-workspace__empty--error" role="alert">
              <p>{error}</p>
              <button type="button" className="trace-workspace__button" onClick={() => setRefreshNonce((value) => value + 1)}>Retry</button>
            </div>
          )}
          {!error && loading && <div className="trace-workspace__empty" role="status">Loading normalized trace…</div>}
          {!error && !loading && !groups.length && (
            <div className="trace-workspace__empty">
              <p>No normalized trace entries are available for this agent.</p>
            </div>
          )}
          {!error && !loading && groups.length > 0 && !filteredGroups.length && (
            <div className="trace-workspace__empty">
              <p>No conversation cards match the current filters.</p>
              {hasFilter && <button type="button" className="trace-workspace__button" onClick={clearFilters}>Clear filters</button>}
            </div>
          )}
          {!error && !loading && filteredGroups.length > 0 && (
            <div className="trace-thread" aria-label="Normalized conversation trace">
              {filteredGroups.map((group) => (
                <ConversationCard
                  key={group.id}
                  group={group}
                  openDisclosure={openDisclosure}
                  onToggle={toggleDisclosure}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function TraceHeader({ agent, titleId, itemCount, subagents, parent, loading, onRefresh, onOpenAgent, onOpenAgents }: {
  agent: Agent;
  titleId: string;
  itemCount: number;
  subagents: Agent[];
  parent?: Agent;
  loading: boolean;
  onRefresh: () => void;
  onOpenAgent?: (agent: Agent) => void;
  onOpenAgents?: (agents: Agent[]) => void;
}) {
  const harness = HARNESS_LABEL[agent.harness];
  const isMain = agent.type === 'main';
  const modelLabel = [agent.model, agent.reasoningEffort && capitalize(agent.reasoningEffort)].filter(Boolean).join(' · ');
  const parentFile = parent?.tracePath?.split(/[\\/]/).pop();
  return (
    <header className={`trace-hero trace-hero--${agent.harness}`}>
      <div className="trace-hero__title">
        <span
          className={`trace-hero__dot ${agent.status === 'active' ? 'trace-hero__dot--live' : ''}`}
          style={{ '--dot': STATUS_COLOR[agent.status] } as CSSProperties}
          title={STATUS_LABEL[agent.status]}
          aria-label={`Status: ${STATUS_LABEL[agent.status]}`}
          role="img"
        />
        <h1 id={titleId}>{harness} trace</h1>
        <span className="trace-chip trace-chip--provider">{harness}</span>
        <span className={`trace-chip ${isMain ? 'trace-chip--main' : 'trace-chip--sub'}`}>{isMain ? 'Main' : 'Subagent'}</span>
        <button
          type="button"
          className="trace-workspace__button trace-hero__refresh"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh trace"
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="trace-hero__meta">
        {agent.cwd && <span title={agent.cwd}><Home size={12} aria-hidden="true" />{agent.cwd}</span>}
        {(agent.sessionId || agent.threadId) && <span><b>ID</b> {agent.sessionId || agent.threadId}</span>}
        {modelLabel && <span>{modelLabel}</span>}
        {!isMain && agent.role && <span><b>ROLE</b> {agent.role}</span>}
        {!isMain && agent.nickname && <span><b>AGENT</b> {agent.nickname}</span>}
        {!isMain && agent.agentPath && <span><b>PATH</b> {agent.agentPath}</span>}
        <span>{itemCount.toLocaleString()} items</span>
        <span>{agent.stats.toolCalls.toLocaleString()} tool calls</span>
        <span style={{ color: STATUS_COLOR[agent.status] }}>{STATUS_LABEL[agent.status]}</span>
      </div>

      {(subagents.length > 0 || parent) && (
        <div className="trace-hero__links">
          {parent && (
            <>
              <span className="trace-hero__links-label">Parent</span>
              <button type="button" className="trace-link" onClick={() => onOpenAgent?.(parent)} disabled={!onOpenAgent} title={parent.tracePath}>
                <span className="trace-link__tag">{parent.type === 'main' ? 'MAIN' : 'PARENT'}</span>
                {parentFile || titleFor(parent)}
              </button>
            </>
          )}
          {subagents.length > 0 && (
            <>
              <span className="trace-hero__links-label">Subagents <span className="trace-link__count">{subagents.length}</span></span>
              {subagents.map((subagent) => (
                <button
                  type="button"
                  key={subagent.id}
                  className="trace-link"
                  onClick={() => onOpenAgent?.(subagent)}
                  disabled={!onOpenAgent}
                  title={`${STATUS_LABEL[subagent.status]} · ${subagent.model || 'Unknown model'}`}
                >
                  <span className="trace-link__status" style={{ background: STATUS_COLOR[subagent.status] }} aria-hidden="true" />
                  {subagentLabel(subagent)}
                </button>
              ))}
              {subagents.length > 1 && onOpenAgents && (
                <button type="button" className="trace-link trace-link--all" onClick={() => onOpenAgents(subagents)} title="Open every subagent trace as a tab">
                  Open all {subagents.length}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </header>
  );
}

function ConversationCard({ group, openDisclosure, onToggle }: { group: ConversationGroup } & DisclosureProps) {
  const usage = conversationUsage(group);
  const duration = conversationDuration(group);
  const iso = isoFor(group.timestamp);
  return (
    <article className={`trace-card trace-card--${group.kind}`}>
      <header className="trace-card__header" title={group.turnId ? `Turn ${group.turnId}` : undefined}>
        <span className="trace-card__dot" aria-hidden="true" />
        <strong>{groupLabel(group.kind)}</strong>
        {group.model && <span className="trace-chip">{group.model}</span>}
        {group.reasoningEffort && <span className="trace-chip trace-chip--effort">{group.reasoningEffort}</span>}
        {iso && <time dateTime={iso}>{iso}</time>}
        <span className="trace-card__stats">
          {usage && group.kind !== 'usage' && (
            <span title={`${usage.input.toLocaleString()} input · ${usage.output.toLocaleString()} output tokens (latest reported)`}>
              {usage.input.toLocaleString()}↓ {usage.output.toLocaleString()}↑
            </span>
          )}
          {duration !== undefined && <span title="Time from first to last event in this card">{Math.round(duration).toLocaleString()} ms</span>}
        </span>
      </header>
      <div className="trace-card__body">
        {group.blocks.map((block, index) => {
          const key = `${group.id}:${block.type}:${index}`;
          if (block.type === 'tools') {
            return <ToolGroup key={key} groupKey={key} tools={block.tools} openDisclosure={openDisclosure} onToggle={onToggle} />;
          }
          if (block.type === 'thinking') {
            return (
              <Disclosure
                key={key}
                id={key}
                className="trace-thinking"
                title={`Thinking${block.updates && block.updates > 1 ? ` · ${block.updates} updates` : ''}`}
                summary={preview(block.entry.text, 220)}
                openDisclosure={openDisclosure}
                onToggle={onToggle}
              >
                <Markdown className="trace-thinking__body" text={block.entry.text} />
              </Disclosure>
            );
          }
          if (block.type === 'tool-result') {
            const failed = block.entry.kind === 'error';
            return (
              <Disclosure
                key={key}
                id={key}
                className={`trace-orphan ${failed ? 'trace-orphan--error' : ''}`}
                title={failed ? 'Unmatched tool error' : 'Unmatched tool result'}
                summary={preview(prettyTraceText(block.entry.text))}
                openDisclosure={openDisclosure}
                onToggle={onToggle}
              >
                <CodeBlock label={failed ? 'Error' : 'Result'} text={prettyTraceText(block.entry.text)} />
              </Disclosure>
            );
          }
          // Usage is summarized in the card header unless the card is only usage.
          if (block.type === 'usage' && group.kind !== 'usage') return null;
          if (block.type === 'text' && (block.entry.kind === 'assistant' || block.entry.kind === 'user')) {
            return <Markdown key={key} className="trace-card__text" text={block.entry.text} />;
          }
          return <p key={key} className={`trace-card__note trace-card__note--${block.type}`}>{block.entry.text}</p>;
        })}
      </div>
    </article>
  );
}

function Disclosure({ id, className, title, summary, openDisclosure, onToggle, children }: {
  id: string;
  className: string;
  title: string;
  summary: string;
  children: ReactNode;
} & DisclosureProps) {
  const open = openDisclosure.has(id);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className={`trace-disclosure ${className}`}>
      <button type="button" className="trace-disclosure__toggle" aria-expanded={open} onClick={() => onToggle(id)}>
        <Chevron size={13} aria-hidden="true" />
        <strong>{title}</strong>
        {!open && <span>{summary}</span>}
      </button>
      {open && children}
    </section>
  );
}

function ToolGroup({ groupKey, tools, openDisclosure, onToggle }: {
  groupKey: string;
  tools: ConversationTool[];
} & DisclosureProps) {
  // Tool groups start expanded; each call's input and result start collapsed.
  const open = !openDisclosure.has(groupKey);
  const names = Array.from(new Set(tools.map(({ call }) => call.toolName || 'tool'))).join(', ');
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="trace-tools">
      <button type="button" className="trace-disclosure__toggle trace-tools__toggle" aria-expanded={open} onClick={() => onToggle(groupKey)}>
        <Chevron size={13} aria-hidden="true" />
        <strong>{tools.length} tool {tools.length === 1 ? 'call' : 'calls'} ({names})</strong>
      </button>
      {open && (
        <ul className="trace-tools__tree">
          {tools.map((tool, index) => (
            <ToolRow key={`${groupKey}:${tool.call.id}:${index}`} tool={tool} toolKey={`${groupKey}:tool:${index}`} openDisclosure={openDisclosure} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ToolRow({ tool, toolKey, openDisclosure, onToggle }: {
  tool: ConversationTool;
  toolKey: string;
} & DisclosureProps) {
  const open = openDisclosure.has(toolKey);
  const input = getToolInput(tool.call);
  const status = toolStatus(tool);
  const resultText = tool.result ? prettyTraceText(tool.result.text) || 'Empty result' : '';
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className={`trace-tool trace-tool--${status.tone}`}>
      <button type="button" className="trace-tool__summary" aria-expanded={open} onClick={() => onToggle(toolKey)}>
        <Chevron size={13} aria-hidden="true" />
        <ArrowUpRight size={13} aria-hidden="true" className="trace-tool__icon" />
        <strong>{tool.call.toolName || 'tool'}</strong>
        <code>{preview(input, 120) || 'No input'}</code>
        <em>· {status.label}</em>
      </button>
      <div className="trace-tool__preview">
        <span aria-hidden="true" />
        {tool.result ? preview(resultText, 240) : 'No result in the retained trace.'}
      </div>
      {open && (
        <div className="trace-tool__details">
          <CodeBlock label="Input" text={input || '—'} />
          {tool.result && <CodeBlock label={tool.result.kind === 'error' ? 'Error' : 'Result'} text={resultText} tone={status.tone} />}
        </div>
      )}
    </li>
  );
}

function CodeBlock({ label, text, tone }: { label: string; text: string; tone?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_400);
    return () => window.clearTimeout(timer);
  }, [copied]);
  function copy() {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
  }
  return (
    <div className={`trace-code ${tone ? `trace-code--${tone}` : ''}`}>
      <div className="trace-code__label">
        <span>{label}</span>
        <button type="button" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`} title={copied ? 'Copied' : 'Copy'}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

export default TraceWorkspace;
