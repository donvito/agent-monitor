import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Info, TriangleAlert, X } from 'lucide-react';
import type { Agent } from '../shared/types';
import { estimateAgentCost, estimateModelCosts, PRICING_VERIFIED_AT, UNATTRIBUTED_MODEL, type ModelCostRow } from '../shared/pricing';
import { RollingNumber, RollingText } from './RollingNumber';
import { TokenUsageCharts } from './TokenUsageCharts';
import { agentDisplayName } from './TraceWorkspace';

const exact = (value: number) => value.toLocaleString();

function usd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Unknown';
  if (value !== 0 && Math.abs(value) < 0.0001) return '<$0.0001';
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
}

function share(part: number, whole: number) {
  if (!whole) return '0%';
  const percent = part / whole * 100;
  return `${percent > 0 && percent < 0.1 ? '<0.1' : percent.toFixed(1)}%`;
}

const rate = (value: number) => `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;

/** Cents are enough for the header; the breakdown keeps full precision. */
function usdShort(value: number) {
  if (Math.abs(value) < 1) return usd(value);
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function modelCostLabel(row: ModelCostRow) {
  if (row.complete) return usd(row.knownUsd);
  return row.knownUsd > 0 ? usd(row.knownUsd) : 'Unknown';
}

function modelCostNote(row: ModelCostRow) {
  if (row.complete) return `Rates verified ${PRICING_VERIFIED_AT}.`;
  const prefix = row.knownUsd > 0 ? `Known subtotal only; ${exact(row.unpricedTokens)} tokens unpriced.` : `${exact(row.unpricedTokens)} tokens unpriced.`;
  return [prefix, ...row.notes].join(' ');
}

type AgentCost = ReturnType<typeof estimateAgentCost>;

function costLabel(cost: AgentCost) {
  if (cost.complete && cost.usd !== null) return usd(cost.usd);
  return cost.knownUsd > 0 ? usd(cost.knownUsd) : 'Unknown';
}

function costNote(cost: AgentCost) {
  if (cost.notes.length) return cost.notes.join(' ');
  return cost.complete
    ? `Rates verified ${PRICING_VERIFIED_AT}.`
    : 'Known subtotal only; some model rates or cache token metadata are unavailable.';
}

export function RunTokenDetails({ agents }: { agents: Agent[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [view, setView] = useState<'agent' | 'model'>('agent');
  const modelRows = useMemo(() => estimateModelCosts(agents), [agents]);
  const titleId = useId();
  const totals = agents.reduce((sum, agent) => ({
    input: sum.input + agent.stats.inputTokens,
    output: sum.output + agent.stats.outputTokens,
  }), { input: 0, output: 0 });
  const rows = [...agents].sort((a, b) =>
    Number(b.type === 'main') - Number(a.type === 'main')
    || (b.stats.inputTokens + b.stats.outputTokens) - (a.stats.inputTokens + a.stats.outputTokens)
    || a.id.localeCompare(b.id));
  const costs = agents.map((agent) => ({ agent, cost: estimateAgentCost(agent) }));
  const costByAgentId = new Map(costs.map(({ agent, cost }) => [agent.id, cost]));
  const totalCost = costs.reduce((sum, { cost }) => ({
    knownUsd: sum.knownUsd + cost.knownUsd,
    unpricedTokens: sum.unpricedTokens + cost.unpricedTokens,
    complete: sum.complete && cost.complete && cost.usd !== null,
  }), { knownUsd: 0, unpricedTokens: 0, complete: costs.length > 0 });
  const totalTokens = totals.input + totals.output;
  const pricedTokens = totalTokens - totalCost.unpricedTokens;
  const perMillion = totalCost.knownUsd > 0 && pricedTokens > 0 ? totalCost.knownUsd / pricedTokens * 1_000_000 : undefined;
  const totalCostLabel = totalCost.complete
    ? usd(totalCost.knownUsd)
    : totalCost.knownUsd > 0
      ? usd(totalCost.knownUsd)
      : 'Unknown';
  const totalCostNote = totalCost.complete
    ? `Rates verified ${PRICING_VERIFIED_AT}.`
    : totalCost.knownUsd > 0
      ? `Known subtotal from priced usage. ${totalCost.unpricedTokens.toLocaleString()} tokens have no verified rate or complete cache metadata.`
      : `No priced usage is available. ${totalCost.unpricedTokens.toLocaleString()} tokens have no verified rate or complete cache metadata.`;

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (ref.current?.open && event.target instanceof Node && !ref.current.contains(event.target)) {
        ref.current.open = false;
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, []);

  function close() {
    if (!ref.current) return;
    ref.current.open = false;
    ref.current.querySelector('summary')?.focus();
  }

  return (
    <details className="run-token-details" ref={ref} onKeyDown={event => {
      if (event.key === 'Escape' && ref.current?.open) { event.preventDefault(); event.stopPropagation(); close(); }
    }}>
      <summary className="run-token-totals" aria-label={`Run token totals: ${exact(totals.input)} input, ${exact(totals.output)} output, ${totalCostLabel} API token estimate. Show per-agent breakdown`}>
        <span className="run-token-totals__stat run-token-totals__stat--input" title={`${exact(totals.input)} input tokens`}>
          <span className="run-token-totals__label">Input</span>
          <strong><RollingNumber value={totals.input} /></strong>
        </span>
        <span className="run-token-totals__stat run-token-totals__stat--output" title={`${exact(totals.output)} output tokens`}>
          <span className="run-token-totals__label">Output</span>
          <strong><RollingNumber value={totals.output} /></strong>
        </span>
        <span className="run-token-totals__stat run-token-totals__stat--usd" title={`${totalCostLabel} API token estimate (USD). ${totalCostNote}`}>
          <span className="run-token-totals__label">Est. cost</span>
          <strong><RollingText text={totalCost.knownUsd > 0 ? usdShort(totalCost.knownUsd) : totalCostLabel} /></strong>
        </span>
        <span className="run-token-totals__details">Details<ChevronDown size={14} aria-hidden="true" /></span>
      </summary>
      <section className="token-breakdown" aria-labelledby={titleId}>
        <header>
          <div>
            <h2 id={titleId}>Token breakdown</h2>
            <p>Main agent and {agents.length - 1} {agents.length === 2 ? 'subagent' : 'subagents'} · {agents.length} agents total</p>
          </div>
          <button type="button" className="token-breakdown__close" onClick={close}><X size={15} aria-hidden="true" />Close</button>
        </header>
        <div className="token-breakdown__totals" aria-label="Aggregated run usage">
          <div className="token-breakdown__tile token-breakdown__tile--input">
            <span>Input tokens</span>
            <strong><RollingNumber value={totals.input} /></strong>
            <small>{share(totals.input, totalTokens)} of total · includes cache</small>
          </div>
          <div className="token-breakdown__tile token-breakdown__tile--output">
            <span>Output tokens</span>
            <strong><RollingNumber value={totals.output} /></strong>
            <small>{share(totals.output, totalTokens)} of total</small>
          </div>
          <div className="token-breakdown__tile">
            <span>Total tokens</span>
            <strong><RollingNumber value={totalTokens} /></strong>
            <small>Across {agents.length} {agents.length === 1 ? 'agent' : 'agents'}</small>
          </div>
          <div className="token-breakdown__tile token-breakdown__tile--cost" title={`${totalCostLabel}. ${totalCostNote}`}>
            <span>Estimated cost</span>
            <strong><RollingText text={totalCost.knownUsd > 0 ? usdShort(totalCost.knownUsd) : totalCostLabel} /></strong>
            <small>{perMillion ? `≈ ${usd(perMillion)} per 1M priced tokens` : 'API token estimate (USD)'}</small>
          </div>
        </div>
        <div className="token-breakdown__notes">
          <span><Info size={13} aria-hidden="true" />API token estimate · rates verified {PRICING_VERIFIED_AT} · standard tier when unspecified · not a subscription bill</span>
          {!totalCost.complete && <span className="token-breakdown__warning"><TriangleAlert size={13} aria-hidden="true" />Excludes {exact(totalCost.unpricedTokens)} tokens with unknown pricing or incomplete usage metadata</span>}
        </div>
        <div className="token-breakdown__body">
        <div className="token-breakdown__pane">
        <div className="token-breakdown__views" role="tablist" aria-label="Group usage by">
          <button type="button" role="tab" aria-selected={view === 'agent'} onClick={() => setView('agent')}>By agent <span>{agents.length}</span></button>
          <button type="button" role="tab" aria-selected={view === 'model'} onClick={() => setView('model')}>By model <span>{modelRows.filter((row) => row.model !== UNATTRIBUTED_MODEL).length}</span></button>
        </div>
        <div className="token-breakdown__scroll">
          {view === 'agent' ? <table>
            <thead><tr><th scope="col">Agent</th><th scope="col">IN</th><th scope="col">OUT</th><th scope="col" title={`API token estimate (USD). ${totalCostNote}`}>USD</th></tr></thead>
            <tbody>{rows.map(agent => <tr key={agent.id}>
              <th scope="row" title={agent.id}><strong>{agentDisplayName(agent)}</strong><span>{agent.type === 'main' ? 'Main' : agent.nickname ? `${agent.nickname} · ${agent.model || 'Unknown model'}` : agent.model || 'Unknown model'}</span></th>
              <td><RollingNumber value={agent.stats.inputTokens} /></td><td><RollingNumber value={agent.stats.outputTokens} /></td><td className="token-breakdown__cost" title={costNote(costByAgentId.get(agent.id) as AgentCost)}><RollingText text={costLabel(costByAgentId.get(agent.id) as AgentCost)} /></td>
            </tr>)}</tbody>
            <tfoot><tr><th scope="row">Run total</th><td><RollingNumber value={totals.input} /></td><td><RollingNumber value={totals.output} /></td><td className="token-breakdown__cost" title={totalCostNote}><RollingText text={totalCostLabel} /></td></tr></tfoot>
          </table> : <table className="token-breakdown__models">
            <thead><tr><th scope="col">Model</th><th scope="col">IN</th><th scope="col">OUT</th><th scope="col" title={`API token estimate (USD). ${totalCostNote}`}>USD</th><th scope="col">Share of cost</th></tr></thead>
            <tbody>{modelRows.map(row => {
              const costShare = totalCost.knownUsd > 0 ? row.knownUsd / totalCost.knownUsd : 0;
              return <tr key={row.model}>
                <th scope="row">
                  <strong>{row.model}</strong>
                  <span>{row.agents} {row.agents === 1 ? 'agent' : 'agents'} · {share(row.inputTokens + row.outputTokens, totalTokens)} of tokens</span>
                  <span>{row.rate ? `${rate(row.rate.input)} in · ${rate(row.rate.output)} out per 1M` : row.model === UNATTRIBUTED_MODEL ? 'No model recorded' : 'No verified rate'}</span>
                </th>
                <td><RollingNumber value={row.inputTokens} /><span className="token-breakdown__sub">{row.inputTokens ? `${share(row.cacheReadTokens, row.inputTokens)} cached` : '—'}</span></td>
                <td><RollingNumber value={row.outputTokens} /></td>
                <td className={`token-breakdown__cost ${row.complete ? '' : 'token-breakdown__cost--partial'}`} title={modelCostNote(row)}><RollingText text={modelCostLabel(row)} /></td>
                <td className="token-breakdown__share" aria-label={`${share(row.knownUsd, totalCost.knownUsd)} of estimated cost`}>
                  <span className="token-breakdown__bar"><span style={{ width: `${Math.max(costShare > 0 ? 2 : 0, costShare * 100)}%` }} /></span>
                  <span>{row.knownUsd > 0 ? share(row.knownUsd, totalCost.knownUsd) : '—'}</span>
                </td>
              </tr>;
            })}</tbody>
            <tfoot><tr><th scope="row">Run total</th><td><RollingNumber value={totals.input} /></td><td><RollingNumber value={totals.output} /></td><td className="token-breakdown__cost" title={totalCostNote}><RollingText text={totalCostLabel} /></td><td className="token-breakdown__share"><span /><span>100%</span></td></tr></tfoot>
          </table>}
        </div>
        </div>
        <div className="token-breakdown__charts">
          <TokenUsageCharts agents={agents} />
        </div>
        </div>
      </section>
    </details>
  );
}
