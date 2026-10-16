import { overviewConnections } from './explorer-model.js';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const MAP_LIMITS = Object.freeze({ min: 0.22, max: 2 });
export const MAP_CARD = Object.freeze({ width: 228, height: 108, column: 340, row: 138 });
const composition = (kind) => ['contains', 'containment', 'schema', 'field', 'group'].includes(kind);
const relationNames = { flow: '처리 순서', conditional: '조건 분기', calls: '함수 호출', contains: '하위 구성', produces: '응답 구조', group: '요약 구성', projected: '요약 간 코드 연결' };

// The canvas never invents a sequential chain. Every solid edge comes from a
// manifest edge, or an explicitly labelled projection between overview groups.
export function buildExplorerMap(graph, id, { expanded = false } = {}) {
  const selected = graph.node(id), context = graph.context(id);
  if (!selected) return { nodes: [], edges: [], width: 0, height: 0, total: 0 };
  let ids, edges, ranks = new Map([[id, 0]]);
  if (selected.kind === 'overview') {
    const connections = overviewConnections(graph);
    const adjacent = new Set([id, ...connections.filter(([from, to]) => from === id || to === id).flat()]);
    const summaries = graph.overview.map((entry) => entry.id).filter((key) => expanded || adjacent.has(key));
    const roots = graph.children(id);
    const primary = roots.filter((key) => !['api', 'function', 'schema', 'field', 'storage'].includes(graph.node(key)?.kind));
    const domains = roots.filter((key) => graph.node(key)?.kind === 'domain');
    const children = expanded ? selected.members : (domains.length ? domains : primary.length ? primary : roots).slice(0, 6);
    ids = new Set([...summaries, ...children]);
    edges = connections.filter(([from, to]) => ids.has(from) && ids.has(to)).map(([from, to]) => ({ from, to, kind: 'projected' }));
    edges.push(...children.filter((key) => !children.includes(graph.parent(key))).map((key) => ({ from: id, to: key, kind: 'group' })));
    edges.push(...graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)));
    const order = graph.overview.findIndex((entry) => entry.id === id);
    summaries.forEach((key) => { const index = graph.overview.findIndex((entry) => entry.id === key); ranks.set(key, index < order ? index - order : index === order ? 0 : index - order + 2); });
    children.forEach((key) => ranks.set(key, 1));
    // Descendants of a visible component get their own later column.
    for (let depth = 0; depth < 4; depth++) for (const key of children) {
      const parent = graph.parent(key);
      if (children.includes(parent)) ranks.set(key, Math.min(5, (ranks.get(parent) || 1) + 1));
    }
  } else {
    ids = new Set([id, ...context.predecessors, ...context.successors, ...context.children, ...context.ancestry]);
    const pathToBoundary = (reverse) => {
      const queue = [[id]], seen = new Set([id]);
      while (queue.length) {
        const path = queue.shift(), tail = path.at(-1);
        const next = graph.links.filter((edge) => (reverse ? edge.to : edge.from) === tail).map((edge) => reverse ? edge.from : edge.to);
        if (!next.length) { path.forEach((key) => ids.add(key)); return; }
        for (const key of next) if (!seen.has(key)) { seen.add(key); queue.push([...path, key]); }
      }
    };
    pathToBoundary(true); pathToBoundary(false);
    if (expanded) {
      [...context.before, ...context.after].forEach((key) => ids.add(key));
      const queue = [...ids];
      while (queue.length) for (const child of graph.children(queue.shift())) if (!ids.has(child)) { ids.add(child); queue.push(child); }
    }
    edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const visit = (reverse) => {
      const queue = [[id, 0]], seen = new Set([id]);
      while (queue.length) {
        const [key, level] = queue.shift();
        for (const edge of edges) {
          if ((reverse ? edge.to : edge.from) !== key) continue;
          const next = reverse ? edge.from : edge.to;
          if (seen.has(next) || next === id) continue;
          seen.add(next);
          if (!ranks.has(next)) ranks.set(next, level + (reverse ? -1 : 1));
          queue.push([next, ranks.get(next)]);
        }
      }
    };
    visit(true); visit(false);
    context.ancestry.forEach((key, index) => { if (!ranks.has(key)) ranks.set(key, -index - 1); });
    for (const key of ids) if (!ranks.has(key)) ranks.set(key, 1);
  }
  const columns = [...new Set([...ids].map((key) => ranks.get(key) || 0))].sort((a, b) => a - b);
  const rows = new Map(columns.map((rank) => [rank, []]));
  for (const key of ids) rows.get(ranks.get(key) || 0).push(key);
  const maxRows = Math.max(...[...rows.values()].map((values) => values.length), 1);
  const height = maxRows * MAP_CARD.row + 80;
  const nodes = columns.flatMap((rank, column) => rows.get(rank).map((key, row) => ({
    ...graph.node(key), x: 36 + column * MAP_CARD.column,
    y: 40 + (maxRows - rows.get(rank).length) * MAP_CARD.row / 2 + row * MAP_CARD.row,
    selected: key === id,
  })));
  const total = selected.kind === 'overview' ? graph.overview.length + selected.members.length : new Set([id, ...context.before, ...context.after, ...context.children, ...context.ancestry]).size;
  return { nodes, edges, width: columns.length * MAP_CARD.column - (MAP_CARD.column - MAP_CARD.width) + 72, height, total: Math.max(total, nodes.length) };
}

export function curveBetween(from, to, index = 0) {
  const forward = to.x > from.x, same = Math.abs(to.x - from.x) < 1;
  const x1 = from.x + (forward || same ? MAP_CARD.width : 0), y1 = from.y + MAP_CARD.height / 2;
  const x2 = to.x + (forward ? 0 : MAP_CARD.width), y2 = to.y + MAP_CARD.height / 2;
  if (same) { const bend = x1 + 32 + index % 3 * 12; return `M${x1},${y1} C${bend},${y1} ${bend},${y2} ${x2},${y2}`; }
  const bend = Math.max(48, Math.abs(x2 - x1) * .48) * (forward ? 1 : -1);
  return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
}

export function edgeMarkup(edge, path, index = 0) {
  const type = composition(edge.kind) ? 'composition' : edge.kind === 'conditional' ? 'branch' : 'flow';
  return `<g class="flow-map-edge" data-map-edge data-map-from="${esc(edge.from)}" data-map-to="${esc(edge.to)}" data-map-kind="${esc(edge.kind)}" data-edge-type="${type}"><title>${esc(relationNames[edge.kind] || edge.kind)}</title><path class="flow-map-edge-glow" d="${path}"/><path class="flow-map-edge-line" d="${path}"/><path class="flow-map-edge-arrow" d="M-5 -4 0 0-5 4" style="offset-path:path('${path}');offset-distance:72%;offset-rotate:auto"/>${[0, 1].map((n) => `<circle class="flow-map-spark" r="${n ? 1.8 : 2.8}" style="offset-path:path('${path}');--spark-delay:${-(index % 7) * .29 - n * 1.9}s"/>`).join('')}</g>`;
}

export function explorerMapMarkup(model) {
  const nodes = new Map(model.nodes.map((node) => [node.id, node]));
  return `<section class="flow-explorer-map" data-explorer-map aria-label="선택 기능의 코드 연결 지도">
    <div class="flow-explorer-map-tools"><div class="flow-map-legend"><span>실선 · 처리/호출</span><span>점선 · 하위 구성</span><span>황색 · 조건 분기</span></div><div role="group" aria-label="지도 확대와 이동"><button type="button" data-map-zoom="out" aria-label="지도 축소">−</button><output data-map-scale aria-label="지도 배율">100%</output><button type="button" data-map-zoom="in" aria-label="지도 확대">+</button><button type="button" data-map-fit>화면에 맞춤</button></div></div>
    <div class="flow-explorer-map-viewport" data-map-viewport tabindex="0" role="region" aria-label="가로 흐름 지도. 휠로 확대 축소, 드래그 또는 방향키로 이동, 더하기 빼기로 배율 조절, Home으로 맞춤"><div class="flow-explorer-map-world" data-map-world style="width:${model.width}px;height:${model.height}px"><svg class="flow-explorer-map-wires" width="${model.width}" height="${model.height}" aria-hidden="true">${model.edges.map((edge, index) => edgeMarkup(edge, curveBetween(nodes.get(edge.from), nodes.get(edge.to), index), index)).join('')}</svg>${model.nodes.map((node) => `<button type="button" class="flow-map-card" data-explore-node="${esc(node.id)}" data-map-node="${esc(node.id)}" ${node.selected ? 'aria-current="step"' : ''} style="left:${node.x}px;top:${node.y}px;width:${MAP_CARD.width}px;min-height:${MAP_CARD.height}px"><span class="flow-map-card-kind">${node.selected ? '현재 선택' : node.kind === 'overview' ? '요약 단계' : node.kind === 'boundary' ? '시작·종료' : '연결된 기능'}</span><strong>${esc(node.label)}</strong><span>${esc(node.description || relationNames[node.kind] || '카드를 눌러 더 자세히 보기')}</span></button>`).join('')}</div></div>
    <div class="flow-explorer-map-caption"><span>휠 · 확대/축소 &nbsp; 드래그 · 이동</span><span data-map-motion-label>빛의 이동은 코드 연결 방향 안내입니다. 실제 실행 기록이 아닙니다.</span></div>
  </section>`;
}

export function zoomMapAt(view, point, factor) {
  const scale = Math.max(MAP_LIMITS.min, Math.min(MAP_LIMITS.max, view.scale * factor));
  return { scale, x: point.x - (point.x - view.x) * scale / view.scale, y: point.y - (point.y - view.y) * scale / view.scale };
}

export function mountExplorerMap(root, model, { initialView = null, onView = () => {} } = {}) {
  const viewport = root.querySelector('[data-map-viewport]'), world = root.querySelector('[data-map-world]');
  const doc = root.ownerDocument, win = doc.defaultView;
  let view = initialView && { ...initialView }, drag = null, dragged = false, disposed = false;
  function apply() {
    if (!view || disposed) return;
    world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    root.querySelector('[data-map-scale]').textContent = `${Math.round(view.scale * 100)}%`;
    onView({ ...view });
  }
  function fit(initial = false) {
    if (!viewport.clientWidth || !viewport.clientHeight) return;
    const scale = Math.max(MAP_LIMITS.min, Math.min(1, (viewport.clientWidth - 40) / model.width, (viewport.clientHeight - 40) / model.height));
    const focus = model.nodes.find((node) => node.selected);
    view = initial && scale < .55 && focus
      ? { scale: .7, x: viewport.clientWidth / 2 - (focus.x + MAP_CARD.width / 2) * .7, y: viewport.clientHeight / 2 - (focus.y + MAP_CARD.height / 2) * .7 }
      : { scale, x: (viewport.clientWidth - model.width * scale) / 2, y: (viewport.clientHeight - model.height * scale) / 2 }; apply();
  }
  function zoom(factor, point = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }) { if (!view) fit(); view = zoomMapAt(view, point, factor); apply(); }
  const wheel = (event) => { if (!event.deltaY) return; event.preventDefault(); const box = viewport.getBoundingClientRect(); zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .0025), { x: event.clientX - box.left, y: event.clientY - box.top }); };
  const down = (event) => { if (event.button !== 0 || !view) return; drag = { id: event.pointerId, x: event.clientX, y: event.clientY, original: { ...view } }; dragged = false; };
  const move = (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const x = event.clientX - drag.x, y = event.clientY - drag.y;
    if (!dragged && Math.hypot(x, y) < 5) return;
    dragged = true; viewport.setPointerCapture(event.pointerId); viewport.dataset.dragging = 'true';
    view = { ...view, x: drag.original.x + x, y: drag.original.y + y }; apply();
  };
  const up = (event) => { if (drag?.id !== event.pointerId) return; if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); drag = null; if (event.type === 'pointercancel') dragged = false; delete viewport.dataset.dragging; };
  const preventDragClick = (event) => { if (dragged) { event.preventDefault(); event.stopPropagation(); dragged = false; } };
  const click = (event) => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.hasAttribute('data-map-fit')) fit();
    else if (button.dataset.mapZoom) zoom(button.dataset.mapZoom === 'in' ? 1.2 : 1 / 1.2);
  };
  const keydown = (event) => {
    if (event.target !== viewport) return;
    if (['+', '=', '-', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.2);
    else if (event.key === '-') zoom(1 / 1.2);
    else if (event.key === 'Home') fit();
    else if (event.key.startsWith('Arrow') && view) { const distance = event.shiftKey ? 120 : 40; view = { ...view, x: view.x + (event.key === 'ArrowLeft' ? distance : event.key === 'ArrowRight' ? -distance : 0), y: view.y + (event.key === 'ArrowUp' ? distance : event.key === 'ArrowDown' ? -distance : 0) }; apply(); }
  };
  // Tab focus brings an off-canvas button into the viewport without scrolling
  // the surrounding page, and leaves the keyboard user at a readable scale.
  const focusin = (event) => {
    const card = event.target.closest('[data-map-node]'); if (!card || !view) return;
    const node = model.nodes.find((entry) => entry.id === card.dataset.mapNode), box = viewport.getBoundingClientRect(), bounds = card.getBoundingClientRect();
    if (bounds.left < box.left || bounds.right > box.right || bounds.top < box.top || bounds.bottom > box.bottom) {
      view = { ...view, x: viewport.clientWidth / 2 - (node.x + MAP_CARD.width / 2) * view.scale, y: viewport.clientHeight / 2 - (node.y + MAP_CARD.height / 2) * view.scale }; apply();
    }
  };
  viewport.addEventListener('wheel', wheel, { passive: false }); viewport.addEventListener('pointerdown', down); viewport.addEventListener('pointermove', move); viewport.addEventListener('pointerup', up); viewport.addEventListener('pointercancel', up); viewport.addEventListener('click', preventDragClick, true); viewport.addEventListener('keydown', keydown); viewport.addEventListener('focusin', focusin); root.addEventListener('click', click);
  const observer = win.ResizeObserver ? new win.ResizeObserver(() => { if (!view) fit(true); }) : null; observer?.observe(viewport);
  if (view) apply(); else fit(true);
  return {
    snapshot: () => view && { ...view },
    anchor: () => { const node = model.nodes.find((entry) => entry.selected); return node ? { x: node.x + MAP_CARD.width / 2, y: node.y + MAP_CARD.height / 2 } : null; },
    setPlayback(state) {
      root.dataset.playback = state.status;
      root.querySelector('[data-map-motion-label]').textContent = state.status === 'playing' ? '가상 시연 · 입력 → 선택 기능 → 출력 관계를 강조합니다.' : state.status === 'paused' ? '가상 시연 일시정지 · 현재 단계 유지' : '빛의 이동은 코드 연결 방향 안내입니다. 실제 실행 기록이 아닙니다.';
      for (const edge of root.querySelectorAll('[data-map-edge]')) {
        const incoming = edge.dataset.mapTo === state.nodeId, outgoing = edge.dataset.mapFrom === state.nodeId;
        edge.dataset.active = String(state.status !== 'idle' && (state.index === 0 ? incoming : state.index === 1 ? incoming || outgoing : outgoing));
      }
    },
    destroy() { disposed = true; observer?.disconnect(); viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('pointerdown', down); viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', up); viewport.removeEventListener('pointercancel', up); viewport.removeEventListener('click', preventDragClick, true); viewport.removeEventListener('keydown', keydown); viewport.removeEventListener('focusin', focusin); root.removeEventListener('click', click); },
  };
}

// CSS owns the particles; observers only pause offscreen/hidden surfaces.
export function mountMapVisibility(root) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const query = win.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;
  const update = () => { root.dataset.motionPaused = String(doc.hidden || !visible || query.matches || doc.body.dataset.flowMotionPaused === 'true'); };
  const intersection = win.IntersectionObserver ? new win.IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); }) : null;
  const mutation = new win.MutationObserver(update);
  intersection?.observe(root); mutation.observe(doc.body, { attributes: true, attributeFilter: ['data-flow-motion-paused'] });
  doc.addEventListener('visibilitychange', update); query.addEventListener?.('change', update); update();
  return () => { intersection?.disconnect(); mutation.disconnect(); doc.removeEventListener('visibilitychange', update); query.removeEventListener?.('change', update); };
}

export function mountOverviewWires(root, graph) {
  const stages = root.querySelector('.flow-overview-stages');
  if (!stages) return () => {};
  const doc = root.ownerDocument, win = doc.defaultView, svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('flow-overview-wires'); svg.setAttribute('aria-hidden', 'true'); stages.prepend(svg);
  function measure() {
    const area = stages.getBoundingClientRect(); if (!area.width) return;
    svg.setAttribute('width', area.width); svg.setAttribute('height', area.height);
    const boxes = new Map([...stages.querySelectorAll('[data-summary-node]')].map((card) => { const box = card.getBoundingClientRect(); return [card.dataset.summaryNode, { x: box.left - area.left, y: box.top - area.top, width: box.width, height: box.height }]; }));
    svg.innerHTML = overviewConnections(graph).map(([from, to], index) => {
      const a = boxes.get(from), b = boxes.get(to); if (!a || !b) return '';
      const x1 = a.x + a.width / 2, x2 = b.x + b.width / 2, y1 = a.y + a.height, y2 = b.y + b.height;
      const lane = Math.max(y1, y2) + 20 + index % 4 * 9;
      return edgeMarkup({ from, to, kind: 'projected' }, `M${x1},${y1} C${x1},${lane} ${x2},${lane} ${x2},${y2}`, index);
    }).join('');
  }
  const observer = win.ResizeObserver ? new win.ResizeObserver(measure) : null;
  observer?.observe(stages); win.addEventListener('resize', measure, { passive: true });
  const disposeVisibility = mountMapVisibility(stages); measure();
  return () => { observer?.disconnect(); win.removeEventListener('resize', measure); disposeVisibility(); svg.remove(); };
}
