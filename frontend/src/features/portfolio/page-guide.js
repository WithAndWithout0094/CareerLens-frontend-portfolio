import { escapeHtml as e } from '../../shared/components/ui.js';
import { guideForRoute } from './guide-content.js';
export { guideForRoute } from './guide-content.js';

const GAP = 12;
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
const overlap = (a, b) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left))
  * Math.max(0, Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top));

/** Keep individual hints near their controls without stacking on each other. */
export function placeCallouts(items, { width, height, bottom = 64 }) {
  const placed = [];
  for (const item of items) {
    const a = item.anchor;
    const w = Math.min(item.width, width - GAP * 2), h = item.height;
    const centers = {
      bottom: [a.left + a.width / 2 - w / 2, a.top + a.height + GAP],
      top: [a.left + a.width / 2 - w / 2, a.top - h - GAP],
      right: [a.left + a.width + GAP, a.top + a.height / 2 - h / 2],
      left: [a.left - w - GAP, a.top + a.height / 2 - h / 2],
    };
    const sides = [...new Set([item.placement || 'bottom', 'bottom', 'top', 'right', 'left'])];
    const scoreBox = (x, y, rank = 0) => {
      const box = { left: clamp(x, GAP, width - GAP - w), top: clamp(y, GAP, height - bottom - GAP - h), width: w, height: h };
      const collisions = placed.reduce((sum, other) => sum + overlap(box, { left: other.left - 5, top: other.top - 5, width: other.width + 10, height: other.height + 10 }), 0);
      const coversControls = items.reduce((sum, other) => sum + overlap(box, other.anchor), 0);
      const distance = Math.hypot(box.left + w / 2 - (a.left + a.width / 2), box.top + h / 2 - (a.top + a.height / 2));
      return { ...box, score: collisions * 100 + coversControls * .3 + distance + rank * 8 };
    };
    const candidates = sides.flatMap((side, rank) => {
      const [x, y] = centers[side];
      return [0, -(h + GAP), h + GAP, -2 * (h + GAP), 2 * (h + GAP)].map((offset) => scoreBox(x, y + offset, rank));
    });
    // Dense headers and narrow screens need more than the four immediate sides.
    const rows = [GAP, height - bottom - GAP - h, ...placed.flatMap((box) => [box.top - h - GAP, box.top + box.height + GAP])];
    for (let y = GAP; y < height - bottom - h; y += h + GAP) rows.push(y);
    for (const x of [GAP, (width - w) / 2, width - GAP - w]) for (const y of rows) candidates.push(scoreBox(x, y, 4));
    const chosen = candidates.sort((a, b) => a.score - b.score)[0];
    placed.push({ id: item.id, ...chosen });
  }
  return placed;
}

let previousRoute;
let disposeGuide;

export function showPageGuide(route, { session, section, force = false, document: doc = globalThis.document } = {}) {
  if (!doc?.body) return () => {};
  const key = route + ':' + (session?.user ? 'member' : 'guest') + ':' + (section || '');
  if (!force && key === previousRoute) return disposeGuide || (() => {});
  disposeGuide?.();
  previousRoute = key;
  const guide = guideForRoute(route, { session, section });
  const win = doc.defaultView || globalThis.window;
  const host = doc.createElement('div');
  host.className = 'page-guide';
  host.dataset.pageGuide = route;
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', guide.title + ' 기능별 안내');
  host.innerHTML = '<svg class="page-guide__lines" aria-hidden="true"></svg><div class="page-guide__outlines" aria-hidden="true"></div>'
    + guide.items.map((item, index) => '<aside class="page-guide__callout" role="note" id="page-guide-tip-' + index + '" data-guide-callout="' + e(item.id)
      + '" hidden><strong>' + e(item.label) + '</strong><p>' + e(item.text) + '</p></aside>').join('')
    + '<div class="page-guide__controls"><span>기능별 안내 · 화면 클릭 또는 Esc로 닫기</span><button type="button" class="page-guide__close" aria-label="페이지 기능 안내 닫기">모두 닫기</button></div>';
  doc.body.append(host);
  doc.body.classList.add('page-guide-open');
  const tips = new Map([...host.querySelectorAll('[data-guide-callout]')].map((node) => [node.dataset.guideCallout, node]));
  const linked = new Map();
  let closed = false, frame = 0;
  const previousFocus = doc.activeElement;

  function unlink() {
    for (const [target, id] of linked) {
      const remaining = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter((value) => value && value !== id);
      if (remaining.length) target.setAttribute('aria-describedby', remaining.join(' '));
      else target.removeAttribute('aria-describedby');
    }
    linked.clear();
  }
  function anchorFor(item) {
    for (const selector of item.targets) {
      for (const target of doc.querySelectorAll(selector)) {
        if (host.contains(target) || target.closest('[hidden], [inert]')) continue;
        const rect = target.getBoundingClientRect();
        const style = win.getComputedStyle(target);
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') return { target, rect };
      }
    }
    return null;
  }
  function layout() {
    frame = 0;
    if (closed) return;
    const width = doc.documentElement.clientWidth || win.innerWidth, height = win.innerHeight;
    const bottom = host.querySelector('.page-guide__controls').getBoundingClientRect().height + 24;
    unlink();
    const visible = [], used = new Set();
    for (const item of guide.items) {
      const tip = tips.get(item.id), found = anchorFor(item);
      tip.hidden = true;
      if (!found || used.has(found.target)) continue;
      const { target, rect } = found;
      if (rect.bottom <= 0 || rect.top >= height || rect.right <= 0 || rect.left >= width) continue;
      used.add(target);
      const anchor = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        width: Math.min(width, rect.right) - Math.max(0, rect.left),
        height: Math.min(height, rect.bottom) - Math.max(0, rect.top) };
      tip.hidden = false;
      tip.style.width = Math.min(width < 600 ? Math.min(178, (width - 36) / 2) : 220, width - GAP * 2) + 'px';
      const size = tip.getBoundingClientRect();
      visible.push({ ...item, target, anchor, width: size.width, height: size.height });
      const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      target.setAttribute('aria-describedby', [...new Set([...descriptions, tip.id])].join(' '));
      linked.set(target, tip.id);
    }
    const positions = placeCallouts(visible, { width, height, bottom });
    const paths = [], outlines = [];
    for (const position of positions) {
      const item = visible.find((entry) => entry.id === position.id), tip = tips.get(item.id), a = item.anchor;
      tip.style.left = position.left + 'px';
      tip.style.top = position.top + 'px';
      const cx = position.left + position.width / 2, cy = position.top + position.height / 2;
      const ax = clamp(cx, a.left, a.left + a.width), ay = clamp(cy, a.top, a.top + a.height);
      const tx = clamp(ax, position.left + 8, position.left + position.width - 8);
      const ty = clamp(ay, position.top + 8, position.top + position.height - 8);
      paths.push('<path d="M ' + ax + ' ' + ay + ' L ' + tx + ' ' + ty + '"/><circle cx="' + ax + '" cy="' + ay + '" r="3"/>');
      outlines.push('<span style="left:' + a.left + 'px;top:' + a.top + 'px;width:' + a.width + 'px;height:' + a.height + 'px"></span>');
    }
    host.querySelector('.page-guide__lines').innerHTML = paths.join('');
    host.querySelector('.page-guide__outlines').innerHTML = outlines.join('');
  }
  function schedule() {
    if (!closed && !frame) frame = win.requestAnimationFrame(layout);
  }
  const observer = typeof win.MutationObserver === 'function' ? new win.MutationObserver((changes) => {
    if (changes.some((change) => !host.contains(change.target) && change.target !== host)) schedule();
  }) : null;
  // Async responses can replace the entire page while its guide remains open.
  observer?.observe(doc.getElementById('app') || doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open'] });
  const resized = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(schedule) : null;
  resized?.observe(doc.getElementById('app') || doc.body);
  function close() {
    if (closed) return;
    closed = true;
    observer?.disconnect();
    resized?.disconnect();
    if (frame) win.cancelAnimationFrame(frame);
    doc.removeEventListener('click', clicked, true);
    doc.removeEventListener('keydown', keydown, true);
    doc.removeEventListener('scroll', schedule, true);
    win.removeEventListener('resize', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
    unlink();
    const restoreFocus = host.contains(doc.activeElement);
    host.remove();
    doc.body.classList.remove('page-guide-open');
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    doc.dispatchEvent(new CustomEvent('careerlens:guide-dismiss'));
  }
  function clicked(event) { event.preventDefault(); event.stopPropagation(); close(); }
  function keydown(event) {
    if (['Escape', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(); }
  }
  doc.addEventListener('click', clicked, true);
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('scroll', schedule, true);
  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  doc.dispatchEvent(new CustomEvent('careerlens:guide-open'));
  layout();
  doc.fonts?.ready.then(schedule);
  disposeGuide = close;
  return close;
}

export function dismissPageGuide() { disposeGuide?.(); }
