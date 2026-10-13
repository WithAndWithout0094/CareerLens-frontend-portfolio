import test from 'node:test';
import assert from 'node:assert/strict';
import { guideForRoute, placeCallouts, showPageGuide, dismissPageGuide } from '../../src/features/portfolio/page-guide.js';

const intersects = (a, b) => a.left < b.left + b.width && a.left + a.width > b.left
  && a.top < b.top + b.height && a.top + a.height > b.top;

test('desktop and mobile callouts remain inside the viewport without overlapping one another', () => {
  for (const [width, height, count] of [[1280, 800, 6], [390, 844, 4]]) {
    const items = Array.from({ length: count }, (_, index) => ({
      id: String(index), width: width < 600 ? 178 : 220, height: 95,
      anchor: { left: width < 600 ? 80 : 80 + index % 3 * 360,
        top: 100 + Math.floor(index / (width < 600 ? 1 : 3)) * 220, width: 100, height: 38 },
    }));
    const positions = placeCallouts(items, { width, height, bottom: 64 });
    assert.equal(positions.length, items.length);
    for (const [index, position] of positions.entries()) {
      assert.ok(position.left >= 12 && position.top >= 12, `${width}px: top/left bound`);
      assert.ok(position.left + position.width <= width - 12, `${width}px: right bound`);
      assert.ok(position.top + position.height <= height - 64 - 12, `${width}px: bottom controls remain clear`);
      for (const other of positions.slice(index + 1))
        assert.ok(!intersects(position, other), `${width}px: callouts ${position.id} and ${other.id} overlap`);
    }
  }
});

// Only layout dimensions and DOM notifications are synthetic. The real guide
// content, selector resolution, renderer, event handlers and cleanup run intact.
function guideDocument() {
  const children = [], targets = new Map(), observers = [], frames = new Map(), emitted = [];
  let nextFrame = 0;
  const eventTarget = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(callback);
      },
      removeEventListener(name, callback) {
        listeners.get(name)?.delete(callback);
        if (!listeners.get(name)?.size) listeners.delete(name);
      },
      fire(name, event = {}) { for (const callback of listeners.get(name) || []) callback(event); },
    };
  };
  const element = (rect = { left: 100, top: 100, width: 120, height: 38 }) => {
    const attributes = new Map();
    return { rect, style: {}, dataset: {}, hidden: false, isConnected: true,
      getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; },
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: (name) => attributes.delete(name),
      closest() { return this.hidden ? this : null; },
      focus() {},
    };
  };
  const observerClass = (type) => class {
    constructor(callback) { this.callback = callback; this.active = false; this.type = type; observers.push(this); }
    observe() { this.active = true; }
    disconnect() { this.active = false; }
  };
  const win = { ...eventTarget(), innerWidth: 1280, innerHeight: 800, visualViewport: eventTarget(),
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle: (target) => ({ display: target.hidden ? 'none' : 'block', visibility: 'visible' }),
    MutationObserver: observerClass('mutation'), ResizeObserver: observerClass('resize'),
  };
  const app = { inert: false };
  const document = { ...eventTarget(), defaultView: win, documentElement: { clientWidth: 1280 },
    activeElement: element(), getElementById: () => app,
    querySelectorAll: (selector) => targets.has(selector) ? [targets.get(selector)] : [],
    dispatchEvent(event) { emitted.push(event.type); this.fire(event.type, event); },
    body: { append: (host) => children.push(host), classList: { add() {}, remove() {} } },
    createElement() {
      const tips = new Map(), parts = new Map([
        ['.page-guide__controls', element({ left: 0, top: 0, width: 300, height: 40 })],
        ['.page-guide__lines', element()], ['.page-guide__outlines', element()],
      ]);
      const host = { ...element(), tips,
        set innerHTML(value) {
          for (const match of value.matchAll(/<aside[^>]+id="([^"]+)" data-guide-callout="([^"]+)"/g)) {
            const tip = { ...element({ left: 0, top: 0, width: 220, height: 90 }), id: match[1], dataset: { guideCallout: match[2] } };
            tips.set(match[2], tip);
          }
        },
        querySelectorAll: () => [...tips.values()], querySelector: (selector) => parts.get(selector),
        contains: (target) => target === host || [...tips.values(), ...parts.values()].includes(target),
        remove() { children.splice(children.indexOf(host), 1); this.isConnected = false; },
      };
      return host;
    },
  };
  return { document, win, app, children, frames, observers, emitted,
    anchor(item, rect) { const previous = targets.get(item.targets[0]); if (previous) previous.isConnected = false;
      const target = element(rect); targets.set(item.targets[0], target); return target; },
    removeAnchor(item) { const target = targets.get(item.targets[0]); if (target) target.isConnected = false; targets.delete(item.targets[0]); },
    mutate() { for (const observer of observers) if (observer.active && observer.type === 'mutation') observer.callback([{ target: app }]); },
    flush() { const queued = [...frames.values()]; frames.clear(); queued.forEach((callback) => callback()); },
    fire(name, extra = {}) {
      const event = { ...extra, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
      document.fire(name, event); return event;
    },
  };
}

const resumeItems = () => guideForRoute('resume', { session: { user: null } }).items;

test('only present visible anchors receive callouts and existing accessibility descriptions survive cleanup', () => {
  const ui = guideDocument(), items = resumeItems();
  const upload = items.find((item) => item.id === 'upload');
  const anchor = ui.anchor(upload);
  anchor.setAttribute('aria-describedby', 'existing-help');
  const offscreen = ui.anchor(items.find((item) => item.id === 'continue'), { left: 100, top: 1000, width: 120, height: 40 });
  try {
    showPageGuide('resume', { document: ui.document, force: true });
    const shown = [...ui.children[0].tips].filter(([, tip]) => !tip.hidden).map(([id]) => id);
    assert.deepEqual(shown, ['upload']);
    assert.match(anchor.getAttribute('aria-describedby'), /^existing-help page-guide-tip-/);
    assert.equal(offscreen.getAttribute('aria-describedby'), null);
    assert.equal(ui.app.inert, false, 'the page remains scrollable and inspectable');
  } finally { dismissPageGuide(); }
  assert.equal(anchor.getAttribute('aria-describedby'), 'existing-help');
});

test('scroll and asynchronous DOM replacement re-resolve the current anchor and remove detached associations', () => {
  const ui = guideDocument(), item = resumeItems().find((item) => item.id === 'upload');
  const original = ui.anchor(item);
  try {
    showPageGuide('resume', { document: ui.document, force: true });
    const tip = ui.children[0].tips.get(item.id), before = tip.style.top;
    original.rect.top = 350;
    ui.fire('scroll'); ui.flush();
    assert.notEqual(tip.style.top, before);
    const replacement = ui.anchor(item, { left: 700, top: 150, width: 160, height: 40 });
    ui.mutate(); ui.flush();
    assert.equal(original.getAttribute('aria-describedby'), null);
    assert.match(replacement.getAttribute('aria-describedby'), /page-guide-tip-/);
    assert.ok(Number.parseFloat(tip.style.left) > 500);
    ui.removeAnchor(item); ui.mutate(); ui.flush();
    assert.equal(tip.hidden, true, 'no detached control retains a floating callout');
    assert.equal(replacement.getAttribute('aria-describedby'), null);
    const loaded = ui.anchor(item, { left: 200, top: 200, width: 120, height: 40 });
    ui.mutate(); ui.flush();
    assert.equal(tip.hidden, false, 'a control arriving after its loading placeholder gets its hint');
    assert.match(loaded.getAttribute('aria-describedby'), /page-guide-tip-/);
    loaded.rect.top = 400;
    const previousTop = tip.style.top;
    ui.win.fire('resize'); ui.flush();
    assert.notEqual(tip.style.top, previousTop);
  } finally { dismissPageGuide(); }
});

test('click and Escape close every hint, consume that action, clean listeners and allow guidance on page re-entry', () => {
  const ui = guideDocument();
  ui.anchor(resumeItems().find((item) => item.id === 'upload'));
  showPageGuide('resume', { document: ui.document, force: true });
  ui.fire('scroll');
  const click = ui.fire('click');
  assert.ok(click.defaultPrevented && click.stopped, 'the dismissal click cannot activate an underlying link');
  assert.equal(ui.children.length, 0);
  assert.equal(ui.frames.size, 0);
  assert.equal(ui.document.listeners.size + ui.win.listeners.size + ui.win.visualViewport.listeners.size, 0);
  assert.ok(ui.observers.every((observer) => !observer.active));
  assert.deepEqual(ui.emitted, ['careerlens:guide-open', 'careerlens:guide-dismiss']);
  showPageGuide('resume', { document: ui.document });
  assert.equal(ui.children.length, 0, 'same-page data refresh must not reopen dismissed hints');
  showPageGuide('desired-role', { document: ui.document });
  assert.equal(ui.children.length, 1);
  const escape = ui.fire('keydown', { key: 'Escape' });
  assert.ok(escape.defaultPrevented && escape.stopped);
  assert.equal(ui.children.length, 0);
  showPageGuide('resume', { document: ui.document });
  assert.equal(ui.children.length, 1, 'navigating back to a page shows its guidance again');
  dismissPageGuide();
  assert.equal(ui.document.listeners.size + ui.win.listeners.size + ui.win.visualViewport.listeners.size, 0);
});
