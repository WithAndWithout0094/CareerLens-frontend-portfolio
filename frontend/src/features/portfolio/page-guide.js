import { escapeHtml as e } from '../../shared/components/ui.js';

const features = {
  intro: ['CareerLens 소개', [
    ['프론트엔드 포트폴리오', 'AI를 활용해 화면과 사용자 흐름을 구현하고, 개인 GitHub와 Render로 직접 배포한 작업물입니다.'],
    ['로고 · 애니메이션 영역', '왼쪽 위 로고나 CareerLens 이름을 누르면 이 소개 화면으로 돌아옵니다. 중앙은 소개 애니메이션이 표현되는 영역입니다.'],
    ['화면 전환', '안내를 닫으면 소개가 재생된 뒤 이력서 페이지로 이동합니다. 건너뛰기로 바로 시작할 수도 있습니다.'],
    ['기존 백엔드와 개인 수정', '팀의 기존 분석 백엔드를 바탕으로 동시 처리, 실행 보고서 연결, 관리자 모니터링을 개선했습니다.'],
  ]],
  resume: ['이력서 준비', [
    ['파일 첨부 · 본문 입력', 'Markdown 이력서를 첨부합니다. 회원은 본문을 직접 입력하고 편집하여 계정에 저장할 수 있습니다.'],
    ['랜덤 가상 이력서 체험', '회원은 프로젝트에 포함된 가상 이력서를 무작위로 불러오거나 직무·기술로 찾아 체험할 수 있습니다.'],
    ['채용공고로 계속', '준비한 이력서를 저장한 뒤 희망 직무와 분석할 공고를 선택합니다.'],
    ['회원 · 비회원', '비회원도 이력서 첨부와 공고 탐색을 체험할 수 있습니다. 보고서 결과 확인에 인증이 필요하면 로그인 안내가 표시됩니다.'],
  ]],
  'desired-role': ['희망 직무 선택', [
    ['희망 직무', '분석할 직무를 고릅니다. 선택한 직무에 맞는 채용공고를 다음 화면에서 볼 수 있습니다.'],
    ['희망 직무 직접 입력', '목록에 원하는 직무가 없으면 직접 입력을 선택하여 관심 직무를 적을 수 있습니다.'],
    ['공고 탐색', '직무 선택을 마치면 공고 목록으로 이동하여 기업과 모집 요건을 비교합니다.'],
    ['이력서로 돌아가기', '상단 이력서 메뉴에서 분석에 사용할 내용을 다시 확인하고 수정할 수 있습니다.'],
  ]],
  jobs: ['채용공고 탐색', [
    ['목록 · 검색 · 페이지 이동', '공고 목록에서 직무와 기업을 확인하고 제공되는 필터와 페이지 이동으로 범위를 좁힙니다.'],
    ['공고 상세', '공고를 선택하면 모집 요건, 담당 업무와 요구 역량을 읽을 수 있습니다.'],
    ['결과 확인', '선택한 공고와 이력서로 분석을 시작합니다. 기존 화면에서 로딩과 결과를 이어서 확인합니다.'],
    ['이용 흐름 새 창', '결과 확인을 누르면 이용 흐름 페이지만 별도 팝업으로 열립니다. 분석 로딩과 결과는 원래 화면에서 계속 확인합니다.'],
  ]],
  result: ['분석 보고서', [
    ['분석 결과 · 근거', '서버가 반환한 점수와 판단 근거, 개선 제안을 함께 확인합니다. 미수집 값은 실제 점수처럼 표시하지 않습니다.'],
    ['영역별 상세', '보고서의 영역 탭과 그래프를 통해 이력서와 채용공고의 연결 근거를 살펴봅니다.'],
    ['저장한 보고서', '회원은 마이페이지에서 본인 계정에 저장된 보고서를 다시 열 수 있습니다.'],
    ['비회원 결과 잠금', '비회원 보고서가 잠겨 있으면 로그인 또는 회원가입 안내에 따라 인증한 뒤 결과를 확인합니다.'],
  ]],
  mypage: ['마이페이지', [
    ['계정 정보', '현재 로그인한 계정의 이름과 이메일을 확인합니다.'],
    ['저장한 분석 보고서', '본인의 보고서를 검색하고 상태별로 찾아 다시 열 수 있습니다.'],
    ['보고서 관리', '목록의 선택 및 삭제 기능으로 본인의 저장된 보고서를 관리합니다.'],
    ['공개 운영 모니터링', '로그인 없이 공개 대시보드와 이용 흐름 새 창에서 개인정보를 제외한 운영 상태를 체험할 수 있습니다.'],
  ]],
  admin: ['포트폴리오 공개 대시보드', [
    ['실행 보고서 집계', '가져온 기존 실행 보고서와 배포된 서비스에서 새로 생성된 실행 결과를 확인합니다.'],
    ['결과 · 처리 상태', '실제 기록에 따른 성공·실패와 처리 시간을 확인합니다. 자료가 없는 항목은 미수집으로 표시합니다.'],
    ['보고서 상세', '목록과 상세 보기로 개인 식별 정보를 제외한 실행 결과를 읽기 전용으로 점검합니다.'],
    ['이용 흐름 새 창', '관리자용 이용 흐름 모니터링 페이지에서 여러 사용자의 진행 상태를 함께 확인합니다.'],
  ]],
  flow: ['관리자용 이용 흐름 모니터링 페이지', [
    ['여러 사용자 진행 상태', '서버와 Redis에 연결된 실제 실행 상태를 확인합니다. 다른 사용자의 요청도 독립된 실행으로 표시합니다.'],
    ['단계별 흐름', '통합된 단계 카드에서 시작·진행·완료·실패를 구분하여 관찰합니다.'],
    ['연결 상태 · 새로고침', '실시간 연결 상태와 최근 갱신 시점을 확인합니다. 연결이 끊기면 재연결 후 실제 상태를 다시 가져옵니다.'],
    ['원래 작업 화면 유지', '이 창은 관찰용입니다. 분석 로딩과 결과는 원래 CareerLens 창에서 계속 확인할 수 있습니다.'],
  ]],
};

const authLabels = { login: '로그인 방법', email: '이메일 로그인', signup: '회원가입', forgot: '비밀번호 찾기', reset: '비밀번호 재설정' };

export function guideForRoute(route = 'intro', { session } = {}) {
  const base = route.split('?')[0];
  const key = base.startsWith('reports/') ? 'result' : ['opportunities', 'jobs'].includes(base) || base.startsWith('jobs/') ? 'jobs' : base;
  const auth = authLabels[key];
  const [title, items] = auth ? [auth, [
    ['계정 입력', key === 'signup' ? '이름·이메일·비밀번호를 입력하여 계정을 만듭니다.' : key === 'reset' ? '재설정 링크에서 새 비밀번호를 저장합니다.' : key === 'forgot' ? '가입한 이메일로 비밀번호 재설정 안내를 요청합니다.' : '이메일과 비밀번호로 로그인합니다. 활성화된 로그인 방법만 사용할 수 있습니다.'],
    ['회원 기능', '이력서 저장·가상 이력서 체험·분석 보고서 확인과 재조회 기능을 이용할 수 있습니다.'],
    ['비회원으로 둘러보기', '상단 메뉴로 돌아가 이력서 첨부와 채용공고 탐색을 체험할 수 있습니다.'],
  ]] : (features[key] || features.resume);
  return { title, items: [
    ...items,
    ['오른쪽 위 계정 메뉴', session?.user ? '마이페이지에서 저장한 보고서를 확인하고, 로그아웃으로 계정 사용을 마칩니다.' : '먼저 로그인하고 싶다면 오른쪽 위 로그인 버튼을 누르세요. 계정이 없다면 회원가입으로 이어집니다.'],
    ['포트폴리오 공개 운영 모니터링', '관리자용 대시보드와 이용 흐름을 로그인 없이 읽기 전용으로 체험할 수 있습니다. 개인 이력서와 보고서 원문은 공개하지 않습니다.'],
  ] };
}

let previousRoute;
let disposeGuide;

/** All page features are shown together, on every page navigation as requested. */
export function showPageGuide(route, { session, force = false, document: doc = globalThis.document } = {}) {
  if (!doc?.body) return () => {};
  const key = `${route}:${session?.user?.is_admin === true ? 'admin' : session?.user ? 'member' : 'guest'}`;
  if (!force && key === previousRoute) return disposeGuide || (() => {});
  disposeGuide?.();
  previousRoute = key;
  const guide = guideForRoute(route, { session });
  const host = doc.createElement('div');
  host.className = 'page-guide';
  host.dataset.pageGuide = route;
  host.innerHTML = `<section class="page-guide__sheet" role="dialog" aria-modal="true" aria-labelledby="page-guide-title" aria-describedby="page-guide-close-hint" tabindex="-1">
    <div class="page-guide__heading"><div><p class="page-guide__portfolio">AI를 활용해 구현한 프론트엔드 포트폴리오</p><h2 id="page-guide-title">${e(guide.title)}</h2></div><button type="button" class="page-guide__close" aria-label="페이지 기능 안내 닫기">닫기</button></div>
    <p class="page-guide__credit">프론트엔드 구현 · 기존 팀 백엔드 연동 및 개선 · 개인 GitHub / Render 직접 배포</p>
    <dl class="page-guide__features">${guide.items.map(([label, text]) => `<div><dt>${e(label)}</dt><dd>${e(text)}</dd></div>`).join('')}</dl>
    <p class="page-guide__hint" id="page-guide-close-hint">화면 어디든 누르거나 Esc를 누르면 모든 안내가 닫힙니다. 다음 페이지에서도 기능을 한 번에 안내합니다.</p>
  </section>`;
  const app = doc.getElementById('app');
  const wasInert = app?.inert;
  const previousFocus = doc.activeElement;
  if (app) app.inert = true;
  doc.body.append(host);
  doc.body.classList.add('page-guide-open');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    doc.removeEventListener('click', clicked, true);
    doc.removeEventListener('keydown', keydown, true);
    host.remove();
    doc.body.classList.remove('page-guide-open');
    if (app) app.inert = Boolean(wasInert);
    if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
    doc.dispatchEvent(new CustomEvent('careerlens:guide-dismiss'));
  };
  const clicked = (event) => { event.preventDefault(); event.stopPropagation(); close(); };
  const keydown = (event) => {
    if (['Escape', 'Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') { event.preventDefault(); host.querySelector('button')?.focus(); }
  };
  doc.addEventListener('click', clicked, true);
  doc.addEventListener('keydown', keydown, true);
  host.querySelector('button')?.focus({ preventScroll: true });
  doc.dispatchEvent(new CustomEvent('careerlens:guide-open'));
  disposeGuide = close;
  return close;
}

export function dismissPageGuide() { disposeGuide?.(); }
