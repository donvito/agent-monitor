export type AgentHarness = 'codex' | 'claude' | 'pi' | 'hermes' | 'unknown';
export type AgentStatus = 'starting' | 'active' | 'idle' | 'finished' | 'error';
export type AgentType = 'main' | 'subagent' | 'child-session' | 'unknown';
/** Input includes cache reads/writes; output already includes reasoning tokens. */
export interface ModelTokenUsage {
  model: string;
  provider?: string;
  serviceTier?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  requestInputTokens?: number;
}
export interface Agent {
  id: string; runId: string; parentId: string | null; harness: AgentHarness;
  type: AgentType; status: AgentStatus;
  sessionId?: string; threadId?: string; parentThreadId?: string;
  model?: string; provider?: string; reasoningEffort?: string; role?: string; nickname?: string; agentPath?: string;
  cwd?: string; tracePath?: string; createdAt?: number; lastActivityAt?: number; activity?: string;
  tokenUsage?: ModelTokenUsage[];
  tokenTimeline?: { timestamp: number; inputTokens: number; outputTokens: number }[];
  stats: { inputTokens: number; outputTokens: number; toolCalls: number; errors: number };
}
export interface AgentRun { title?: string; id: string; harness: AgentHarness; rootAgentId?: string; cwd?: string; startedAt?: number; lastActivityAt?: number; agentCount?: number }
export interface AgentEdge { id: string; source: string; target: string; type: 'spawn'; status: 'starting' | 'active' | 'finished' }
export interface MonitorSnapshot { agents: Agent[]; runs: AgentRun[]; edges: AgentEdge[]; watching: boolean; errors: string[]; selectedRunId?: string }
/** `usage` holds the token counts of the single request a usage entry reports. */
export interface TraceEntry { usage?: { input: number; output: number }; callId?: string; toolName?: string; model?: string; reasoningEffort?: string; turnId?: string; id: string; timestamp?: number; kind: 'user' | 'assistant' | 'thinking' | 'tool-call' | 'tool-result' | 'usage' | 'error' | 'event'; text: string }
/** A range of a trace by absolute entry index: from `start`, up to `end`, or the latest entries when neither is set. */
export interface TraceRangeRequest { start?: number; end?: number; limit: number }
/** Entries of a trace range, the absolute index of the first one, and the trace's total entry count. */
export interface TracePage { entries: TraceEntry[]; start: number; total: number }
export type AgentEvent = { type: 'agent.discovered'; agent: Agent } | { type: 'agent.spawned'; agent: Agent } | {type:'agent.updated';agentId:string;changes:Partial<Agent>} | {type:'agent.finished';agentId:string} | {type:'agent.error';agentId:string;error?:string} | {type:'agent.activity';agentId:string;timestamp:number} | {type:'run.discovered';run:AgentRun};
export interface MonitorBridge { platform?: string; getSnapshot(): Promise<MonitorSnapshot>; onSnapshot(callback: (snapshot: MonitorSnapshot) => void): () => void; getTrace(agentId: string): Promise<TraceEntry[]>; getTraceRange(agentId: string, request: TraceRangeRequest): Promise<TracePage>; loadRun(runId: string): Promise<void> }
declare global { interface Window { agentMonitor?: MonitorBridge } }
