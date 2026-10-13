import test from 'node:test';
import assert from 'node:assert/strict';
import { executionReportsPanel, renderExecutionReport, mountExecutionReports } from '../../src/features/admin/execution-reports.js';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const row = (run_id) => ({ run_id, filename: `${run_id}.md` });
function harness(api, options) {
  const list = { innerHTML: '' }, content = { innerHTML: '' }, status = { textContent: '' }, load = {};
  const nodes = { '[data-execution-list]': list, '[data-execution-content]': content, '[data-execution-status]': status, '[data-execution-load]': load };
  let listener;
  const host = { querySelector: (key) => nodes[key], addEventListener: (_, fn) => { listener = fn; }, removeEventListener: () => { listener = undefined; } };
  const cleanup = mountExecutionReports({ querySelector: () => host }, api, options);
  const click = (selector, executionOpen) => listener?.({ target: { closest: (key) => key === selector ? { dataset: { executionOpen } } : null } });
  return { list, content, status, load, click, cleanup };
}

test('execution report panel is explicit and markdown cannot inject HTML', () => {
  assert.match(executionReportsPanel(), /보고서 목록 불러오기/);
  const html = renderExecutionReport({ ...row(first), markdown: '# Recorded\n<script>alert(1)</script>\n\n```json\n{"value":"<img onerror=x>"}\n```' });
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<pre><code>/);
});

test('list loads automatically and each selected run opens its own report', async () => {
  const calls = [];
  const h = harness(async (path) => {
    calls.push(path);
    if (path.includes('?')) return { reports: [{ ...row(first), modified_at: '2026-10-13T02:42:45+00:00' }, row(second)], has_more: false };
    const id = path.split('/').pop();
    return { report: { ...row(id), markdown: `# Stored ${id}` } };
  });
  assert.deepEqual(calls, ['/admin/execution-reports?limit=50&offset=0']);
  await tick();
  assert.match(h.list.innerHTML, new RegExp(first));
  assert.match(h.list.innerHTML, /11:42 KST/);
  h.click('[data-execution-open]', second); await tick();
  assert.match(h.content.innerHTML, new RegExp(`Stored ${second}`));
  assert.equal(calls[1], `/admin/execution-reports/${second}`);
  h.cleanup();
  assert.equal(h.content.innerHTML, '');
});

test('late response cannot replace a newly selected report', async () => {
  let finishFirst;
  const h = harness(async (path) => {
    if (path.includes('?')) return { reports: [row(first), row(second)] };
    if (path.endsWith(first)) return new Promise((resolve) => { finishFirst = resolve; });
    return { report: { ...row(second), markdown: '# Second report' } };
  });
  await tick();
  h.click('[data-execution-open]', first); await tick();
  h.click('[data-execution-open]', second); await tick();
  finishFirst({ report: { ...row(first), markdown: '# Old report' } }); await tick();
  assert.match(h.content.innerHTML, /Second report/);
  assert.doesNotMatch(h.content.innerHTML, /Old report/);
  h.cleanup();
});

test('empty page can advance past runs without report files', async () => {
  const calls = [];
  const h = harness(async (path) => {
    calls.push(path);
    return path.endsWith('offset=0') ? { reports: [], has_more: true, next_offset: 50 }
      : { reports: [row(first)], has_more: false };
  });
  await tick();
  assert.match(h.list.innerHTML, /다음 기록 확인/);
  h.click('[data-execution-more]'); await tick();
  assert.match(calls[1], /offset=50$/);
  assert.match(h.list.innerHTML, new RegExp(first));
  h.cleanup();
});

test('mismatched report identity and unknown row are never rendered', async () => {
  let calls = 0;
  const h = harness(async (path) => {
    calls++;
    return path.includes('?') ? { reports: [row(first)] } : { report: { ...row(second), markdown: '# Wrong account' } };
  });
  await tick();
  h.click('[data-execution-open]', second); await tick();
  assert.equal(calls, 1);
  h.click('[data-execution-open]', first); await tick();
  assert.doesNotMatch(h.content.innerHTML, /Wrong account/);
  assert.match(h.content.innerHTML, /불러오지 못했습니다/);
  h.cleanup();
});

test('report list refreshes every five seconds only while visible and removes timers on exit', async () => {
  let timer, interval, count = 0, cleared = false;
  const handlers = new Map();
  const window = {
    document: { visibilityState: 'visible', addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name) },
    setInterval: (fn, delay) => { timer = fn; interval = delay; return 1; },
    clearInterval: () => { cleared = true; },
    addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name),
  };
  const h = harness(async () => { count++; return { reports: count === 1 ? [] : [row(first)] }; }, { window });
  await tick();
  assert.equal(interval, 5000);
  timer(); await tick();
  assert.equal(count, 2);
  assert.match(h.list.innerHTML, new RegExp(first));
  window.document.visibilityState = 'hidden';
  timer(); await tick();
  assert.equal(count, 2);
  window.document.visibilityState = 'visible';
  handlers.get('visibilitychange')(); await tick();
  assert.equal(count, 3);
  h.cleanup(); timer(); await tick();
  assert.equal(count, 3);
  assert.equal(cleared, true);
  assert.equal(handlers.size, 0);
});
