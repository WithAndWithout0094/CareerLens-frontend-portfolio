import { analysisDomains } from './explorer-model.js';

// Isolated, deterministic examples. This module has no network, account,
// storage, telemetry, or model client dependency.
export function makeNodeDemo(graph, id, outcome = 'success') {
  const node = graph.node(id);
  if (!node) return null;
  const group = node.kind === 'overview' ? node : graph.groupFor(id);
  const family = group?.sourceId || '';
  const children = graph.children(id).map((child) => graph.node(child)).filter(Boolean);
  const criterion = id.startsWith('criterion:');
  const domain = node.kind === 'domain' || /^domain_[a-z]+$/.test(id);
  const samples = {
    auth: { input: '가상 계정: 체험 사용자 · 예시 인증 상태: 비회원', action: '예시 입력 확인 → 인증 응답 처리 → 화면 상태 반영', output: '체험 사용자로 로그인된 예시 화면 상태' },
    resume: { input: '가상 이력서: 웹 프로젝트 1건, JavaScript·Python, 협업 경험', action: '예시 문서 확인 → 내용 추출 → 구조화 결과 준비', output: '경험 1건 · 기술 2개 · 이력서 준비 완료 예시' },
    posting: { input: '가상 공고: 프론트엔드 개발 · JavaScript와 API 연동 경험', action: '예시 직무 검색 → 공고 조건 읽기 → 선택 상태 구성', output: '가상 프론트엔드 공고 1건 선택' },
    evaluate: { input: '가상 이력서 1건 + 가상 공고 1건', action: '입력 확인 → 가상 요청 생성 → 예시 진행 상태 수신', output: '가상 분석 요청 준비 완료 · 실제 요청 없음' },
    analysis: { input: '가상 경험: 입력 폼·API 연동 구현 / 가상 요건: 웹 개발 경험', action: '예시 근거 읽기 → 항목별 판단 → 결과 형식 구성', output: '예시 평가 결과 준비 완료' },
    report: { input: '가상 평가 결과 + 예시 인증 완료 상태', action: '예시 결과 확인 → 보고서 형식 구성 → 화면 표시', output: '가상 보고서 표시 완료 · 실제 보고서 저장 없음' },
    dashboard: { input: '가상 실행 3건: 대기 1 · 처리 중 1 · 완료 1', action: '예시 상태 분류 → 운영 지표 묶기 → 읽기 전용 표시', output: '가상 실행 요약 3건 · 실제 운영 기록 아님' },
  };
  const sample = samples[family] || { input: `${node.label}용 가상 입력`, action: `${node.label}의 입력·처리·출력 예시`, output: `${node.label}의 가상 처리 결과` };
  let input = sample.input, action = `${node.label}: ${sample.action}`;
  let outputs = [{ label: node.label, value: sample.output }];
  if (criterion) {
    input = `가상 이력서·공고에서 추출한 예시 근거 · 평가 항목: ${node.label}`;
    action = `${node.label} 기준으로 예시 근거와 판단을 연결합니다.`;
    outputs = [{ label: '평가 항목', value: node.label }, { label: '가상 점수', value: '75 / 100' },
      { label: '예시 근거', value: '구현 범위와 본인 역할은 있으나 검증 결과 설명이 더 필요합니다.' }];
  } else if (domain) {
    action = `${node.label}의 하위 기준을 각각 확인하고 예시 결과로 묶습니다.`;
    outputs = children.filter((child) => child.id.startsWith('criterion:')).map((child, index) => ({ label: child.label, value: `${[75, 80, 65][index % 3]} / 100 · 가상 점수` }));
  } else if (id === 'analysis' || id === 'overview:analysis') {
    outputs = analysisDomains(graph).map((key) => graph.node(key)).filter(Boolean)
      .map((child, index) => ({ label: child.label, value: `${[78, 72, 85, 68][index]} / 100 · 가상 점수` }));
  } else if (node.kind === 'api' || id.startsWith('api:')) {
    input = `가상 요청: ${id.replace(/^api:/, '')} · 비밀정보 없는 예시 입력`;
    action = `${node.label}의 요청·응답 순서만 브라우저 안에서 시연합니다.`;
    outputs = [{ label: '예시 응답', value: '200 · 예시 응답 구조 확인' }, { label: '대상 기능', value: node.label }];
  } else if (id.startsWith('field:') || node.kind === 'field') {
    input = `가상 데이터 필드: ${node.label}`;
    outputs = [{ label: node.label, value: '이 필드에 대응하는 예시 값' }];
  } else if (children.length && !outputs.length) outputs = children.map((child) => ({ label: child.label, value: '가상 처리 완료' }));
  if (!outputs.length) outputs = [{ label: node.label, value: sample.output }];
  if (outcome === 'failure') outputs = [{ label: `${node.label} 예외 예시`, value: '입력 또는 응답을 확인할 수 없어 이 단계에서 중단했습니다. 이전 실제 데이터는 바뀌지 않습니다.' }];
  return { nodeId: id, title: `${node.label} ${outcome === 'failure' ? '실패' : '성공'} 시연`, input, action, outputs, outcome,
    steps: [ { label: '가상 입력 준비', message: input }, { label: `${node.label} 처리`, message: action },
      { label: outcome === 'failure' ? '예외 안내' : '가상 출력 확인', message: outputs.map((entry) => `${entry.label}: ${entry.value}`).join(' · ') } ] };
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
    if (index >= selected.steps.length - 1) { status = 'complete'; timer = null; emit(); return; }
    emit(); timer = schedule(() => advance(token), 900);
  }
  return {
    select(demo) { stop(); selected = demo; index = -1; status = 'idle'; emit(); },
    play() { if (!selected || destroyed) return; stop(); index = -1; status = 'playing'; advance(generation); },
    pause() { if (status !== 'playing') return; stop(); status = 'paused'; emit(); },
    resume() { if (status !== 'paused' || destroyed) return; status = 'playing'; timer = schedule(() => advance(generation), 900); emit(); },
    reset() { stop(); index = -1; status = 'idle'; emit(); },
    snapshot,
    destroy() { stop(); selected = null; destroyed = true; },
  };
}
