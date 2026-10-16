import { FLOW_GRAPH, summaryObservation, overviewConnections, analysisDomains } from './explorer-model.js';
import { makeNodeDemo, createExplorerPlayback } from './explorer-demo.js';
import { flowEventLabel } from './catalog.js';
import { buildExplorerMap, explorerMapMarkup, mountExplorerMap, mountMapVisibility, MAP_CARD } from './explorer-map.js';
import { buildOverviewMap, overviewMapMarkup, mountOverviewMap } from './overview-map.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const arrow = '<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h14m-5-5 5 5-5 5"/></svg>';
const relationship = { flow: '처리 순서', conditional: '조건 분기', interaction: '사용자 동작', navigation: '화면 이동', calls: '함수 호출', contains: '하위 구성', produces: '응답 형식' };

export function overviewMarkup(graph = FLOW_GRAPH) {
  return `<section class="flow-overview" aria-label="서비스 흐름 요약" data-flow-overview>
    <header><div><h2>처음부터 결과까지, 흐름을 펼쳐보세요</h2><p data-overview-state-copy>카드를 선택하면 연결된 단계와 기능별 시연이 열립니다. 아래 상태는 선택한 관찰 대상의 실제 기록입니다.</p></div><button type="button" data-flow-explore="overview:analysis">분석 구조 살펴보기 ${arrow}</button></header>
    ${overviewMapMarkup(buildOverviewMap(graph))}
    <details class="flow-overview-relations"><summary>전체 연결 관계 보기</summary><ul>${overviewConnections(graph).map(([from, to]) => `<li><button type="button" data-flow-explore="${esc(from)}">${esc(graph.node(from).label)}</button>${arrow}<button type="button" data-flow-explore="${esc(to)}">${esc(graph.node(to).label)}</button></li>`).join('')}</ul><p>카드 위치는 이용 단계를 구분합니다. 선은 실제 코드의 처리·호출 관계이며, 실제 이용 상태는 카드의 관찰 기록에서 확인합니다.</p></details>
    <p class="flow-source-version">코드에서 생성한 기능 ${graph.nodes.size}개 · 연결 ${graph.edges.length}개 · 소스 ${esc(graph.manifest.sourceDigest?.slice(0, 10) || '확인 불가')} <span>코드 변경 후 빌드할 때 갱신됩니다.</span></p>
  </section>`;
}

export function updateOverview(host, readEvent, { demo = false } = {}, graph = FLOW_GRAPH) {
  const copy = host.querySelector('[data-overview-state-copy]');
  if (copy) copy.textContent = demo ? '카드를 선택하면 연결된 단계와 기능별 시연이 열립니다. 현재 개요 상태도 가상 시연이며 실제 실행 기록이 아닙니다.' : '카드를 선택하면 연결된 단계와 기능별 시연이 열립니다. 아래 상태는 선택한 관찰 대상의 실제 기록입니다.';
  for (const group of graph.overview) {
    const card = host.querySelector(`[data-summary-node="${group.id}"]`);
    if (!card) continue;
    const state = summaryObservation(group, readEvent);
    const label = state.latest ? `${flowEventLabel(state.latest)}${state.activeCount > 1 ? ` · 진행 항목 ${state.activeCount}개` : ''}` : demo ? '시연 기록 없음' : '수집된 기록 없음';
    card.querySelector('[data-summary-status]').textContent = `${demo ? '가상 시연 · ' : ''}${label}`;
    card.dataset.state = state.latest?.state || 'idle';
  }
}

export function mountFlowExplorer(host, { graph = FLOW_GRAPH } = {}) {
  const doc = host.ownerDocument || document;
  const win = doc.defaultView || window;
  const dialog = doc.createElement('dialog');
  dialog.className = 'flow-explorer';
  dialog.setAttribute('aria-labelledby', 'flow-explorer-title');
  dialog.setAttribute('aria-describedby', 'flow-explorer-notice');
  host.querySelector('.flow-shell').append(dialog);
  let history = [], trigger = null, tab = 'flow', scenario = 'success', search = '', disposed = false;
  let currentDemo = null;
  let mapController = null, expanded = false;
  const views = new Map(), scrollPositions = new Map();
  const disposeOverview = mountOverviewMap(host, graph);
  const disposeVisibility = mountMapVisibility(dialog);
  const playback = createExplorerPlayback({ schedule: (fn, ms) => win.setTimeout(fn, ms), cancel: (id) => win.clearTimeout(id), onChange: renderDemoState });
  const selected = () => history.at(-1);
  const nodeButton = (id, small = false) => {
    const node = graph.node(id);
    if (!node) return '';
    return `<button type="button" class="${small ? 'flow-explorer-link' : 'flow-explorer-node'}" data-explore-node="${esc(id)}" ${id === selected() ? 'aria-current="step"' : ''}><strong>${esc(node.label)}</strong>${small ? '' : `<span>${esc(node.description || node.kind || '코드에서 확인된 기능')}</span>`}${arrow}</button>`;
  };
  function group(title, ids, { collapsed = true, empty = '연결된 단계가 없습니다.' } = {}) {
    const body = ids.length ? `<div class="flow-explorer-nodes">${ids.map((id) => nodeButton(id)).join('')}</div>` : `<p class="flow-explorer-empty">${empty}</p>`;
    return collapsed ? `<details class="flow-explorer-group"><summary>${title} <span>${ids.length}개</span></summary>${body}</details>`
      : `<section class="flow-explorer-group"><h3>${title} <span>${ids.length}개</span></h3>${body}</section>`;
  }
  function renderFlow(id) {
    const context = graph.context(id), node = context.node;
    const enclosing = context.enclosing ? graph.context(context.enclosing) : null;
    const domains = analysisDomains(graph);
    const isAnalysis = id === 'overview:analysis' || id === 'analysis';
    const allMembers = node.kind === 'overview' ? node.members : [];
    const sources = node.sourceRefs || [];
    return `<div class="flow-explorer-content" data-explore-content tabindex="-1">
      ${context.ancestry.length ? group('이 기능이 속한 상위 구성', context.ancestry) : ''}
      ${group('바로 앞 연결', context.predecessors, { empty: '이 단계로 들어오는 실행·호출 연결이 수집된 코드 범위에 없습니다.' })}
      <section class="flow-explorer-focus"><h3>${esc(node.label)}</h3><p>${esc(node.description || '실제 코드에서 확인된 기능입니다.')}</p><button type="button" data-explore-tab="demo">이 기능 시연하기 ${arrow}</button></section>
      ${isAnalysis ? group(`분석 결과 · ${domains.length}개 평가 영역`, domains) : ''}
      ${group('하위 구성', context.children.filter((key) => !isAnalysis || !domains.includes(key)), { empty: '더 내려갈 하위 구성이 없습니다. 연결 경로나 시연을 살펴보세요.' })}
      ${group('바로 다음 연결', context.successors, { empty: '이 단계에서 나가는 실행·호출 연결이 수집된 코드 범위에 없습니다.' })}
      ${allMembers.length ? group('이 요약에 포함된 모든 기능', allMembers, { collapsed: true }) : ''}
      ${group('이 단계로 이어지는 전체 이전 경로', context.before, { collapsed: true })}
      ${group('이 단계에서 이어지는 전체 이후 경로', context.after, { collapsed: true })}
      ${group('연결 흐름의 시작', context.starts, { collapsed: true, empty: '순환 연결이 있거나 수집된 범위 안에서 시작점을 확정할 수 없습니다.' })}
      ${group('연결 흐름의 끝', context.ends, { collapsed: true, empty: '순환 연결이 있거나 수집된 범위 안에서 종료점을 확정할 수 없습니다.' })}
      ${enclosing ? `<section class="flow-explorer-inherited"><h3>상위 처리의 연결 · ${esc(enclosing.node.label)}</h3><p class="flow-explorer-empty">선택한 하위 기능이 속한 처리의 경로입니다. 하위 카드 각각의 독립 실행 순서를 뜻하지 않습니다.</p>${group('상위 처리까지 이어지는 경로', enclosing.before, { collapsed: true })}${group('상위 처리 이후의 경로', enclosing.after, { collapsed: true })}${group('상위 처리 흐름의 시작', enclosing.starts, { collapsed: true })}${group('상위 처리 흐름의 끝', enclosing.ends, { collapsed: true })}</section>` : ''}
      <details class="flow-explorer-group"><summary>연결 관계의 종류와 코드 근거</summary><p class="flow-explorer-empty">연결은 코드 구조입니다. 실제 실행을 관측했다는 뜻은 아닙니다. 조건 분기는 실행 때 입력에 따라 달라집니다.</p><ul class="flow-explorer-edge-list">${context.edges.map((edge) => `<li>${nodeButton(edge.from, true)}<span>${esc(relationship[edge.kind] || edge.kind)} ${arrow}</span>${nodeButton(edge.to, true)}</li>`).join('') || '<li>수집된 실행·호출 연결이 없습니다.</li>'}</ul><ul class="flow-explorer-sources">${sources.map((ref) => `<li><code>${esc(ref.path)}${ref.line ? `:${ref.line}` : ''}</code>${ref.symbol ? `<span>${esc(ref.symbol)}</span>` : ''}</li>`).join('') || '<li>요약 구성입니다. 하위 카드를 선택하면 해당 코드의 근거를 확인할 수 있습니다.</li>'}</ul></details>
      <details class="flow-explorer-group"><summary>자동 반영 범위</summary><ul>${(graph.manifest.limitations || []).map((text) => `<li>${esc(text)}</li>`).join('')}</ul><p>새 소스가 배포될 때 생성한 구조를 표시합니다. 이 상세 창의 시연은 실제 이용 기록과 연동되지 않습니다.</p></details>
    </div>`;
  }
  function demoMarkup() {
    return `<section class="flow-explorer-demo" data-explore-content tabindex="-1" aria-label="선택 기능의 가상 시연"><h3>${esc(currentDemo.title)}</h3><p>${esc(currentDemo.explanation)}</p>
      <ol class="flow-explorer-demo-steps">${currentDemo.steps.map((step, index) => `<li data-explore-step="${index}"><strong>${esc(step.label)}</strong><p>${esc(step.message)}</p><span data-explore-step-state>대기</span></li>`).join('')}</ol>
      <section class="flow-explorer-demo-output" data-explore-output hidden><h4>${currentDemo.presentation === 'structure' ? '현재 코드의 구조' : '가상 출력'}</h4><dl>${currentDemo.outputs.map((entry) => `<div><dt>${esc(entry.label)}</dt><dd>${esc(entry.value)}</dd></div>`).join('')}</dl><p>${currentDemo.presentation === 'structure' ? '생성된 소스 계약의 설명입니다. 실제 함수 호출·API 요청·저장은 하지 않았습니다.' : '학습용 가상 값입니다. 실제 평가 결과나 실행 시간이 아닙니다.'}</p></section></section>`;
  }
  function renderDemoState(state = playback.snapshot()) {
    if (!dialog.open) return;
    mapController?.setPlayback(state);
    dialog.querySelectorAll('[data-explore-step]').forEach((item) => {
      const index = Number(item.dataset.exploreStep);
      const failed = state.status === 'failed' && index === state.index;
      item.dataset.state = failed ? 'failed' : index < state.index || state.status === 'complete' ? 'complete' : index === state.index ? 'running' : 'waiting';
      item.querySelector('[data-explore-step-state]').textContent = failed ? '오류 안내 · 종료' : index < state.index || state.status === 'complete' ? '예시 처리 완료' : index === state.index ? (state.status === 'paused' ? '일시정지' : '시연 중') : '대기';
    });
    const status = dialog.querySelector('[data-explore-demo-status]');
    if (!status) return;
    status.textContent = state.status === 'failed' ? '오류 예시 종료 · 기능 시연에서 오류 안내를 확인하세요.' : state.status === 'complete' ? '시연 완료 · 기능 시연에서 출력을 확인하세요.' : state.status === 'paused' ? '일시정지 · 이어서 재생할 수 있습니다.' : state.status === 'playing' ? `${state.demo.steps[state.index].label} · 가상 시연 중` : '가상 시연 · 실제 요청은 보내지 않습니다.';
    const play = dialog.querySelector('[data-explore-play]');
    play.disabled = state.status === 'playing'; play.textContent = state.status === 'paused' ? '이어서 재생' : ['complete', 'failed'].includes(state.status) ? '다시 시연' : '시연 시작';
    dialog.querySelector('[data-explore-pause]').disabled = state.status !== 'playing';
    const output = dialog.querySelector('[data-explore-output]');
    if (output) { output.hidden = !['complete', 'failed'].includes(state.status); output.dataset.outcome = state.status === 'failed' ? 'failure' : 'success'; }
  }
  function renderSidebarList() {
    const list = dialog.querySelector('[data-explore-list]');
    if (!list) return;
    const index = dialog.querySelector('.flow-explorer-index'), oldTop = index.scrollTop;
    const prefixHeight = list.getBoundingClientRect().top - index.getBoundingClientRect().top + oldTop;
    list.style.minHeight = `${Math.max(0, oldTop + index.clientHeight - prefixHeight)}px`;
    const node = graph.node(selected()), groupNode = node.kind === 'overview' ? node : graph.groupFor(node.id);
    const ids = search.trim() ? [...graph.nodes.keys()].filter((id) => `${graph.node(id).label} ${id}`.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')))
      : groupNode?.members || [node.id];
    list.innerHTML = ids.map((id) => nodeButton(id, true)).join('') || '<p class="flow-explorer-empty">검색 결과가 없습니다.</p>';
    dialog.querySelector('[data-explore-list-count]').textContent = `${search.trim() ? '전체 기능 검색' : groupNode?.label || '관련 기능'} · ${ids.length}개`;
    index.scrollTop = oldTop;
  }
  function captureScroll() {
    return Object.fromEntries(['.flow-explorer-sidebar', '.flow-explorer-index', '.flow-explorer-main', '.flow-explorer-layout'].map((selector) => [selector, dialog.querySelector(selector)?.scrollTop || 0]));
  }
  function restoreScroll(values) {
    for (const [selector, top] of Object.entries(values || {})) {
      const element = dialog.querySelector(selector);
      if (element) element.scrollTop = top;
    }
  }
  function savePosition() {
    if (!selected()) return;
    scrollPositions.set(`${selected()}:${tab}`, captureScroll());
    const view = mapController?.snapshot();
    if (view) views.set(`${selected()}:${expanded}`, view);
  }
  function render({ focus = true, scroll = captureScroll() } = {}) {
    const node = graph.node(selected());
    if (!node) return;
    const priorView = mapController?.snapshot();
    const priorAnchor = mapController?.anchor();
    mapController?.destroy(); mapController = null;
    if (!dialog.querySelector('.flow-explorer-layout')) dialog.innerHTML = `<header class="flow-explorer-header"><div><h2 id="flow-explorer-title"></h2><p id="flow-explorer-notice">코드 구조 탐색 · 시연 전용 창 / 실제 이용 상태는 바깥 모니터링 화면에서 확인합니다.</p></div><button type="button" data-explore-close aria-label="세부 흐름 창 닫기">닫기</button></header>
      <nav class="flow-explorer-breadcrumb" aria-label="세부 흐름 탐색 위치"><button type="button" data-explore-back>이전 단계</button><ol></ol></nav>
      <div class="flow-explorer-layout"><aside class="flow-explorer-sidebar" aria-label="흐름 탐색과 시연"><div class="flow-explorer-dock"><div class="flow-explorer-tabs" role="group" aria-label="세부 보기 종류"><button type="button" data-explore-tab="flow">세부 흐름</button><button type="button" data-explore-tab="demo">기능 시연</button></div><label class="flow-explorer-scenario">시연 상황<select data-explore-scenario><option value="success">정상 예시</option><option value="failure">오류 예시</option></select></label><div class="flow-explorer-demo-controls"><button type="button" data-explore-play>시연 시작</button><button type="button" data-explore-pause disabled>일시정지</button><button type="button" data-explore-reset>처음으로</button></div><p class="flow-explorer-demo-status" role="status" aria-live="polite" data-explore-demo-status></p></div><details class="flow-explorer-index" open><summary>관련 기능 탐색</summary><label>기능 검색<input type="search" data-explore-search placeholder="이름 또는 코드 검색" maxlength="100"></label><div class="flow-explorer-summary-nav">${graph.overview.map((entry) => nodeButton(entry.id, true)).join('')}</div><h3 data-explore-list-count></h3><div class="flow-explorer-function-list" data-explore-list></div></details></aside><main class="flow-explorer-main"><div data-explore-body></div></main></div>`;
    dialog.querySelector('#flow-explorer-title').textContent = `${node.label} · 세부 흐름`;
    dialog.querySelector('[data-explore-back]').disabled = history.length < 2;
    dialog.querySelector('.flow-explorer-breadcrumb ol').innerHTML = history.map((id, index) => `<li><button type="button" data-explore-level="${index}" ${index === history.length - 1 ? 'aria-current="step"' : ''}>${esc(graph.node(id).label)}</button></li>`).join('');
    dialog.querySelectorAll('[data-explore-tab]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.exploreTab === tab)));
    dialog.querySelector('[data-explore-scenario]').value = scenario;
    dialog.querySelector('[data-explore-search]').value = search;
    dialog.querySelectorAll('.flow-explorer-summary-nav [data-explore-node]').forEach((button) => { if (button.dataset.exploreNode === selected()) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
    const model = buildExplorerMap(graph, selected(), { expanded });
    const body = dialog.querySelector('[data-explore-body]');
    const main = dialog.querySelector('.flow-explorer-main');
    body.style.minHeight = `${Math.max(0, (scroll['.flow-explorer-main'] || 0) + main.clientHeight - 32)}px`;
    body.innerHTML = `<div class="flow-explorer-map-heading"><div><h3>${esc(node.label)}의 연결 지도</h3><p>${expanded ? '전체 관련 흐름' : '선택 주변 흐름'} · ${model.nodes.length}개 카드 · ${model.edges.length}개 연결${!expanded && model.total > model.nodes.length ? ` / 전체 ${model.total}개는 펼쳐서 확인` : ''}</p></div><button type="button" data-explore-map-scope aria-pressed="${expanded}">${expanded ? '선택 주변만 보기' : '전체 관련 흐름 보기'}</button></div>${explorerMapMarkup(model)}${tab === 'demo' ? demoMarkup() : renderFlow(node.id)}`;
    renderSidebarList();
    const nextAnchor = model.nodes.find((entry) => entry.selected);
    const continuousView = priorView && priorAnchor && nextAnchor ? { ...priorView,
      x: priorView.x + (priorAnchor.x - nextAnchor.x - MAP_CARD.width / 2) * priorView.scale,
      y: priorView.y + (priorAnchor.y - nextAnchor.y - MAP_CARD.height / 2) * priorView.scale } : priorView;
    mapController = mountExplorerMap(dialog.querySelector('[data-explorer-map]'), model, { initialView: views.get(`${selected()}:${expanded}`) || continuousView, onView: (view) => views.set(`${selected()}:${expanded}`, view) });
    renderDemoState();
    restoreScroll(scroll);
    if (focus) dialog.querySelector('[data-explore-content]')?.focus({ preventScroll: true });
  }
  function select(id, { replace = false, back = false } = {}) {
    if (!graph.node(id) || disposed) return;
    const scroll = captureScroll();
    savePosition();
    if (replace) history = [id];
    else {
      const existing = history.indexOf(id);
      history = existing >= 0 ? history.slice(0, existing + 1) : [...history, id];
    }
    scenario = 'success';
    currentDemo = makeNodeDemo(graph, id, scenario); playback.select(currentDemo);
    render({ scroll: back ? scrollPositions.get(`${id}:${tab}`) || scroll : scroll, focus: false });
  }
  function close() {
    playback.reset();
    mapController?.destroy(); mapController = null;
    if (dialog.open) dialog.close();
    history = []; search = ''; tab = 'flow'; expanded = false; views.clear(); scrollPositions.clear(); dialog.innerHTML = '';
    trigger?.isConnected && trigger.focus({ preventScroll: true }); trigger = null;
  }
  function onClick(event) {
    const action = event.target.closest('button');
    if (!action || !dialog.contains(action)) return;
    if (action.hasAttribute('data-explore-close')) { close(); return; }
    if (action.dataset.exploreNode) {
      const id = action.dataset.exploreNode, fromSidebar = Boolean(action.closest('.flow-explorer-sidebar'));
      select(id);
      const replacement = [...dialog.querySelectorAll(fromSidebar ? '.flow-explorer-sidebar [data-explore-node]' : '[data-map-node]')].find((button) => button.dataset.exploreNode === id);
      replacement?.focus({ preventScroll: true });
      return;
    }
    if (action.hasAttribute('data-explore-back')) {
      if (history.length > 1) select(history.at(-2), { back: true }); return;
    }
    if (action.hasAttribute('data-explore-level')) { select(history[Number(action.dataset.exploreLevel)], { back: true }); return; }
    if (action.dataset.exploreTab) { savePosition(); const scroll = captureScroll(); tab = action.dataset.exploreTab; render({ focus: false, scroll }); return; }
    if (action.hasAttribute('data-explore-map-scope')) { savePosition(); expanded = !expanded; render({ focus: false }); dialog.querySelector('[data-explore-map-scope]')?.focus({ preventScroll: true }); return; }
    if (action.hasAttribute('data-explore-play')) { playback.snapshot().status === 'paused' ? playback.resume() : playback.play(); return; }
    if (action.hasAttribute('data-explore-pause')) { playback.pause(); return; }
    if (action.hasAttribute('data-explore-reset')) playback.reset();
  }
  function onInput(event) { if (event.target.matches('[data-explore-search]')) { search = event.target.value; renderSidebarList(); } }
  function onChange(event) {
    if (!event.target.matches('[data-explore-scenario]')) return;
    scenario = event.target.value === 'failure' ? 'failure' : 'success';
    currentDemo = makeNodeDemo(graph, selected(), scenario); playback.select(currentDemo); render({ focus: false });
  }
  function onCancel(event) { event.preventDefault(); close(); }
  function onVisibility() { if (doc.hidden) playback.pause(); }
  dialog.addEventListener('click', onClick); dialog.addEventListener('input', onInput); dialog.addEventListener('change', onChange); dialog.addEventListener('cancel', onCancel);
  doc.addEventListener('visibilitychange', onVisibility);
  return {
    open(id, opener) {
      if (!graph.node(id) || disposed) return false;
      trigger = opener || doc.activeElement; tab = 'flow';
      select(id, { replace: true });
      dialog.showModal(); renderDemoState(); dialog.querySelector('[data-explore-close]')?.focus({ preventScroll: true });
      return true;
    },
    close,
    destroy() {
      if (disposed) return;
      close(); disposed = true; playback.destroy(); disposeOverview(); disposeVisibility(); doc.removeEventListener('visibilitychange', onVisibility);
      dialog.removeEventListener('click', onClick); dialog.removeEventListener('input', onInput); dialog.removeEventListener('change', onChange); dialog.removeEventListener('cancel', onCancel); dialog.remove();
    },
  };
}
