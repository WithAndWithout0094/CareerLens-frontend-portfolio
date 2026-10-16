import { overviewRelations } from './explorer-model.js';
import { edgeMarkup, mountExplorerMap, mountMapVisibility } from './explorer-map.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const OVERVIEW_CARD = Object.freeze({ width: 188, height: 104, column: 248, row: 154 });
const phases = ['접속', '준비', '요청', '분석', '결과·보관'];
// Presentation positions only: no edge is created by this stage ordering.
const positions = { auth: [0, .5], resume: [1, 0], posting: [1, 1], evaluate: [2, .5], analysis: [3, .5], report: [4, 0], dashboard: [4, 1] };

export function buildOverviewMap(graph) {
  let extra = 5;
  const nodes = graph.overview.map((node) => {
    const [column, row] = positions[node.sourceId] || [extra++, .5];
    return { ...node, x: 32 + column * OVERVIEW_CARD.column, y: 112 + row * OVERVIEW_CARD.row,
      width: OVERVIEW_CARD.width, height: OVERVIEW_CARD.height };
  });
  return { nodes, edges: overviewRelations(graph), width: Math.max(1, extra) * OVERVIEW_CARD.column - 60 + 64,
    height: 420, total: nodes.length, overview: true,
    phases: Array.from({ length: extra }, (_, column) => ({ label: phases[column] || '관련 기능', x: 32 + column * OVERVIEW_CARD.column })),
  };
}

export function overviewCurve(from, to, index) {
  const forward = to.x > from.x, sameColumn = to.x === from.x;
  if (forward) {
    const x1 = from.x + from.width, x2 = to.x, y1 = from.y + from.height / 2, y2 = to.y + to.height / 2;
    const bend = Math.max(32, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
  }
  if (sameColumn) {
    const x = from.x + from.width, y1 = from.y + from.height / 2, y2 = to.y + to.height / 2;
    return `M${x},${y1} C${x + 34},${y1} ${x + 34},${y2} ${x},${y2}`;
  }
  // Returning/lookup links use the space above cards instead of passing
  // through every intermediate card or collecting below the entire diagram.
  const x1 = from.x + from.width / 2, x2 = to.x + to.width / 2, lane = 64 + index % 4 * 9;
  return `M${x1},${from.y} C${x1},${lane} ${x1 - 20},${lane} ${x1 - 42},${lane} L${x2 + 42},${lane} C${x2 + 20},${lane} ${x2},${lane} ${x2},${to.y}`;
}

export function overviewMapMarkup(model) {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  return `<section class="flow-overview-map flow-explorer-map" data-overview-map aria-label="전체 이용 흐름 지도">
    <div class="flow-explorer-map-tools"><p class="flow-overview-map-hint">카드에 올리면 관련 연결 · 누르면 세부 흐름</p><div role="group" aria-label="전체 지도 확대와 이동"><button type="button" data-map-zoom="out" aria-label="전체 지도 축소">−</button><output data-map-scale aria-label="전체 지도 배율">100%</output><button type="button" data-map-zoom="in" aria-label="전체 지도 확대">+</button><button type="button" data-map-fit>화면에 맞춤</button></div></div>
    <div class="flow-explorer-map-viewport" data-map-viewport tabindex="0" role="region" aria-label="전체 흐름 지도. 휠로 확대 축소, 드래그 또는 방향키로 이동"><div class="flow-explorer-map-world" data-map-world style="width:${model.width}px;height:${model.height}px">
      ${model.phases.map((phase) => `<span class="flow-overview-phase" style="left:${phase.x}px;width:${OVERVIEW_CARD.width}px">${esc(phase.label)}</span>`).join('')}
      <svg class="flow-explorer-map-wires" width="${model.width}" height="${model.height}" aria-hidden="true">${model.edges.map((edge, index) => edgeMarkup(edge, overviewCurve(nodes.get(edge.from), nodes.get(edge.to), index), index).replace('data-map-edge ', `data-map-edge data-primary="${edge.primary}" `)).join('')}</svg>
      ${model.nodes.map((node) => `<button type="button" class="flow-overview-card" data-flow-explore="${esc(node.id)}" data-map-node="${esc(node.id)}" data-summary-node="${esc(node.id)}" aria-haspopup="dialog" style="left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px"><strong>${esc(node.label)}<svg viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 10h14m-5-5 5 5-5 5"/></svg></strong><span class="flow-overview-description">${esc(node.description)}</span><span class="flow-overview-state" data-summary-status>수집된 기록 없음</span></button>`).join('')}
    </div></div><div class="flow-explorer-map-caption"><span>휠 · 확대/축소 &nbsp; 드래그 · 이동</span><span data-map-motion-label>빛은 처리 방향을 안내합니다. 인증·저장 연결은 카드에서 확인하세요.</span></div>
  </section>`;
}

export function mountOverviewMap(host, graph) {
  const root = host.querySelector('[data-overview-map]');
  if (!root) return () => {};
  const controller = mountExplorerMap(root, buildOverviewMap(graph));
  const disposeVisibility = mountMapVisibility(root);
  let hovered = null, focused = null;
  const inspect = () => {
    const selected = hovered || focused;
    root.dataset.inspect = String(Boolean(selected));
    for (const edge of root.querySelectorAll('[data-map-edge]')) edge.dataset.related = String(Boolean(selected && (edge.dataset.mapFrom === selected || edge.dataset.mapTo === selected)));
  };
  const cardId = (element) => element?.closest?.('[data-summary-node]')?.dataset.summaryNode || null;
  const over = (event) => { hovered = cardId(event.target); inspect(); };
  const out = (event) => { hovered = root.contains(event.relatedTarget) ? cardId(event.relatedTarget) : null; inspect(); };
  const focus = (event) => { focused = cardId(event.target); inspect(); };
  const blur = (event) => { focused = root.contains(event.relatedTarget) ? cardId(event.relatedTarget) : null; inspect(); };
  root.addEventListener('pointerover', over); root.addEventListener('pointerout', out);
  root.addEventListener('focusin', focus); root.addEventListener('focusout', blur);
  return () => { controller.destroy(); disposeVisibility(); root.removeEventListener('pointerover', over); root.removeEventListener('pointerout', out); root.removeEventListener('focusin', focus); root.removeEventListener('focusout', blur); };
}
