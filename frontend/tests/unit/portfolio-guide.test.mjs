import test from 'node:test';
import assert from 'node:assert/strict';
import { guideForRoute, showPageGuide, dismissPageGuide } from '../../src/features/portfolio/page-guide.js';

test('every product route presents its own features together and explains public monitoring', () => {
  for (const route of ['intro', 'resume', 'desired-role', 'jobs/backend', 'opportunities?role_id=developer', 'result', 'reports/one', 'mypage', 'admin', 'flow', 'login', 'email', 'signup', 'forgot', 'reset']) {
    const guide = guideForRoute(route);
    assert.ok(guide.title, route);
    assert.ok(guide.items.length >= 5, route);
    assert.match(guide.items.flat().join(' '), /로그인 없이 읽기 전용/);
    assert.doesNotMatch(guide.items.flat().join(' '), /일반 회원.*접속할 수 없습니다/);
  }
  assert.match(guideForRoute('resume').items.flat().join(' '), /프로젝트에 포함된 가상 이력서/);
  assert.match(guideForRoute('opportunities').items.flat().join(' '), /분석 로딩과 결과는 원래 화면/);
  assert.match(guideForRoute('result').items.flat().join(' '), /로그인 또는 회원가입/);
  assert.match(guideForRoute('intro').items.flat().join(' '), /팀의 기존 분석 백엔드/);
});

test('the flow guide describes its actual app-tab and My Page links instead of a nonexistent login menu', () => {
  for (const session of [{ user: null }, { user: { id: 'member' } }]) {
    const text = guideForRoute('flow', { session }).items.flat().join(' ');
    assert.match(text, /CareerLens 새 앱 탭 열기/);
    assert.match(text, /이력서 화면이 새 탭으로/);
    assert.match(text, /오른쪽 위 마이페이지 링크/);
    assert.doesNotMatch(text, /오른쪽 위 계정 메뉴|로그인 버튼|로그아웃으로/);
  }
  assert.match(guideForRoute('resume', { session: { user: null } }).items.flat().join(' '), /오른쪽 위 로그인 버튼/);
});

function guideDocument() {
  const listeners = new Map(), classes = new Set(), children = [];
  const app = { inert: false };
  const document = {
    activeElement: { isConnected: true, focus() {} },
    getElementById: () => app,
    body: {
      append: (host) => children.push(host),
      classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key) },
    },
    createElement() {
      const host = { dataset: {}, innerHTML: '', querySelector: () => ({ focus() {} }), remove: () => children.splice(children.indexOf(host), 1) };
      return host;
    },
    addEventListener: (key, callback) => listeners.set(key, callback),
    removeEventListener: (key) => listeners.delete(key),
    dispatchEvent() {},
  };
  return { document, app, children, fire: (name, event) => listeners.get(name)?.(event), listeners };
}

test('one click dismisses every hint without activating the underlying page and route changes show a fresh guide', () => {
  const fixture = guideDocument();
  showPageGuide('resume', { document: fixture.document, force: true });
  assert.equal(fixture.children.length, 1);
  assert.match(fixture.children[0].innerHTML, /AI를 활용해 구현한 프론트엔드 포트폴리오/);
  assert.equal((fixture.children[0].innerHTML.match(/<dt>/g) || []).length, 6);
  assert.equal(fixture.app.inert, true);
  let prevented = false, stopped = false;
  fixture.fire('click', { preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
  assert.ok(prevented && stopped);
  assert.equal(fixture.children.length, 0);
  assert.equal(fixture.app.inert, false);
  showPageGuide('resume', { document: fixture.document });
  assert.equal(fixture.children.length, 0, 'an async data render does not interrupt a dismissed guide');
  showPageGuide('desired-role', { document: fixture.document });
  assert.equal(fixture.children.length, 1);
  fixture.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(fixture.children.length, 0);
  showPageGuide('resume', { document: fixture.document });
  assert.equal(fixture.children.length, 1, 'returning to a prior page shows the guide again');
  dismissPageGuide();
  assert.equal(fixture.listeners.size, 0);
});
