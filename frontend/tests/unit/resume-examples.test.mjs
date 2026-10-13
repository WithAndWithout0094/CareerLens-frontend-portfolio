import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { bindResumeExamples, filterResumeExamples, stopResumeExamples } from '../../src/features/resumes/examples.js';

const examples = Object.freeze([
  Object.freeze({
    id: 'frontend',
    title: '웹 서비스 지원자',
    role: '프론트엔드 개발',
    experience_level: '신입',
    summary: '접근성 개선 프로젝트를 진행했습니다.',
    skills: Object.freeze(['TypeScript', 'React']),
  }),
  Object.freeze({
    id: 'accounting',
    title: '재무 지원자',
    role: '회계 담당자',
    experience_level: '경력 3년',
    summary: '월별 결산과 Excel 보고서를 작성했습니다.',
    skills: Object.freeze(['회계', 'Excel']),
  }),
  Object.freeze({ id: 'minimal', title: '기본 이력서', role: '운영' }),
]);

test('resume search combines terms across role, summary and skills regardless of case', () => {
  assert.deepEqual(
    filterResumeExamples(examples, '  프론트엔드\t react  접근성 ').map((item) => item.id),
    ['frontend'],
  );
  assert.deepEqual(filterResumeExamples(examples, '회계 REACT'), []);
});

test('experience search includes the advertised experience-level field', () => {
  assert.deepEqual(
    filterResumeExamples(examples, '경력 3년').map((item) => item.id),
    ['accounting'],
  );
  assert.deepEqual(
    filterResumeExamples(examples, '신입').map((item) => item.id),
    ['frontend'],
  );
});

test('empty searches preserve catalog order and tolerate omitted optional fields', () => {
  assert.deepEqual(filterResumeExamples(examples, ' \t\n '), examples);
  assert.deepEqual(
    filterResumeExamples(examples, '운영').map((item) => item.id),
    ['minimal'],
  );
  assert.deepEqual(
    examples.map((item) => item.id),
    ['frontend', 'accounting', 'minimal'],
  );
});

// Keep the real API client; only the transport and the panel's DOM boundary are stubbed.
function panelHarness(t) {
  const node = () => {
    const listeners = new Map();
    return {
      innerHTML: '',
      addEventListener: (type, listener) => listeners.set(type, listener),
      emit: (type, event) => listeners.get(type)?.(event),
    };
  };
  const panel = { ...node(), open: false };
  const list = node();
  const controls = new Map([
    ['[data-example-search]', node()],
    ['[data-resume-random]', node()],
    ['[data-example-results]', node()],
  ]);
  list.querySelector = (selector) =>
    list.innerHTML.includes(selector.slice(1, -1)) ? controls.get(selector) : null;
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    getElementById: (id) => ({ 'resume-examples': panel, 'resume-example-list': list })[id],
  };
  t.after(() => {
    stopResumeExamples();
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise((resolve) => {
    requests.push({ url, options, resolve });
  }));
  const openings = [];
  bindResumeExamples({
    hasContent: () => false,
    onSelect: () => assert.fail('Opening the catalog must not select a resume'),
    onError: () => assert.fail('Opening the catalog must not invoke selection errors'),
    onOpen: () => openings.push({
      search: Boolean(list.querySelector('[data-example-search]')),
      random: Boolean(list.querySelector('[data-resume-random]')),
      results: list.querySelector('[data-example-results]')?.innerHTML,
    }),
  });
  return {
    panel, list, requests, openings,
    toggle(open) { panel.open = open; panel.emit('toggle'); },
    retry() {
      const button = { dataset: {}, hasAttribute: (name) => name === 'data-retry-examples' };
      list.emit('click', { target: { closest: () => button } });
    },
    async respond(index, status = 200) {
      requests[index].resolve(Response.json(status === 200 ? { items: examples } : {}, { status }));
      await nextTurn();
    },
  };
}

test('opening guidance waits for the actual controls and repeated toggles share one pending request', async (t) => {
  const h = panelHarness(t);
  h.toggle(true);
  assert.equal(h.requests[0].url, '/api/v1/resume-examples');
  assert.equal(h.openings.length, 0);
  h.toggle(false);
  h.toggle(true);
  assert.equal(h.requests.length, 1);
  await h.respond(0);
  assert.equal(h.openings.length, 1);
  assert.equal(h.openings[0].search, true);
  assert.equal(h.openings[0].random, true);
  assert.match(h.openings[0].results, /data-resume-example="frontend"/);
  assert.match(h.openings[0].results, /data-example-page="next"/);
});

test('reopening a loaded catalog shows guidance again without refetching', async (t) => {
  const h = panelHarness(t);
  h.toggle(true);
  await h.respond(0);
  h.toggle(false);
  assert.equal(h.openings.length, 1);
  h.toggle(true);
  assert.equal(h.openings.length, 2);
  assert.equal(h.requests.length, 1);
});

test('a response arriving after the panel closes does not reopen guidance', async (t) => {
  const h = panelHarness(t);
  h.toggle(true);
  h.toggle(false);
  await h.respond(0);
  assert.equal(h.openings.length, 0);
  assert.equal(h.panel.open, false);
});

test('a successful retry opens guidance only after replacing the error with controls', async (t) => {
  const h = panelHarness(t);
  h.toggle(true);
  await h.respond(0, 500);
  assert.equal(h.openings.length, 0);
  assert.match(h.list.innerHTML, /data-retry-examples/);
  h.retry();
  assert.equal(h.requests.length, 2);
  await h.respond(1);
  assert.equal(h.openings.length, 1);
  assert.equal(h.openings[0].search, true);
  assert.doesNotMatch(h.list.innerHTML, /data-retry-examples/);
});

test('stopping the panel aborts transport and ignores a late response during page cleanup', async (t) => {
  const h = panelHarness(t);
  h.toggle(true);
  const loadingMarkup = h.list.innerHTML;
  stopResumeExamples();
  assert.equal(h.requests[0].options.signal.aborted, true);
  // A transport may already have received its response when the route is disposed.
  await h.respond(0);
  assert.equal(h.openings.length, 0);
  assert.equal(h.list.innerHTML, loadingMarkup);
});
