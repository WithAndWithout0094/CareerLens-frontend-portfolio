import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowGraph, FLOW_GRAPH } from '../../src/features/activity-flow/explorer-model.js';
import { buildExplorerMap, zoomMapAt, MAP_LIMITS } from '../../src/features/activity-flow/explorer-map.js';

const fixture = () => createFlowGraph({ version: 1, sourceDigest: 'map-fixture', limitations: [],
  overview: [{ id: 'analysis', label: '분석', members: ['analyse', 'result-a', 'result-b', 'criterion'] }],
  nodes: [{ id: 'start', label: '입력', kind: 'stage' }, { id: 'prepare', label: '준비', kind: 'stage' },
    { id: 'analyse', label: '분석', kind: 'stage' }, { id: 'save', label: '저장', kind: 'stage' },
    { id: 'finish', label: '끝', kind: 'stage' }, { id: 'fail', label: '중단', kind: 'stage' },
    { id: 'result-a', label: '영역 A', kind: 'domain', parentId: 'analyse' },
    { id: 'result-b', label: '영역 B', kind: 'domain', parentId: 'analyse' },
    { id: 'criterion', label: '기준', kind: 'criterion', parentId: 'result-a' }],
  edges: [{ from: 'start', to: 'prepare', kind: 'flow' }, { from: 'prepare', to: 'analyse', kind: 'flow' },
    { from: 'analyse', to: 'save', kind: 'flow' }, { from: 'save', to: 'finish', kind: 'flow' },
    { from: 'analyse', to: 'fail', kind: 'conditional' }, { from: 'analyse', to: 'result-a', kind: 'contains' },
    { from: 'analyse', to: 'result-b', kind: 'contains' }, { from: 'result-a', to: 'criterion', kind: 'contains' }],
});

test('horizontal local map retains a real start/end path, branches and composition without manufacturing edges', () => {
  const graph = fixture(), map = buildExplorerMap(graph, 'analyse');
  const nodes = new Map(map.nodes.map((node) => [node.id, node]));
  for (const id of ['start', 'prepare', 'analyse', 'save', 'fail', 'result-a', 'result-b']) assert.ok(nodes.has(id), id);
  assert.ok(nodes.get('start').x < nodes.get('analyse').x);
  assert.ok(nodes.get('analyse').x < nodes.get('save').x);
  for (const edge of map.edges) assert.ok(graph.edges.some((entry) => entry.from === edge.from && entry.to === edge.to && entry.kind === edge.kind));
  assert.equal(map.edges.find((edge) => edge.to === 'result-a').kind, 'contains');
  assert.equal(map.edges.find((edge) => edge.to === 'fail').kind, 'conditional');
});

test('expansion retains deeper descendants and a cyclic branch terminates', () => {
  const graph = fixture();
  graph.edges.push({ from: 'finish', to: 'prepare', kind: 'conditional' });
  graph.links.push({ from: 'finish', to: 'prepare', kind: 'conditional' });
  const map = buildExplorerMap(graph, 'analyse', { expanded: true });
  assert.ok(map.nodes.some((node) => node.id === 'criterion'));
  assert.ok(map.nodes.some((node) => node.id === 'finish'));
  assert.equal(new Set(map.nodes.map((node) => node.id)).size, map.nodes.length);
  assert.ok(map.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
});

test('every generated feature can become a selected map node and every rendered endpoint exists', () => {
  for (const node of [...FLOW_GRAPH.nodes.values(), ...FLOW_GRAPH.overview]) {
    const map = buildExplorerMap(FLOW_GRAPH, node.id);
    assert.ok(map.nodes.some((entry) => entry.id === node.id && entry.selected), node.id);
    const ids = new Set(map.nodes.map((entry) => entry.id));
    for (const edge of map.edges) { assert.ok(ids.has(edge.from), edge.from); assert.ok(ids.has(edge.to), edge.to); }
  }
});

test('cursor-anchored zoom preserves the world point and clamps both extremes', () => {
  const view = { scale: .7, x: -70, y: 90 }, point = { x: 230, y: 145 };
  for (const factor of [1.25, .8, 100, .001]) {
    const next = zoomMapAt(view, point, factor);
    assert.ok(next.scale >= MAP_LIMITS.min && next.scale <= MAP_LIMITS.max);
    assert.ok(Math.abs((point.x - view.x) / view.scale - (point.x - next.x) / next.scale) < 1e-8);
    assert.ok(Math.abs((point.y - view.y) / view.scale - (point.y - next.y) / next.scale) < 1e-8);
  }
  const maximum = zoomMapAt(view, point, 100);
  assert.deepEqual(zoomMapAt(maximum, point, 100), maximum);
});
