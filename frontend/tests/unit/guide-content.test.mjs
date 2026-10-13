import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guideForRoute } from '../../src/features/portfolio/guide-content.js';
import { shell } from '../../src/shared/components/ui.js';
import { workspacePage } from '../../src/pages/workspace.js';
import { guestResumePage } from '../../src/features/resumes/guest.js';
import { renderAuth } from '../../src/features/auth/auth.js';
import { reportGatePage } from '../../src/features/auth/report-gate.js';
import { introductionPage } from '../../src/pages/introduction.js';
import { opportunitiesPage, opportunityDetail } from '../../src/pages/opportunities.js';
import { jobListPage, jobDetailPage, postingEditorPage } from '../../src/pages/jobs.js';
import { myPage, savedReportsList } from '../../src/pages/my-page.js';
import { adminDashboard } from '../../src/pages/admin-dashboard.js';

const guest = { user: null, backend_adapter: true };
const member = { user: { id: 'fixture-member' }, backend_adapter: true };
const demo = { user: { id: 'fixture-demo', demo: true }, backend_adapter: true };
const hints = (route, session = guest) => guideForRoute(route, { session }).items;
const byId = (route, id, session) => hints(route, session).find(item => item.id === id);

test('every route exports the anchor contract with concise copy and stable unique identifiers', () => {
  for (const route of ['intro', 'resume', 'job', 'desired-role', 'opportunities?role_id=developer', 'jobs', 'jobs/one', 'jobs/new', 'jobs/one/edit', 'result', 'reports/one', 'mypage', 'admin', 'flow', 'login', 'email', 'signup', 'forgot', 'reset']) {
    for (const session of [guest, member, demo]) {
      const guide = guideForRoute(route, { session });
      assert.ok(guide.title, route);
      assert.equal(new Set(guide.items.map(item => item.id)).size, guide.items.length, route);
      for (const item of guide.items) {
        assert.ok(item.id && item.label && item.text, route);
        assert.ok(item.text.length <= 130, `${route}/${item.id} copy too long`);
        assert.ok(item.targets.length && item.targets.every(target => typeof target === 'string' && target.trim()), `${route}/${item.id}`);
        assert.ok(['top', 'bottom', 'left', 'right'].includes(item.placement));
      }
    }
  }
});

test('guest/member resume hints never describe the other audience controls', () => {
  const guestIds = hints('resume', guest).map(item => item.id);
  for (const absent of ['random-resume', 'resume-examples', 'resume-text', 'clear-workspace']) assert.ok(!guestIds.includes(absent));
  assert.deepEqual(byId('resume', 'upload', guest).targets, ['#guest-resume-file']);
  assert.ok(!hints('resume', member).some(item => item.id === 'guest-retention'));
  assert.deepEqual(byId('resume', 'random-resume', member).targets, ['#example']);
  assert.match(byId('resume', 'random-resume', member).text, /프로젝트에 포함된/);
});

test('guest reports point to the actual login gate rather than hidden score and report controls', () => {
  assert.ok(hints('result', guest).some(item => item.id === 'report-login'));
  assert.ok(!hints('result', guest).some(item => item.id === 'result-graphic'));
  assert.ok(!hints('result', member).some(item => item.id === 'report-login'));
  assert.deepEqual(guideForRoute('reports/existing', {session: member}), guideForRoute('result', {session: member}));
  const gate = reportGatePage({report_locked: true});
  for (const id of ['report-login', 'report-signup', 'report-discard']) {
    const target = byId('result', id, guest).targets[0];
    assert.ok(gate.includes(target.slice(1, -1)), target);
  }
});

test('flow describes the actual standalone header and never invents a login or logout control', () => {
  for (const session of [guest, member]) {
    const items = hints('flow', session);
    assert.deepEqual(items.find(item => item.id === 'brand').targets, ['.flow-brand']);
    assert.deepEqual(items.find(item => item.id === 'account').targets, ['.flow-app-link']);
    assert.ok(!items.some(item => item.id === 'login' || item.id === 'public-dashboard'));
    assert.doesNotMatch(items.map(item => item.text).join(' '), /로그인 버튼|로그아웃/);
    const viewer = readFileSync(new URL('../../src/features/activity-flow/viewer.js', import.meta.url), 'utf8');
    for (const item of items.filter(item => item.id.startsWith('flow-'))) {
      for (const target of item.targets) {
        if (target.startsWith('[')) assert.ok(viewer.includes(target.slice(1, -1)), target);
        else assert.ok(viewer.includes(target.slice(1)), target);
      }
    }
  }
});

test('catalog detail and unavailable editor routes do not inherit the list or demo editing hints', () => {
  assert.ok(byId('jobs', 'search', member));
  assert.ok(!byId('jobs/one', 'search', member));
  assert.deepEqual(byId('jobs/one', 'result-confirm', guest).targets, ['#select-posting']);
  for (const route of ['jobs/new', 'jobs/one/edit']) {
    assert.ok(byId(route, 'posting-restricted', member));
    assert.ok(!byId(route, 'posting-body', member));
    assert.ok(byId(route, 'posting-body', demo));
    assert.ok(!byId(route, 'posting-restricted', demo));
  }
  assert.match(postingEditorPage({}, undefined, undefined, member.user), /id="jobs-readonly-note"/);
});

test('authentication hints match backend credentials, social providers and unavailable reset forms', () => {
  assert.ok(byId('login', 'auth-email', guest));
  assert.ok(!byId('login', 'login-providers', guest));
  assert.ok(byId('login', 'login-providers', {user:null}));
  const disabled = {...guest, capabilities: {password_reset:false}};
  for (const route of ['forgot', 'reset']) {
    assert.ok(byId(route, 'reset-unavailable', disabled));
    assert.ok(!hints(route, disabled).some(item => item.targets.includes('#auth-form')));
  }
  const embedded = reportGatePage({report_locked:true}, {authPage:'email', session:guest});
  assert.match(embedded, /id="auth-email"/);
  assert.match(embedded, /id="auth-form"/);
});

test('critical feature anchors are emitted by the actual templates used for their routes', () => {
  const draft = {resume_text:'프로젝트에 사용한 합성 이력서', career_target:{role_id:'developer'}};
  const posting = {id:'fixture', role:'개발자', company:'가상 기업', skills:[], description:'가상 담당 업무'};
  const cases = [
    ['intro', guest, introductionPage(), 'animation', 'data-intro-journey'],
    ['resume', guest, guestResumePage(), 'upload', 'id="guest-resume-file"'],
    ['resume', member, workspacePage('resume', {}), 'random-resume', 'id="example"'],
    ['desired-role', member, workspacePage('desired-role', draft), 'role', 'id="career-role"'],
    ['opportunities', guest, opportunitiesPage()+opportunityDetail(posting, null), 'result-confirm', 'id="opportunity-apply"'],
    ['jobs', member, jobListPage({items:[posting],total:1,page:1,page_size:12}, new URLSearchParams(), member.user), 'search', 'class="catalog-search-row"'],
    ['jobs/fixture', member, jobDetailPage(posting, member.user, new URLSearchParams()), 'result-confirm', 'id="select-posting"'],
    ['mypage', member, myPage(member.user), 'identity', 'class="my-page__account"'],
    ['admin', guest, adminDashboard(), 'execution-reports', 'data-execution-load'],
    ['email', guest, renderAuth('email', guest), 'auth-email', 'id="auth-email"'],
  ];
  for (const [route, session, markup, hintId, marker] of cases) {
    assert.ok(byId(route, hintId, session), `${route}/${hintId}`);
    assert.ok(markup.includes(marker), `${route}: ${marker}`);
  }
  const signedOutShell = shell('', {user:null});
  assert.match(signedOutShell, /class="account-menu"[\s\S]*href="#\/email"/);
  assert.match(signedOutShell, /class="portfolio-note"/);
  assert.match(savedReportsList({items:[{id:'one',status:'completed'}],loaded:true}), /data-reports-query/);
});
