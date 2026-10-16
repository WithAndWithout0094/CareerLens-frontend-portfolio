import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { catalogPath, catalogQuery } from '../../src/features/job-postings/catalog-state.js';
import { jobListPage, jobsError } from '../../src/pages/jobs.js';
import { publicErrorMessage } from '../../src/shared/api/error-messages.js';

const source = readFileSync(new URL('../../src/features/job-postings/catalog.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\r?\n/gm, '')
  .replace(/^export /gm, '');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const result = (label, overrides = {}) => ({
  items: [{ id: label, role: label, company: '테스트 기업', skills: [], description: label }],
  total: 1, page: 1, page_size: 12, ...overrides,
});

function fixture(request) {
  const elements = new Map();
  const main = { innerHTML: '', querySelectorAll: () => [] };
  elements.set('main', main);
  for (const id of ['catalog-search', 'retry-jobs']) elements.set(id, {
    listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener); },
  });
  const errors = [], navigations = [], requests = [];
  let retries = 0;
  const context = vm.createContext({
    AbortController, URLSearchParams,
    document: { getElementById: (id) => elements.get(id) || null },
    api: (path, options) => { requests.push({ path, ...options }); return request(path, options); },
    catalogPath, catalogQuery, jobListPage, jobsError, publicErrorMessage,
    bindCounters() {},
    options: {
      user: { id: 'member' }, navigate: (path) => navigations.push(path),
      onError: async (error) => errors.push(error), rerender: () => { retries++; },
    },
  });
  vm.runInContext(source, context);
  return {
    main, errors, navigations, requests,
    load(query = '') {
      context.route = { kind: 'list', query: new URLSearchParams(query) };
      return vm.runInContext('bindCatalog({ ...options, route })', context);
    },
    retry() { elements.get('retry-jobs').listeners.get('click')(); },
    get retries() { return retries; },
    dispose() { vm.runInContext('stopCatalogLoad()', context); },
  };
}

test('a superseded catalog search cannot replace the latest results or show its late failure', async () => {
  for (const lateFailure of [false, true]) {
    const first = deferred();
    const ui = fixture((path) => new URLSearchParams(path.split('?')[1]).get('q') === 'old'
      ? first.promise : Promise.resolve(result('latest')));
    const old = ui.load('q=old');
    await ui.load('q=latest');
    assert.equal(ui.requests[0].signal.aborted, true);
    const latest = ui.main.innerHTML;
    assert.match(latest, /latest/);
    if (lateFailure) first.reject(Object.assign(new Error('private traceback'), { status: 503 }));
    else first.resolve(result('obsolete'));
    await old;
    assert.equal(ui.main.innerHTML, latest);
    assert.deepEqual(ui.errors, []);
    ui.dispose();
  }
});

test('catalog errors provide retry and retain the search while a valid empty result remains distinct', async () => {
  const ui = fixture(async () => { throw Object.assign(new Error('private traceback'), { status: 503 }); });
  await ui.load('location=서울&page=2');
  assert.match(ui.main.innerHTML, /공고를 불러오지 못했어요/);
  assert.doesNotMatch(ui.main.innerHTML, /private traceback|조건에 맞는 공고가 없어요/);
  assert.match(ui.main.innerHTML, /location=%EC%84%9C%EC%9A%B8&amp;page=2/);
  ui.retry();
  assert.equal(ui.retries, 1);
  const empty = fixture(async () => result('', { items: [], total: 0 }));
  await empty.load('q=no-match');
  assert.match(empty.main.innerHTML, /조건에 맞는 공고가 없어요/);
  assert.doesNotMatch(empty.main.innerHTML, /id="retry-jobs"/);
  ui.dispose(); empty.dispose();
});

test('an empty out-of-range page returns to the last page without dropping filters', async () => {
  const ui = fixture(async () => result('', { items: [], total: 20, page: 9 }));
  await ui.load('location=서울&q=Python&page=9');
  const params = new URLSearchParams(ui.navigations[0].split('?')[1]);
  assert.equal(params.get('page'), '2');
  assert.equal(params.get('location'), '서울');
  assert.equal(params.get('q'), 'Python');
  ui.dispose();
});
