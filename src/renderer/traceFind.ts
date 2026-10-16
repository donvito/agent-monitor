import { getToolInput, prettyTraceText, type ConversationGroup } from './traceConversation';

/** Disclosure keys to toggle so a region becomes visible: `open` for collapsed-by-default blocks, `expand` for tool groups. */
export interface FindReveal {
  open: string[];
  expand: string[];
}

/** A piece of displayed trace text that find can search, highlight and reveal. */
export interface FindRegion {
  key: string;
  groupId: string;
  text: string;
  reveal: FindReveal;
}

export interface FindMatch {
  region: string;
  groupId: string;
  /** Index of this match among the matches inside its region. */
  occurrence: number;
  reveal: FindReveal;
}

/** Disclosure and region key of a block inside a conversation card. */
export function blockKey(groupId: string, type: string, index: number) {
  return `${groupId}:${type}:${index}`;
}

/** Disclosure key of one tool call row inside a tool group block. */
export function toolKey(groupBlockKey: string, index: number) {
  return `${groupBlockKey}:tool:${index}`;
}

/** Start offsets of non-overlapping occurrences of `query` in `text`. */
export function findOccurrences(text: string, query: string, caseSensitive = false): number[] {
  if (!query) return [];
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  const offsets: number[] = [];
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) {
    offsets.push(index);
  }
  return offsets;
}

const VISIBLE: FindReveal = { open: [], expand: [] };

/** Searchable regions in display order, mirroring how ConversationCard renders each block. */
export function findRegions(groups: readonly ConversationGroup[]): FindRegion[] {
  const regions: FindRegion[] = [];
  for (const group of groups) {
    group.blocks.forEach((block, index) => {
      const key = blockKey(group.id, block.type, index);
      const add = (regionKey: string, text: string, reveal: FindReveal) => regions.push({ key: regionKey, groupId: group.id, text, reveal });
      if (block.type === 'tools') {
        block.tools.forEach((tool, toolIndex) => {
          const row = toolKey(key, toolIndex);
          const reveal = { open: [row], expand: [key] };
          add(`${row}:input`, getToolInput(tool.call) || '—', reveal);
          if (tool.result) add(`${row}:result`, prettyTraceText(tool.result.text) || 'Empty result', reveal);
        });
        return;
      }
      if (block.type === 'thinking') return add(key, block.entry.text, { open: [key], expand: [] });
      if (block.type === 'tool-result') return add(key, prettyTraceText(block.entry.text), { open: [key], expand: [] });
      // Usage is summarized in the card header unless the card is only usage.
      if (block.type === 'usage' && group.kind !== 'usage') return;
      add(key, block.entry.text, VISIBLE);
    });
  }
  return regions;
}

/** Every match of `query` across the groups, in display order. */
export function findMatches(groups: readonly ConversationGroup[], query: string, options: { caseSensitive?: boolean } = {}): FindMatch[] {
  if (!query.trim()) return [];
  return findRegions(groups).flatMap((region) => findOccurrences(region.text, query, options.caseSensitive)
    .map((_, occurrence) => ({ region: region.key, groupId: region.groupId, occurrence, reveal: region.reveal })));
}

/** Ranges of every occurrence of `query` in an element's text, which may span several text nodes. */
export function textRanges(element: Element, query: string, caseSensitive = false): Range[] {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += node.nodeValue ?? '';
  }
  const locate = (offset: number) => {
    let index = nodes.length - 1;
    while (index > 0 && nodes[index].start > offset) index -= 1;
    return { node: nodes[index].node, offset: offset - nodes[index].start };
  };
  return findOccurrences(text, query, caseSensitive).map((offset) => {
    const range = element.ownerDocument.createRange();
    const start = locate(offset);
    const end = locate(offset + query.length);
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/** Scrolls every scrollable ancestor between the range and `outer` so the range sits mid-view. */
export function scrollRangeIntoView(range: Range, outer: Element) {
  for (let element = range.startContainer.parentElement; element; element = element.parentElement) {
    if (element.scrollHeight > element.clientHeight && /auto|scroll/.test(getComputedStyle(element).overflowY)) {
      const target = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      if (target.top < box.top || target.bottom > box.bottom) {
        element.scrollTop += target.top - box.top - (box.height - target.height) / 2;
      }
    }
    if (element === outer) break;
  }
}

const FIND_HIGHLIGHT = 'trace-find';
const CURRENT_HIGHLIGHT = 'trace-find-current';
const publishedRanges = new Map<string, { all: Range[]; current: Range[] }>();

/**
 * Publishes one find view's ranges to the shared CSS highlight registry.
 * Several trace tabs can be mounted at once, so the registry holds their union.
 */
export function publishFindHighlights(owner: string, ranges?: { all: Range[]; current: Range[] }) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  if (ranges && (ranges.all.length || ranges.current.length)) publishedRanges.set(owner, ranges);
  else publishedRanges.delete(owner);
  const all = [...publishedRanges.values()].flatMap((value) => value.all);
  const current = [...publishedRanges.values()].flatMap((value) => value.current);
  if (all.length) CSS.highlights.set(FIND_HIGHLIGHT, new Highlight(...all));
  else CSS.highlights.delete(FIND_HIGHLIGHT);
  if (current.length) CSS.highlights.set(CURRENT_HIGHLIGHT, new Highlight(...current));
  else CSS.highlights.delete(CURRENT_HIGHLIGHT);
}
