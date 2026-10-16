import type { AgentRun } from '../shared/types';

/** Which part of a run matched a search, and the text to show with the match highlighted. */
export interface RunMatch {
  field: 'id' | 'name' | 'path' | 'all';
  text: string;
}

/** Trims the query and drops an `ID` label copied along with a session id. */
function normalize(query: string) {
  return query.trim().replace(/^id\s+/i, '').toLocaleLowerCase();
}

/** The name the run list shows for a run. */
export function runName(run: AgentRun) {
  return run.title || run.cwd?.split('/').filter(Boolean).pop() || 'Current workspace';
}

/** How a run matches a search by session id, shown name or working directory; undefined when it does not. */
export function runMatch(run: AgentRun, query: string): RunMatch | undefined {
  const needle = normalize(query);
  if (!needle) return { field: 'all', text: '' };
  // Provider sessions are namespaced (`claude:<session id>`); the bare id is what users copy.
  const prefix = `${run.harness}:`;
  const bareId = run.id.startsWith(prefix) ? run.id.slice(prefix.length) : run.id;
  if (bareId.toLocaleLowerCase().includes(needle)) return { field: 'id', text: bareId };
  if (run.id.toLocaleLowerCase().includes(needle)) return { field: 'id', text: run.id };
  const name = runName(run);
  if (name.toLocaleLowerCase().includes(needle)) return { field: 'name', text: name };
  if (run.cwd?.toLocaleLowerCase().includes(needle)) return { field: 'path', text: run.cwd };
  return undefined;
}

export function filterRuns(runs: readonly AgentRun[], query: string): AgentRun[] {
  return runs.filter((run) => runMatch(run, query));
}

/** Splits text into matching and non-matching parts for highlighting. */
export function highlightParts(text: string, query: string): Array<{ text: string; match: boolean }> {
  const needle = normalize(query);
  if (!needle) return [{ text, match: false }];
  const haystack = text.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let position = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    if (index > position) parts.push({ text: text.slice(position, index), match: false });
    parts.push({ text: text.slice(index, index + needle.length), match: true });
    position = index + needle.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), match: false });
  return parts;
}
