import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { shell } from '../../src/shared/components/ui.js';
import { validatedProfileName } from '../../src/features/auth/profile-name.js';

const controller = readFileSync(new URL('../../src/app/main.js', import.meta.url), 'utf8');
const bindSource = controller.slice(controller.indexOf('function bindProfileName()'), controller.indexOf('function bindAccount()'));

function fixture(request) {
  const elements = new Map();
  const input = { value: '  입력 이름  ', disabled: false, focus() { this.focused = true; } };
  const button = { disabled: false };
  const feedback = { textContent: '' };
  let submit;
  const form = { querySelector: () => button, addEventListener(event, handler) { if (event === 'submit') submit = handler; } };
  elements.set('profile-name-form', form);
  elements.set('profile-name', input);
  elements.set('profile-name-status', feedback);
  const labels = new Map(['[data-account-name]', '[data-account-email]', '.account-name'].map(key => [key, { textContent: 'before' }]));
  const calls = [];
  const context = vm.createContext({
    AbortController, validatedProfileName,
    document: { getElementById: id => elements.get(id), querySelector: selector => labels.get(selector) },
    api: async (path, options) => { calls.push({ path, options }); return request(path, options); },
    publicErrorMessage: () => '저장하지 못했습니다.',
    handleError: async () => { vm.runInContext('session = { user: null }; profileRequest.abort()', context); },
  });
  vm.runInContext(`let profileRequest; let viewRevision = 1;
    let session = { user: { id: 'owner', name: '', email: 'own@example.test' } };
    ${bindSource}
    bindProfileName();`, context);
  return {
    input, button, feedback, labels, calls,
    submit: () => submit({ preventDefault() {} }),
    session: () => vm.runInContext('session', context),
    changeOwner: () => vm.runInContext("session = { user: { id: 'replacement', name: '다른 계정' } }", context),
    navigate: () => vm.runInContext('viewRevision += 1; profileRequest.abort()', context),
    logout: () => vm.runInContext('session = { user: null }; profileRequest.abort()', context),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

test('saving a name displays only confirmed values in the header and account fields', async () => {
  const view = fixture(async () => ({ user: { id: 'owner', name: '<확인된 이름>', email: 'own@example.test' } }));
  await view.submit();
  assert.equal(view.calls[0].path, '/account/profile');
  assert.equal(view.calls[0].options.method, 'PATCH');
  assert.equal(view.calls[0].options.body.name, '입력 이름');
  assert.equal(view.session().user.name, '<확인된 이름>');
  assert.equal(view.labels.get('.account-name').textContent, '<확인된 이름> 님');
  assert.equal(view.labels.get('[data-account-name]').textContent, '<확인된 이름>');
  assert.equal(view.labels.get('[data-account-email]').textContent, 'own@example.test');
  assert.equal(view.feedback.textContent, '이름을 저장했습니다.');
  assert.equal(view.button.disabled, false);
});

test('blank, overlong and multiline names are not submitted', async () => {
  for (const name of ['  ', '가'.repeat(81), '이름\n다음줄', '\u{20000}'.repeat(41), '\ufeff', '이\u2028름', '\ud800']) {
    const view = fixture(() => { throw new Error('must not send'); });
    view.input.value = name;
    await view.submit();
    assert.equal(view.calls.length, 0);
    assert.equal(view.input.focused, true);
    assert.match(view.feedback.textContent, /1~80/);
  }
});

test('name normalization matches the HTML UTF-16 boundary and trims Unicode whitespace', () => {
  for (const name of ['a'.repeat(80), '\u{20000}'.repeat(40), '이 름', '\u0085'])
    assert.equal(validatedProfileName(name), name);
  for (const name of [' \ufeff이름\u3000', '\n이름\n', ` ${'a'.repeat(80)} `])
    assert.equal(validatedProfileName(name), name.trim());
  for (const name of ['\u{20000}'.repeat(40) + 'a', '\u001c', '이\u2029름', 12, {}, null])
    assert.equal(validatedProfileName(name), null);
});

test('duplicate submit is disabled until the single save finishes', async () => {
  const response = deferred();
  const view = fixture(() => response.promise);
  const saving = view.submit();
  await view.submit();
  assert.equal(view.calls.length, 1);
  assert.equal(view.input.disabled, true);
  assert.equal(view.button.disabled, true);
  response.resolve({ user: { id: 'owner', name: '확인 이름', email: 'own@example.test' } });
  await saving;
  assert.equal(view.input.disabled, false);
});

for (const replace of ['changeOwner', 'navigate', 'logout']) {
  test(`a delayed save cannot update the screen after ${replace}`, async () => {
    const response = deferred();
    const view = fixture(() => response.promise);
    const saving = view.submit();
    view[replace]();
    response.resolve({ user: { id: 'owner', name: '이전 계정 이름', email: 'old@example.test' } });
    await saving;
    assert.equal(view.labels.get('.account-name').textContent, 'before');
    assert.notEqual(view.session().user?.name, '이전 계정 이름');
    assert.notEqual(view.feedback.textContent, '이름을 저장했습니다.');
  });
}

test('failed or wrong-owner responses never claim a name was saved', async () => {
  for (const result of [() => Promise.reject(new Error('offline')), async () => ({ user: { id: 'other', name: '타인' } })]) {
    const view = fixture(result);
    await view.submit();
    assert.equal(view.session().user.name, '');
    assert.equal(view.feedback.textContent, '저장하지 못했습니다.');
    assert.equal(view.button.disabled, false);
  }
});

test('expired authentication uses the existing session cleanup without retaining a saved identity', async () => {
  const view = fixture(async () => { throw Object.assign(new Error('expired'), { status: 401 }); });
  await view.submit();
  assert.equal(view.session().user, null);
  assert.equal(view.labels.get('.account-name').textContent, 'before');
});

test('header uses a real name or email fallback, never treating email as a name', () => {
  const render = user => shell('', { user, page: 'mypage', draft: {} });
  assert.match(render({ name: '홍길동', email: 'own@example.test' }), /class="account-name">홍길동 님</);
  assert.match(render({ name: '', email: 'own@example.test' }), /class="account-name">own@example.test</);
  assert.match(render({}), /class="account-name">로그인한 회원</);
  assert.doesNotMatch(render(null), /class="account-name"/);
  assert.doesNotMatch(render({ name: '<img src=x>' }), /<img src=x>/);
});
