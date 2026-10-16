import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowGraph, FLOW_GRAPH, overviewRelations, overviewConnections } from '../../src/features/activity-flow/explorer-model.js';
import { buildOverviewMap, overviewMapMarkup, overviewCurve, OVERVIEW_CARD } from '../../src/features/activity-flow/overview-map.js';

test('compact overview retains all real groups, uses preparation/result branches and has no bottom wire tray', () => {
  const model = buildOverviewMap(FLOW_GRAPH), nodes = new Map(model.nodes.map((node) => [node.id, node]));
  assert.deepEqual(new Set(nodes.keys()), new Set(FLOW_GRAPH.overview.map((node) => node.id)));
  assert.ok(OVERVIEW_CARD.width < 208 && OVERVIEW_CARD.height < 150);
  assert.equal(nodes.get('overview:resume').x, nodes.get('overview:posting').x);
  assert.notEqual(nodes.get('overview:resume').y, nodes.get('overview:posting').y);
  assert.equal(nodes.get('overview:report').x, nodes.get('overview:dashboard').x);
  for (const node of nodes.values()) {
    assert.ok(node.x >= 0 && node.y >= 0);
    assert.ok(node.x + node.width <= model.width && node.y + node.height <= model.height);
  }
  const markup = overviewMapMarkup(model);
  assert.equal((markup.match(/data-summary-node=/g) || []).length, FLOW_GRAPH.overview.length);
  assert.match(markup, /data-map-viewport/);
  assert.match(markup, /data-map-zoom="in"/);
  assert.doesNotMatch(markup, /flow-overview-stages|flow-overview-wires/);
});

test('overview keeps dependencies separate from processing and preserves every source relationship', () => {
  const model = buildOverviewMap(FLOW_GRAPH);
  assert.deepEqual(new Set(model.edges.map((edge) => `${edge.from}:${edge.to}`)), new Set(overviewConnections().map(([from, to]) => `${from}:${to}`)));
  for (const edge of model.edges) {
    assert.ok(edge.sourceEdges.length);
    assert.equal(edge.primary, edge.sourceEdges.some((source) => ['flow', 'conditional'].includes(source.kind)));
    for (const source of edge.sourceEdges) {
      assert.ok(FLOW_GRAPH.edges.includes(source));
      assert.equal(FLOW_GRAPH.groupFor(source.from).id, edge.from);
      assert.equal(FLOW_GRAPH.groupFor(source.to).id, edge.to);
    }
  }
  const authLookups = model.edges.filter((edge) => edge.to === 'overview:auth');
  assert.ok(authLookups.length);
  assert.ok(authLookups.every((edge) => !edge.primary));
});

test('source changes add and remove overview edges without creating a pretend sequential chain', () => {
  const manifest = { overview: [
    { id: 'resume', label: '이력서', members: ['resume'] },
    { id: 'analysis', label: '분석', members: ['engine'] },
    { id: 'report', label: '보고서', members: ['response'] },
  ], nodes: [{ id: 'resume' }, { id: 'engine' }, { id: 'response' }], edges: [] };
  assert.equal(buildOverviewMap(createFlowGraph(manifest)).edges.length, 0, 'layout never implies a source edge');
  manifest.edges.push({ from: 'engine', to: 'response', kind: 'produces' });
  let relation = overviewRelations(createFlowGraph(manifest))[0];
  assert.equal(relation.primary, false, 'an API/schema response is not a user traversal');
  manifest.edges.push({ from: 'engine', to: 'response', kind: 'flow' });
  relation = overviewRelations(createFlowGraph(manifest))[0];
  assert.equal(relation.primary, true);
  assert.deepEqual(new Set(relation.kinds), new Set(['produces', 'flow']));
  manifest.edges.length = 0;
  assert.equal(buildOverviewMap(createFlowGraph(manifest)).edges.length, 0);
});

test('returning source links route above the card band instead of through cards or below the canvas', () => {
  const model = buildOverviewMap(FLOW_GRAPH), byId = new Map(model.nodes.map((node) => [node.id, node]));
  const from = byId.get('overview:report'), to = byId.get('overview:analysis');
  const path = overviewCurve(from, to, 0);
  assert.ok(path.startsWith(`M${from.x + from.width / 2},${from.y}`));
  assert.ok(path.endsWith(`${to.x + to.width / 2},${to.y}`));
  assert.match(path, /,64/);
  assert.ok(from.y > 64 && to.y > 64);
});
