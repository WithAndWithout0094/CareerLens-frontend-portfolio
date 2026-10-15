import { FLOW_MANIFEST } from './generated-manifest.js';
import { FLOW_NODES, projectFlowNode } from './catalog.js';

const distinct = (values) => [...new Set(values)];
const structural = (edge) => ['contains', 'containment', 'schema', 'field'].includes(edge.kind);

// Source-derived relationships are deliberately separate from observed events.
// A path in this model says what the code connects, never what a user executed.
export function createFlowGraph(manifest) {
  const nodes = new Map(manifest.nodes.map((node) => [node.id, node]));
  const overview = manifest.overview.map((group) => ({ ...group, id: `overview:${group.id}`, sourceId: group.id,
    kind: 'overview', members: distinct(group.members || []).filter((id) => nodes.has(id)) }));
  const summaries = new Map(overview.map((node) => [node.id, node]));
  const edges = manifest.edges.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
  const links = edges.filter((edge) => !structural(edge));
  const node = (id) => summaries.get(id) || nodes.get(id) || null;
  const members = (id) => summaries.get(id)?.members || (nodes.has(id) ? [id] : []);
  const parent = (id) => nodes.get(id)?.parentId || edges.find((edge) => structural(edge) && edge.to === id)?.from || null;
  const children = (id) => {
    if (summaries.has(id)) {
      const group = summaries.get(id), ids = new Set(group.members);
      return group.members.filter((value) => !ids.has(parent(value)) || parent(value) === group.sourceId);
    }
    return distinct([...nodes.values()].filter((entry) => entry.parentId === id).map((entry) => entry.id)
      .concat(edges.filter((edge) => structural(edge) && edge.from === id).map((edge) => edge.to)));
  };
  function walk(seeds, reverse = false) {
    const seen = new Set(seeds), queue = [...seeds], found = [];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of links) {
        if ((reverse ? edge.to : edge.from) !== current) continue;
        const next = reverse ? edge.from : edge.to;
        if (seen.has(next)) continue;
        seen.add(next); queue.push(next); found.push(next);
      }
    }
    return found;
  }
  function context(id) {
    const seeds = members(id), selected = new Set(seeds);
    const before = walk(seeds, true), after = walk(seeds);
    const predecessors = distinct(links.filter((edge) => selected.has(edge.to) && !selected.has(edge.from)).map((edge) => edge.from));
    const successors = distinct(links.filter((edge) => selected.has(edge.from) && !selected.has(edge.to)).map((edge) => edge.to));
    const connected = new Set([...seeds, ...before, ...after]);
    const starts = [...connected].filter((entry) => !links.some((edge) => edge.to === entry && connected.has(edge.from)));
    const ends = [...connected].filter((entry) => !links.some((edge) => edge.from === entry && connected.has(edge.to)));
    const ancestry = [], visited = new Set([id]);
    let ancestor = parent(id);
    while (ancestor && nodes.has(ancestor) && !visited.has(ancestor)) {
      ancestry.push(ancestor); visited.add(ancestor); ancestor = parent(ancestor);
    }
    const enclosing = ancestry.find((entry) => links.some((edge) => (edge.kind === 'flow' || edge.kind === 'conditional') && (edge.from === entry || edge.to === entry))) || null;
    return { node: node(id), children: children(id), ancestry, enclosing, predecessors, successors, before, after, starts, ends,
      edges: links.filter((edge) => connected.has(edge.from) && connected.has(edge.to)) };
  }
  return { manifest, nodes, overview, edges, links, node, members, parent, children, context,
    groupFor: (id) => overview.find((group) => group.members.includes(id)) || null };
}

export function analysisDomains(graph = FLOW_GRAPH) {
  return [...graph.nodes.values()].filter((node) => node.kind === 'domain' || /^domain_[a-z]+$/.test(node.id)).map((node) => node.id);
}

export const FLOW_GRAPH = createFlowGraph(FLOW_MANIFEST);
export const SOURCE_FLOW_EDGES = distinct(FLOW_GRAPH.links
  .filter(({ from, to }) => FLOW_NODES.has(from) && FLOW_NODES.has(to))
  .map(({ from, to }) => `${from}\u0000${to}`)).map((value) => value.split('\u0000'));

// The old detail view remains a ledger of instrumented event names. Its lines
// now come from the generated graph, rather than a second handwritten graph.
export function observationEdges(graph = FLOW_GRAPH) {
  const result = new Set();
  for (const start of FLOW_NODES.keys()) {
    if (!graph.nodes.has(start)) continue;
    const visited = new Set([start]), queue = [start];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of graph.links.filter((entry) => entry.from === current)) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        if (FLOW_NODES.has(edge.to)) {
          if (projectFlowNode(start) !== projectFlowNode(edge.to)) result.add(`${start}\u0000${edge.to}`);
        } else queue.push(edge.to);
      }
    }
  }
  return [...result].map((entry) => entry.split('\u0000'));
}

export function summaryObservation(group, readEvent) {
  const entries = group.members.filter((id) => FLOW_NODES.has(id)).map(readEvent).filter(Boolean).sort((a, b) => a.at - b.at);
  const active = entries.filter((entry) => ['pending', 'running', 'queued'].includes(entry.state));
  return { latest: active.at(-1) || entries.at(-1) || null, activeCount: active.length, observedCount: entries.length };
}

export function overviewConnections(graph = FLOW_GRAPH) {
  const found = new Set();
  for (const edge of graph.links) {
    const from = graph.groupFor(edge.from), to = graph.groupFor(edge.to);
    if (from && to && from.id !== to.id) found.add(`${from.id}\u0000${to.id}`);
  }
  return [...found].map((entry) => entry.split('\u0000'));
}
