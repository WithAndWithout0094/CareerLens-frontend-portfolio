import assert from 'node:assert/strict';
import test from 'node:test';
import { createFlowGraph, FLOW_GRAPH, summaryObservation, overviewConnections, analysisDomains } from '../../src/features/activity-flow/explorer-model.js';
import { makeNodeDemo, createExplorerPlayback } from '../../src/features/activity-flow/explorer-demo.js';
import { overviewMarkup } from '../../src/features/activity-flow/explorer-dialog.js';
import { FLOW_NODES } from '../../src/features/activity-flow/catalog.js';
import { EXAMPLE_CRITERION_CONTRACTS } from '../../src/features/activity-flow/explorer-example-contracts.js';

const graph = () => createFlowGraph({ version: 1, sourceDigest: 'fixture', limitations: [],
  nodes: [
    { id: 'start', label: '시작', kind: 'stage' }, { id: 'analysis', label: '분석', kind: 'stage' },
    { id: 'domain_a', label: '완성도', kind: 'domain', parentId: 'analysis' },
    { id: 'criterion:A1', label: '경험 설명의 구체성', kind: 'criterion', parentId: 'domain_a', contract: EXAMPLE_CRITERION_CONTRACTS.A1 },
    { id: 'criterion:A2', label: '성과 근거의 명확성', kind: 'criterion', parentId: 'domain_a', contract: EXAMPLE_CRITERION_CONTRACTS.A2 },
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
  assert.deepEqual(makeNodeDemo(model, 'domain_a').outputs.map((entry) => entry.label), ['경험 설명의 구체성', '성과 근거의 명확성']);
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

test('login, logout, cancellation and locked reports model different user state transitions', () => {
  const login = makeNodeDemo(FLOW_GRAPH, 'auth'), logout = makeNodeDemo(FLOW_GRAPH, 'logout');
  assert.match(login.input, /비회원/); assert.match(login.outputs[0].value, /인증 상태: 회원/);
  assert.match(logout.input, /인증 상태: 회원/); assert.match(logout.action, /비웁/);
  assert.match(logout.outputs[0].value, /인증 상태: 비회원/); assert.match(logout.outputs[0].value, /표시 이름 제거/);
  assert.doesNotMatch(logout.outputs[0].value, /로그인된|회원 상태 유지/);
  assert.match(makeNodeDemo(FLOW_GRAPH, 'cancel').outputs[0].value, /상태: 취소/);
  assert.match(makeNodeDemo(FLOW_GRAPH, 'report_lock').outputs[0].value, /잠금 유지.*로그인 필요/);
  assert.match(makeNodeDemo(FLOW_GRAPH, 'guest_claim').outputs[0].value, /계정에 연결됨.*추가 분석 없음/);
});

test('resume, job, request, report and dashboard demonstrate their own inputs and outputs', () => {
  const cases = [
    ['resume', /이력서/, /본문과 기술 항목/], ['role', /희망 직무/, /관련 가상 공고 목록/],
    ['posting', /공고 목록/, /선택 공고 1건/], ['evaluate', /이력서.*공고/, /대기 상태.*보고서 결과는 없음/],
    ['report', /작성 완료.*보고서/, /표시 완료.*재분석하지 않음/], ['dashboard', /대기 1건.*처리 중 1건.*완료 1건/, /대기 1.*처리 중 1.*완료 1/],
  ];
  for (const [id, input, output] of cases) {
    const example = makeNodeDemo(FLOW_GRAPH, id);
    assert.equal(example.presentation, 'functional', id); assert.match(example.input, input, id); assert.match(example.outputs[0].value, output, id);
    assert.notEqual(makeNodeDemo(FLOW_GRAPH, id, 'failure').outputs[0].value, example.outputs[0].value);
  }
});

test('C2 compares academic requirements and avoids unrelated implementation-role evidence', () => {
  const c2 = makeNodeDemo(FLOW_GRAPH, 'criterion:C2');
  assert.equal(c2.presentation, 'functional');
  assert.match(c2.input, /학사 이상.*전공 조건 없음.*인문학 학사/);
  assert.match(c2.action, /없는 전공 제한을 추가하지/);
  assert.equal(c2.outputs.find((entry) => entry.label === '가상 점수').value, '100 / 100');
  assert.match(c2.outputs.find((entry) => entry.label === '판단 근거').value, /학사 조건.*전공 조건이 없으므로.*감점하지/);
  assert.doesNotMatch(c2.input + c2.action + c2.outputs.find((entry) => entry.label === '판단 근거').value, /본인 역할|구현 범위|검증 결과/);
  const c1 = makeNodeDemo(FLOW_GRAPH, 'criterion:C1');
  assert.match(c1.input, /24개월.*12개월/); assert.match(c1.outputs.find((entry) => entry.label === '판단 근거').value, /미충족/);
  const b1 = makeNodeDemo(FLOW_GRAPH, 'criterion:B1');
  assert.match(b1.input, /JavaScript.*API 연동/); assert.match(b1.action, /필수 기술.*직접 구현/);
});

test('all current rubric examples bind to exact source semantics and have distinct evidence', () => {
  const examples = Object.keys(EXAMPLE_CRITERION_CONTRACTS).map((code) => makeNodeDemo(FLOW_GRAPH, `criterion:${code}`));
  assert.equal(examples.length, 12);
  assert.ok(examples.every((entry) => entry.presentation === 'functional'));
  assert.equal(new Set(examples.map((entry) => entry.input)).size, 12);
  assert.equal(new Set(examples.map((entry) => entry.outputs.find((output) => output.label === '판단 근거').value)).size, 12);
});

test('new or changed rubric meanings fall back to the current source contract, not stale examples', () => {
  const manifest = structuredClone(FLOW_GRAPH.manifest);
  const c2 = manifest.nodes.find((node) => node.id === 'criterion:C2');
  c2.contract.anchors = '새 코드 기준: 학력 대신 별도의 선언된 조건';
  const model = createFlowGraph(manifest), changed = makeNodeDemo(model, c2.id);
  assert.equal(changed.presentation, 'structure'); assert.match(changed.title, /구조 시연/);
  assert.ok(changed.outputs.some((entry) => entry.value === c2.contract.anchors));
  assert.ok(changed.outputs.every((entry) => entry.label !== '가상 점수'));
  const newCriterion = { ...c2, id: 'criterion:C4', label: '새 기준', contract: { ...c2.contract, code: 'C4', name: '새 기준' } };
  manifest.nodes.push(newCriterion);
  assert.equal(makeNodeDemo(createFlowGraph(manifest), 'criterion:C4').presentation, 'structure');
  assert.equal(makeNodeDemo(model, 'domain_c').presentation, 'structure', 'changed child invalidates aggregate fiction too');
});

test('internal API and schema cards show declared contracts without invented HTTP success', () => {
  const api = [...FLOW_GRAPH.nodes.values()].find((node) => node.kind === 'api');
  const example = makeNodeDemo(FLOW_GRAPH, api.id);
  assert.equal(example.presentation, 'structure'); assert.match(example.input, /실제 선언:/);
  assert.match(example.action, /HTTP 요청이나 가상 200 응답을 만들지/);
  assert.ok(example.outputs.every((entry) => !/200.*응답/.test(entry.value)));
  const schema = [...FLOW_GRAPH.nodes.values()].find((node) => node.id.startsWith('field:'));
  const field = makeNodeDemo(FLOW_GRAPH, schema.id);
  assert.equal(field.presentation, 'structure'); assert.match(field.title, /구조 시연/);
  assert.doesNotMatch(field.outputs.map((entry) => entry.value).join(' '), /이 필드에 대응하는 예시 값/);
});

test('a cancelled resume callback cannot advance the newly selected card or a restarted run', () => {
  const tasks = [];
  const runner = createExplorerPlayback({ schedule: (fn) => { tasks.push(fn); return tasks.length; }, cancel() {} });
  runner.select(makeNodeDemo(FLOW_GRAPH, 'criterion:A1')); runner.play(); runner.pause(); runner.resume();
  const cancelledResume = tasks.at(-1);
  runner.select(makeNodeDemo(FLOW_GRAPH, 'criterion:B1')); runner.play();
  assert.equal(runner.snapshot().index, 0);
  cancelledResume();
  assert.equal(runner.snapshot().nodeId, 'criterion:B1'); assert.equal(runner.snapshot().index, 0);
  runner.pause(); runner.resume(); const cancelledSameCard = tasks.at(-1);
  runner.reset(); runner.play(); cancelledSameCard();
  assert.equal(runner.snapshot().index, 0);
  runner.destroy();
});

test('error demonstration ends as an error after input and processing, never as successful completion', () => {
  const tasks = [], states = [];
  const runner = createExplorerPlayback({ schedule: (fn) => { tasks.push(fn); return tasks.length; }, cancel() {}, onChange: (state) => states.push({ status: state.status, index: state.index }) });
  const example = makeNodeDemo(FLOW_GRAPH, 'criterion:C2', 'failure');
  runner.select(example); runner.play();
  assert.equal(runner.snapshot().index, 0);
  tasks.at(-1)();
  assert.equal(runner.snapshot().index, 1);
  assert.equal(runner.snapshot().status, 'playing');
  runner.pause(); runner.resume();
  const delayed = tasks.at(-1);
  delayed();
  assert.deepEqual(states.at(-1), { status: 'failed', index: 2 });
  assert.ok(states.every((state) => state.status !== 'complete'));
  assert.match(runner.snapshot().demo.steps[2].label, /오류/);
  runner.reset();
  delayed();
  assert.deepEqual(states.at(-1), { status: 'idle', index: -1 });
  runner.select(makeNodeDemo(FLOW_GRAPH, 'criterion:C2')); runner.play();
  tasks.at(-1)(); tasks.at(-1)();
  assert.equal(runner.snapshot().status, 'complete');
  assert.equal(runner.snapshot().demo.outcome, 'success');
  runner.destroy();
});
