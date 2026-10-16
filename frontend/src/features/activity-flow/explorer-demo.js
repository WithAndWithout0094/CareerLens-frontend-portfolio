import { analysisDomains } from './explorer-model.js';
import { OPERATION_EXAMPLES, OVERVIEW_EXAMPLES, CRITERION_EXAMPLES } from './explorer-examples.js';
import { EXAMPLE_CRITERION_CONTRACTS } from './explorer-example-contracts.js';

// All examples stay in memory. The manifest supplies contracts, never a client
// that can invoke the selected API, helper, database, or paid model.
const relationLabel = { flow: '처리 순서', conditional: '조건 분기', interaction: '사용자 동작', navigation: '화면 이동', calls: '호출 대상', contains: '하위 구성', produces: '생성 구조' };

function matchingCriterion(node) {
  const code = node.id.replace(/^criterion:/, ''), expected = EXAMPLE_CRITERION_CONTRACTS[code], actual = node.contract;
  return expected && actual && ['code', 'name', 'domain', 'weight', 'anchors'].every((field) => expected[field] === actual[field])
    && node.label.includes(expected.name) ? CRITERION_EXAMPLES[code] : null;
}

function structureExample(graph, node, failed) {
  const outgoing = graph.edges.filter((edge) => edge.from === node.id);
  const incoming = graph.edges.filter((edge) => edge.to === node.id);
  const fields = node.contract ? Object.entries(node.contract).map(([key, value]) => ({ label: key, value: typeof value === 'string' ? value : JSON.stringify(value) })) : [];
  const sources = (node.sourceRefs || []).map((ref) => `${ref.path}${ref.symbol ? ` · ${ref.symbol}` : ''}`).join(' / ');
  const api = /^api:([A-Z]+):(.+)$/.exec(node.id);
  const input = api ? `실제 선언: ${api[1]} ${api[2]} · 요청 본문이나 인증값은 실행하지 않습니다.`
    : `${node.label}의 현재 코드 선언${fields.length ? ` · 계약 필드 ${fields.length}개` : ''}${sources ? ` · ${sources}` : ''}`;
  const action = api ? '요청 방식·경로 선언을 읽고 연결된 처리 함수와 응답 구조를 따라갑니다. HTTP 요청이나 가상 200 응답을 만들지 않습니다.'
    : '선택한 카드의 소스 근거와 선언된 구성·호출·응답 관계를 순서대로 펼칩니다. 함수의 실제 반환값을 추정하지 않습니다.';
  const outputs = failed ? [{ label: '구조 확인 중단 예시', value: `${node.label}에 필요한 코드 근거를 읽지 못했다고 가정합니다. 실행 성공이나 반환값을 표시하지 않습니다.` }]
    : [...fields, ...outgoing.map((edge) => ({ label: relationLabel[edge.kind] || edge.kind, value: graph.node(edge.to)?.label || edge.to })),
      ...incoming.map((edge) => ({ label: `들어오는 ${relationLabel[edge.kind] || edge.kind}`, value: graph.node(edge.from)?.label || edge.from }))];
  if (!outputs.length) outputs.push({ label: '현재 선언', value: node.description || node.label }, { label: '구조 범위', value: '수집된 하위·호출 연결 없음 · 실행 결과는 추정하지 않음' });
  return { input, action, outputs, presentation: 'structure', explanation: '구조 시연입니다. 현재 소스에 선언된 계약과 연결을 보여주며, 함수 실행 결과나 평가 점수를 만들지 않습니다.' };
}

function operationExample(example, failed) {
  return { input: failed ? `${example[0]} · 이 기능에서 오류가 발생하는 상황을 가정합니다.` : example[0], action: example[1],
    outputs: [{ label: failed ? '가상 오류 결과' : '가상 기능 결과', value: failed ? example[3] : example[2] }],
    presentation: 'functional', explanation: '선택한 사용자 기능의 가상 입력·상태 변화를 재현합니다. 실제 계정·분석·저장 요청은 실행하지 않습니다.' };
}

function criterionExample(node, failed) {
  const example = matchingCriterion(node);
  if (!example) return null;
  return { input: failed ? `${example[1]} · 평가 응답을 확인할 수 없는 오류 상황` : example[1], action: example[2],
    outputs: failed ? [{ label: '평가 중단 예시', value: example[5] }]
      : [{ label: '평가 항목', value: node.contract.name }, { label: '가상 점수', value: `${example[3]} / 100` }, { label: '판단 근거', value: example[4] }, { label: '현재 코드의 평가 기준', value: node.contract.anchors }],
    presentation: 'functional', explanation: '현재 평가 기준과 일치하는 학습용 예시입니다. 점수와 입력은 가상이며 실제 사용자의 평가가 아닙니다.' };
}

function domainExample(graph, node, failed) {
  const criteria = graph.children(node.id).map((id) => graph.node(id)).filter((child) => child?.id.startsWith('criterion:'));
  if (!criteria.length || criteria.some((child) => !matchingCriterion(child))) return null;
  const outcomes = criteria.map((child) => ({ child, sample: matchingCriterion(child) }));
  return { input: outcomes.map(({ child, sample }) => `${child.contract.name}: ${sample[1]}`).join('\n'),
    action: `${node.label}의 각 기준을 독립적으로 확인합니다. 아래 항목별 가상 점수는 실제 결과가 아닙니다.`,
    outputs: failed ? [{ label: '영역 평가 중단 예시', value: `${outcomes[0].child.contract.name}의 평가 응답이 유효하지 않아 영역 완료로 표시하지 않습니다.` }]
      : outcomes.map(({ child, sample }) => ({ label: child.label, value: `${sample[3]} / 100 · ${sample[4]}` })),
    presentation: 'functional', explanation: '현재 영역에 속한 실제 평가 기준별로 서로 다른 가상 입력과 판단 근거를 보여줍니다.' };
}

export function makeNodeDemo(graph, id, outcome = 'success') {
  const node = graph.node(id);
  if (!node) return null;
  const failed = outcome === 'failure';
  let example = null;
  if (id.startsWith('criterion:')) example = criterionExample(node, failed);
  else if (node.kind === 'domain' || /^domain_[a-z]+$/.test(id)) example = domainExample(graph, node, failed);
  else if (id === 'analysis' || id === 'overview:analysis') {
    const domains = analysisDomains(graph).map((key) => graph.node(key));
    const domainExamples = domains.map((domain) => domainExample(graph, domain, false));
    if (domains.length && domainExamples.every(Boolean)) example = {
      input: '학습용 가상 이력서와 공고의 경험·기술·업무·경력·학력·기타 조건을 영역별로 나누어 입력합니다.',
      action: '각 영역의 실제 평가 기준에 대응하는 가상 근거를 확인하고 영역별 항목 결과를 출력합니다.',
      outputs: failed ? [{ label: '분석 중단 예시', value: '영역 중 하나의 평가 응답이 유효하지 않아 전체 완료 결과를 만들지 않습니다.' }]
        : domains.map((domain, index) => ({ label: domain.label, value: domainExamples[index].outputs.map((entry) => `${entry.label}: ${entry.value}`).join(' / ') })),
      presentation: 'functional', explanation: '현재 코드의 평가 영역과 기준에 맞춘 가상 결과입니다. 각 영역 카드를 열면 해당 입력과 근거를 볼 수 있습니다.' };
  } else if (id === 'scoring') {
    const domains = analysisDomains(graph).map((key) => graph.node(key));
    const criteria = domains.flatMap((domain) => graph.children(domain.id).map((key) => graph.node(key))).filter((child) => child?.id.startsWith('criterion:'));
    if (criteria.length && criteria.every(matchingCriterion)) example = {
      input: criteria.map((criterion) => `${criterion.contract.code}=${matchingCriterion(criterion)[3]}, 영역 내 가중치=${criterion.contract.weight}`).join(' · '),
      action: '현재 코드의 항목 가중치와 예시 점수를 읽습니다. 아래는 영역 내 가중합이며 전체 가중치 합산과 구분합니다.',
      outputs: failed ? [{ label: '계산 중단 예시', value: '필수 항목 점수가 없어 최종 점수를 0으로 대체하지 않고 계산을 중단합니다.' }]
        : domains.map((domain) => ({ label: `${domain.label} 예시 가중합`, value: String(graph.children(domain.id).map((key) => graph.node(key)).filter((child) => child?.id.startsWith('criterion:')).reduce((total, criterion) => total + matchingCriterion(criterion)[3] * criterion.contract.weight, 0)) })),
      presentation: 'functional', explanation: '가중치 구조를 설명하기 위한 가상 점수 계산입니다. 실제 보고서의 최종 점수가 아닙니다.' };
  } else {
    const fixture = node.kind === 'overview' ? OVERVIEW_EXAMPLES[node.sourceId] : OPERATION_EXAMPLES[id];
    if (fixture) example = operationExample(fixture, failed);
  }
  example ||= structureExample(graph, node, failed);
  const structural = example.presentation === 'structure';
  return { nodeId: id, title: `${node.label} ${structural ? '구조 시연' : '기능 시연'} · ${failed ? '오류 예시' : '정상 예시'}`, ...example, outcome: failed ? 'failure' : 'success',
    steps: [{ label: structural ? '현재 선언 읽기' : '가상 입력 준비', message: example.input },
      { label: structural ? '선택한 코드 관계 탐색' : `${node.label} 처리`, message: example.action },
      { label: failed ? '오류 안내' : structural ? '현재 계약 확인' : '가상 출력 확인', message: example.outputs.map((entry) => `${entry.label}: ${entry.value}`).join(' · ') }] };
}

// Navigation owns this runner. Every selection invalidates outstanding work.
export function createExplorerPlayback({ schedule = setTimeout, cancel = clearTimeout, onChange = () => {} } = {}) {
  let timer = null, generation = 0, selected = null, index = -1, status = 'idle', destroyed = false;
  const snapshot = () => ({ nodeId: selected?.nodeId || null, demo: selected, index, status });
  function stop() { generation++; if (timer !== null) cancel(timer); timer = null; }
  function emit() { if (!destroyed) onChange(snapshot()); }
  function advance(token) {
    if (destroyed || token !== generation || status !== 'playing') return;
    index++;
    if (index >= selected.steps.length - 1) { status = selected.outcome === 'failure' ? 'failed' : 'complete'; timer = null; emit(); return; }
    emit(); timer = schedule(() => advance(token), 900);
  }
  return {
    select(demo) { stop(); selected = demo; index = -1; status = 'idle'; emit(); },
    play() { if (!selected || destroyed) return; stop(); index = -1; status = 'playing'; advance(generation); },
    pause() { if (status !== 'playing') return; stop(); status = 'paused'; emit(); },
    resume() { if (status !== 'paused' || destroyed) return; status = 'playing'; const token = generation; timer = schedule(() => advance(token), 900); emit(); },
    reset() { stop(); index = -1; status = 'idle'; emit(); },
    snapshot,
    destroy() { stop(); selected = null; destroyed = true; },
  };
}
