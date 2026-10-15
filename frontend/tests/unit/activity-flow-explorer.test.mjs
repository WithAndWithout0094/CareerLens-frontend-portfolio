import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowGraph, FLOW_GRAPH, summaryObservation, overviewConnections, analysisDomains } from '../../src/features/activity-flow/explorer-model.js';
import { makeNodeDemo, createExplorerPlayback } from '../../src/features/activity-flow/explorer-demo.js';
import { overviewMarkup } from '../../src/features/activity-flow/explorer-dialog.js';
import { FLOW_NODES } from '../../src/features/activity-flow/catalog.js';

const graph = () => createFlowGraph({ version: 1, sourceDigest: 'fixture', limitations: [],
  nodes: [
    { id: 'start', label: '시작', kind: 'stage' }, { id: 'analysis', label: '분석', kind: 'stage' },
    { id: 'domain_a', label: '완성도', kind: 'domain', parentId: 'analysis' },
    { id: 'criterion:A1', label: '경험 근거', kind: 'criterion', parentId: 'domain_a' },
    { id: 'criterion:A2', label: '성과 근거', kind: 'criterion', parentId: 'domain_a' },
    { id: 'end', label: '끝', kind: 'stage' }, { id: 'branch', label: '다른 끝', kind: 'stage' },
  ],
  overview: [{ id: 'analysis', label: '분석', description: '분석 요약', members: ['analysis', 'domain_a', 'criterion:A1', 'criterion:A2'] }],
  edges: [{ from: 'start', to: 'analysis', kind: 'flow' }, { from: 'analysis', to: 'end', kind: 'flow' },
    { from: 'analysis', to: 'branch', kind: 'conditional' }, { from: 'analysis', to: 'domain_a', kind: 'contains' },
    { from: 'domain_a', to: 'criterion:A1', kind: 'contains' }, { from: 'domain_a', to: 'criterion:A2', kind: 'contains' }],
});

test('graph separates execution paths from child composition and retains both branch endings', () => {
  const model = graph(), context = model.context('analysis');
  assert.deepEqual(context.predecessors, ['start']);
  assert.deepEqual(context.successors, ['end', 'branch']);
  assert.deepEqual(context.children, ['domain_a']);
  assert.deepEqual(context.before, ['start']);
  assert.deepEqual(context.after, ['end', 'branch']);
  assert.ok(context.starts.includes('start'));
  assert.deepEqual(new Set(context.ends), new Set(['end', 'branch']));
  assert.deepEqual(model.children('domain_a'), ['criterion:A1', 'criterion:A2']);
  assert.deepEqual(model.context('criterion:A1').ancestry, ['domain_a', 'analysis']);
  assert.equal(model.context('criterion:A1').enclosing, 'analysis');
});

test('cyclic code paths terminate traversal and an unknown node has no fabricated relationships', () => {
  const source = graph().manifest;
  source.edges.push({ from: 'end', to: 'analysis', kind: 'conditional' });
  const model = createFlowGraph(source);
  assert.deepEqual(new Set(model.context('analysis').after), new Set(['end', 'branch']));
  assert.equal(model.node('unknown'), null);
  assert.deepEqual(model.context('unknown').before, []);
});

test('generated manifest drives seven overview cards while all generated nodes remain searchable', () => {
  assert.equal(FLOW_GRAPH.overview.length, 7);
  assert.equal((overviewMarkup().match(/data-summary-node=/g) || []).length, 7);
  for (const node of FLOW_GRAPH.nodes.values()) assert.ok(FLOW_GRAPH.groupFor(node.id), `missing overview membership: ${node.id}`);
  for (const [from, to] of overviewConnections()) { assert.ok(FLOW_GRAPH.node(from)); assert.ok(FLOW_GRAPH.node(to)); assert.notEqual(from, to); }
  for (const id of FLOW_NODES.keys()) assert.ok(FLOW_GRAPH.node(id), `lost existing detail: ${id}`);
  const domains = analysisDomains();
  assert.equal(domains.length, 4);
  for (const id of domains) assert.equal(FLOW_GRAPH.children(id).filter((key) => key.startsWith('criterion:')).length, 3);
});

test('selection uses node-specific examples and domains expose their actual child criteria', () => {
  const model = graph();
  const first = makeNodeDemo(model, 'criterion:A1'), second = makeNodeDemo(model, 'criterion:A2');
  assert.notEqual(first.title, second.title);
  assert.notEqual(first.input, second.input);
  assert.deepEqual(makeNodeDemo(model, 'domain_a').outputs.map((entry) => entry.label), ['경험 근거', '성과 근거']);
  assert.deepEqual(makeNodeDemo(model, 'analysis').outputs.map((entry) => entry.label), ['완성도']);
  assert.equal(makeNodeDemo(model, 'criterion:A1', 'failure').outcome, 'failure');
  assert.equal(makeNodeDemo(model, 'missing'), null);
});

test('selection, reset and destroy invalidate delayed callbacks even if cancellation races', () => {
  const tasks = [], changes = [];
  const runner = createExplorerPlayback({ schedule: (fn) => { tasks.push(fn); return tasks.length; }, cancel() {}, onChange: (value) => changes.push(value) });
  runner.select(makeNodeDemo(graph(), 'criterion:A1')); runner.play();
  const lateFirst = tasks[0];
  runner.select(makeNodeDemo(graph(), 'criterion:A2'));
  lateFirst();
  assert.equal(runner.snapshot().nodeId, 'criterion:A2'); assert.equal(runner.snapshot().index, -1);
  runner.play(); const lateSecond = tasks.at(-1); runner.pause(); lateSecond();
  assert.equal(runner.snapshot().status, 'paused'); assert.equal(runner.snapshot().index, 0);
  runner.resume(); tasks.at(-1)(); tasks.at(-1)();
  assert.equal(runner.snapshot().status, 'complete');
  runner.reset(); assert.equal(runner.snapshot().status, 'idle');
  runner.play(); const afterDestroy = tasks.at(-1); runner.destroy(); const count = changes.length;
  afterDestroy(); assert.equal(changes.length, count);
});

test('summary state aggregates only instrumented member events, preserving active parallel work', () => {
  const values = new Map([['api_auth', { node: 'api_auth', at: 10, state: 'pending' }], ['auth', { node: 'auth', at: 20, state: 'member' }]]);
  const summary = summaryObservation({ members: ['api_auth', 'auth', 'not-instrumented'] }, (id) => values.get(id));
  assert.equal(summary.latest.node, 'api_auth'); assert.equal(summary.activeCount, 1); assert.equal(summary.observedCount, 2);
});
