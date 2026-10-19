import type { ModelCostRow } from '../shared/pricing';

/** A partial estimate keeps its known subtotal, marked with `+`: the full cost is at least that much. */
export function costLabel(knownUsd: number, complete: boolean, format: (value: number) => string): string {
  if (complete) return format(knownUsd);
  return knownUsd > 0 ? `${format(knownUsd)}+` : 'Unknown';
}

/** Names the models whose tokens have no price, most unpriced tokens first; empty when everything is priced. */
export function unpricedNote(rows: readonly ModelCostRow[]): string {
  const unpriced = rows.filter((row) => row.unpricedTokens > 0).sort((a, b) => b.unpricedTokens - a.unpricedTokens);
  if (!unpriced.length) return '';
  return [
    'Not priced:',
    ...unpriced.map((row) => `• ${row.model}: ${row.unpricedTokens.toLocaleString()} tokens${row.notes.length ? ` (${row.notes.join(' ')})` : ''}`),
  ].join('\n');
}
