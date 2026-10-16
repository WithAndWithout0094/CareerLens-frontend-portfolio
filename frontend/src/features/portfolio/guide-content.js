// Describe real controls only. The renderer selects the first visible matching
// target and omits a hint when none exists (for example an unavailable action).
const hint = (id, label, text, targets, placement = 'bottom') => ({ id, label, text, targets, placement });
const memberOf = (session) => Boolean(session?.user);

function commonHints(key, session) {
  const portfolio = hint('portfolio', 'AI 활용 프론트엔드 포트폴리오',
    'AI로 구현한 프론트엔드 작업물입니다. 개인 GitHub·Render로 직접 배포했습니다.',
    ['.portfolio-note strong', '.auth-education', '.flow-intro h2']);
  if (key === 'flow') return [portfolio,
    hint('brand', 'CareerLens 새 앱 탭', '로고를 누르면 이력서 화면이 새 탭으로 열립니다. 원래 분석 창은 유지됩니다.', ['.flow-brand']),
    hint('account', '마이페이지', '저장한 보고서를 확인합니다. 비회원이면 로그인 안내로 이동합니다.', ['.flow-app-link'], 'left'),
  ];
  return [portfolio,
    hint('brand', '로고 · 소개 화면', '로고나 CareerLens 이름을 누르면 소개 애니메이션 영역이 있는 홈으로 돌아갑니다.', ['.brand']),
    memberOf(session)
      ? hint('account', '마이페이지 · 로그아웃', '본인의 저장한 보고서를 열거나 로그아웃할 수 있습니다.', ['.account-menu'], 'left')
      : hint('login', '로그인부터 시작하려면', '이 버튼에서 이메일 로그인과 회원가입으로 이동합니다.', ['.account-menu a[href="#/email"]'], 'left'),
    hint('public-dashboard', '공개 대시보드', '로그인 없이 실행 시간·상태를 봅니다. 개인 문서 원문은 비공개입니다.', ['.portfolio-note a[href="#/admin"]']),
    hint('public-flow', '이용 흐름 새 창', '여러 사용자의 실제 처리 상태를 별도 창에서 관찰합니다.', ['.portfolio-note [data-flow-open]']),
  ];
}

function resumeHints(member) {
  if (!member) return [
    hint('upload', '비회원 이력서 첨부', 'UTF-8 Markdown(.md) 이력서를 선택하세요. 최대 10MB까지 첨부할 수 있습니다.', ['#guest-resume-file'], 'right'),
    hint('guest-retention', '임시 분석 · 결과 로그인', '비회원 자료의 임시 보관 안내를 확인하세요. 보고서 원문은 로그인·회원가입 후 열립니다.', ['.guest-resume__privacy'], 'right'),
    hint('continue', '이력서 첨부 후 공고 선택', '선택한 이력서를 첨부하고 희망 직무·공고 선택으로 이동합니다.', ['#guest-upload-form [type="submit"]'], 'top'),
  ];
  return [
    hint('random-resume', '랜덤 가상 이력서', '프로젝트에 포함된 가상 이력서를 무작위로 불러와 저장하고 직무 선택으로 이동합니다.', ['#example'], 'left'),
    hint('resume-examples', '가상 이력서 찾아보기', '펼치면 직무·기술 검색과 무작위 선택을 사용할 수 있습니다. 선택한 내용은 내 계정에 저장됩니다.', ['#resume-examples > summary']),
    hint('upload', '이력서 파일 불러오기', 'Markdown 파일을 선택하고 파일 불러오기를 눌러 본문에 적용합니다.', ['#upload-form .file-controls'], 'right'),
    hint('resume-text', '이력서 직접 편집', '경력·프로젝트·기술을 직접 입력하거나 붙여넣습니다. 40자 이상 입력하세요.', ['#resume-text'], 'right'),
    hint('continue', '저장하고 공고 선택', '현재 이력서를 저장한 뒤 희망 직무를 선택합니다.', ['#resume-form [type="submit"]'], 'top'),
    hint('clear-workspace', '입력 내용과 결과 삭제', '확인 후 현재 계정의 작업 내용을 초기화합니다. 삭제한 내용은 복구할 수 없습니다.', ['#clear-workspace'], 'top'),
  ];
}

const pages = {
  intro: ['CareerLens 소개', [
    hint('animation', '소개 애니메이션 자리', '소개 애니메이션을 배치하는 영역입니다. 안내를 닫으면 이력서 화면으로 전환됩니다.', ['[data-intro-journey]'], 'right'),
    hint('intro-skip', '바로 체험하기', '소개를 건너뛰고 이력서 페이지로 이동합니다.', ['[data-intro-skip]'], 'left'),
    hint('contribution', '기존 팀 백엔드와 개인 수정', '기존 팀 백엔드에 동시 처리·실행 보고서·Redis 연동을 추가했습니다.', ['.portfolio-contribution'], 'left'),
  ]],
  'desired-role': ['희망 직무 선택', [
    hint('role', '희망 직무 선택', '관심 직무를 고르세요. 원하는 직무가 없으면 목록의 직접 입력을 선택할 수 있습니다.', ['#career-role'], 'right'),
    hint('custom-role', '직무 직접 입력', '목록에 없는 희망 직무를 입력합니다.', ['#custom-role-field:not([hidden]) input'], 'right'),
    hint('resume-back', '이력서 수정', '이력서 페이지로 돌아가 분석할 내용을 다시 확인합니다.', ['#job-form a[href="#/resume"]'], 'top'),
    hint('role-continue', '관련 공고 보기', '선택한 직무에 맞는 공고 목록으로 이동합니다.', ['#prepare-submit'], 'top'),
  ]],
  opportunities: ['직무별 공고 선택', [
    hint('scope', '공고 표시 범위', '같은 분류·선택한 직무·전체 공고 중 표시할 범위를 고릅니다.', ['#opportunity-scope'], 'right'),
    hint('posting-list', '공고 선택', '목록의 공고를 누르면 오른쪽에 업무와 지원 요건이 표시됩니다.', ['#opportunity-list'], 'right'),
    hint('posting-pages', '공고 목록 페이지', '이전·다음 버튼으로 다른 공고를 더 확인합니다.', ['#opportunity-pagination'], 'top'),
    hint('catalog', '전체 직무별 공고', '직무·기업·기술 검색과 추가 필터가 있는 전체 공고 화면으로 이동합니다.', ['#opportunity-catalog'], 'right'),
    hint('posting-detail', '선택한 공고 상세', '기업 정보와 담당 업무, 지원 요건을 살펴봅니다.', ['.opportunity-detail__body'], 'left'),
    hint('result-confirm', '모의지원 결과 확인', '이 창에서 분석 로딩과 결과를 확인합니다. 이용 흐름 페이지만 별도 팝업으로 열립니다.', ['#opportunity-apply'], 'top'),
    hint('role-back', '희망 직무 변경', '직무 선택 화면으로 돌아가 공고 탐색 기준을 바꿉니다.', ['.opportunities-heading .back-link'], 'left'),
  ]],
  jobs: ['전체 채용공고', [
    hint('search', '직무·회사·기술 검색', '검색어를 입력하고 검색 버튼을 누르세요.', ['.catalog-search-row']),
    hint('filters', '공고 조건 필터', '직무 분류·지역·고용 형태·경력·기술로 범위를 좁힙니다.', ['.catalog-filters']),
    hint('job-list', '공고 상세 열기', '공고 제목이나 상세 보기를 누르면 모집 요건과 결과 확인 버튼이 있는 화면으로 이동합니다.', ['.job-grid'], 'right'),
    hint('job-pagination', '공고 페이지 이동', '이전·다음 페이지의 공고를 살펴봅니다.', ['.catalog-pagination'], 'top'),
    hint('read-only-postings', '연동 준비 중인 기능', '공고 작성·수정·삭제와 관심 공고 저장은 비활성화되어 있습니다.', ['#jobs-readonly-note']),
  ]],
  'job-detail': ['채용공고 상세', [
    hint('posting-content', '주요 업무와 지원 요건', '공고의 업무·요건을 확인한 뒤 내 이력서와 비교합니다.', ['.posting-description'], 'right'),
    hint('result-confirm', '모의지원 결과 확인', '이 창에서 분석 로딩과 결과를 확인합니다. 이용 흐름만 새 팝업으로 열립니다.', ['#select-posting'], 'left'),
    hint('source', '공고 출처', '출처가 있는 공고는 원문 또는 참고 자료를 새 탭에서 열 수 있습니다.', ['.posting-source a'], 'top'),
    hint('job-list-back', '공고 목록으로', '전체 공고 목록으로 돌아갑니다.', ['.job-detail > .back-link']),
    hint('read-only-postings', '연동 준비 중인 기능', '비활성화된 관심 공고 저장·작성·수정·삭제는 아직 사용할 수 없습니다.', ['#jobs-readonly-note']),
  ]],
  mypage: ['마이페이지', [
    hint('identity', '로그인 계정', '현재 로그인한 계정의 이름과 이메일을 확인합니다.', ['.my-page__account'], 'right'),
    hint('saved-reports', '저장한 분석 보고서', '본인 계정에 저장된 보고서를 다시 열 수 있습니다.', ['.saved-reports__heading']),
    hint('report-filters', '보고서 검색·상태', '현재 불러온 보고서를 회사·직무·평가 ID와 상태로 찾습니다.', ['.saved-reports__filters']),
    hint('report-delete', '보고서 선택·삭제', '선택한 보고서를 삭제합니다. 삭제를 지원하지 않는 저장 서버의 보고서는 버튼이 비활성화됩니다.', ['.saved-reports__selection-bar']),
    hint('report-open', '저장한 결과 열기', '보고서 열기에서 기존 분석 결과를 확인합니다.', ['.saved-report__open'], 'left'),
    hint('report-more', '이전 보고서 더 보기', '다음 기록을 불러와 목록에 추가합니다.', ['[data-reports-more]'], 'top'),
  ]],
  admin: ['공개 운영 대시보드', [
    hint('execution-reports', '기존·배포 실행 보고서', '가져온 기존 기록과 배포 후 생성된 기록의 운영 요약을 조회합니다. 개인 문서 원문은 표시하지 않습니다.', ['[data-execution-load]'], 'right'),
    hint('execution-open', '실행 보고서 상세', '목록에서 기록을 선택해 단계별 시간과 호출 수를 확인합니다.', ['[data-execution-list]'], 'right'),
    hint('admin-filters', '기간·상태·새로고침', '조회 기간과 실행 상태를 선택합니다. 자동 갱신 중에도 새로고침으로 최신 기록을 요청할 수 있습니다.', ['.admin-dashboard__toolbar']),
    hint('admin-overview', '실행 상태 집계', '현재 조회 표본의 대기·진행·완료·실패 상태를 확인합니다.', ['.admin-dashboard__cards']),
    hint('admin-runs', '실행 목록·상세', '실행을 선택하면 저장된 단계와 시간을 읽기 전용으로 확인할 수 있습니다.', ['#admin-runs'], 'right'),
    hint('admin-timing', '단계별 소요 시간', '평균과 P95 등 실제 계측값을 비교합니다. 진행률을 나타내는 그래프는 아닙니다.', ['#admin-timing'], 'right'),
    hint('admin-flow', '실시간 이용 흐름', '서버·Redis의 실제 처리 상태를 별도 창에서 확인합니다.', ['[data-admin-flow]'], 'left'),
  ]],
  flow: ['관리자용 이용 흐름 모니터링 페이지', [
    hint('flow-mode', '관찰 모드', '전체 이용·이 브라우저·가상 시연 중 선택합니다. 시연은 실제 분석 기록과 구분됩니다.', ['[data-flow-mode]']),
    hint('flow-source', '상세 지도 대상', '최근 이용을 자동 추적하거나 특정 대상의 흐름을 고정해 봅니다.', ['[data-flow-source]']),
    hint('flow-theme', '화면 밝기', '밝게·어둡게 버튼으로 보기 편한 화면을 선택합니다.', ['.flow-theme-switch']),
    hint('flow-motion', '동작 줄이기', '흐름 화면의 모션을 줄일 수 있습니다.', ['[data-flow-motion]'], 'left'),
    hint('flow-connection', '실시간 연결 상태', '서버 연결 상태와 관찰 범위를 확인합니다. 연결 장애를 정상 진행으로 표시하지 않습니다.', ['.flow-connection'], 'left'),
    hint('flow-global', '여러 사용자의 실행 기록', '전체 이용 기록에서 대상을 선택하면 아래 지도에 해당 실행이 표시됩니다.', ['[data-flow-global-feed]']),
    hint('flow-demo', '카드별 가상 시연', '요약 카드를 누르면 왼쪽 탭 아래에 시연 조작부가 있습니다. 상황을 고르고 시연을 시작하면 지도와 함께 입력·처리·출력을 확인합니다.', ['[data-flow-explore="overview:analysis"]'], 'right'),
    hint('flow-map', '빛으로 따라가는 서비스 흐름', '선과 빛은 코드 연결 방향을 안내합니다. 카드를 누르면 가로 세부 지도가 열리고, 지도 위 휠로 확대·축소하거나 드래그로 이동합니다. 하위 카드 탐색과 이전 단계 복귀도 가능합니다.', ['.flow-overview-stages']),
    hint('flow-source-code', '실제 코드와 연결된 구조', '기능 코드에서 생성한 카드와 연결입니다. 코드 변경 후 빌드·배포하면 반영됩니다. 상세 창은 시연용이며 실시간 실행 기록과 구분됩니다.', ['.flow-source-version'], 'left'),
    hint('flow-ledger', '실시간 세부 항목', '펼치면 수집 가능한 항목의 실제 상태와 현재 코드의 연결 관계를 확인합니다.', ['.flow-ledger > summary']),
    hint('flow-log', '이벤트·응답 시간', '펼치면 선택한 대상의 최근 처리 기록과 측정된 시간을 확인합니다.', ['.flow-instrument-details > summary'], 'right'),
    hint('flow-timing', '측정된 처리 시간', '서버에서 수집된 시간만 표시합니다. 제공되지 않은 값은 미측정으로 남습니다.', ['.flow-timing-panel']),
    hint('flow-detail', '선택한 단계 상세', '지도에서 선택한 단계의 상태와 수집된 정보를 확인합니다.', ['.flow-detail-panel'], 'left'),
  ]],
};

function resultHints(member) {
  if (!member) return [
    hint('report-lock', '보고서 결과는 로그인 후', '보고서의 본문과 점수는 로그인 또는 회원가입 후 확인할 수 있습니다.', ['#report-gate-description'], 'right'),
    hint('report-login', '로그인하고 결과 확인', '기존 계정으로 로그인하여 결과 확인을 이어갑니다.', ['[data-report-gate-login]'], 'left'),
    hint('report-signup', '회원가입하고 결과 확인', '새 계정을 만들어 준비한 자료와 결과 확인을 이어갑니다.', ['[data-report-gate-signup]'], 'right'),
    hint('report-discard', '임시 자료 삭제', '첨부한 이력서와 임시 결과를 파기합니다.', ['[data-report-gate-discard]'], 'top'),
  ];
  return [
    hint('result-graphic', '4개 평가축 점수', '서버가 제공한 실제 점수를 그래프로 확인합니다. 미산정 값은 0점으로 대체하지 않습니다.', ['#report-graphics'], 'right'),
    hint('result-summary', '공고와 핵심 요약', '분석 대상 공고와 이력서에 대한 핵심 요약을 읽습니다.', ['.report-hero-copy'], 'left'),
    hint('result-contents', '보고서 목차', '원하는 영역을 누르면 보고서 안의 해당 위치로 이동합니다.', ['.report-section-nav'], 'right'),
    hint('result-saved', '다른 저장 보고서', '사이드바에서 본인의 저장한 보고서를 선택합니다.', ['[data-open-report-picker]'], 'left'),
    hint('result-evidence', '평가와 판단 근거', '실제 평가 항목·근거·개선 제안을 보고서 본문에서 확인합니다.', ['#backend-evaluation', '#readiness'], 'right'),
    hint('result-method', '점수 해석 안내', '펼쳐서 점수 계산과 미산정 항목의 의미를 확인합니다.', ['.methodology > summary'], 'top'),
  ];
}

function authHints(key, session) {
  if (['forgot', 'reset'].includes(key) && session?.capabilities?.password_reset === false) return [
    hint('reset-unavailable', '비밀번호 재설정 미지원', '현재 서비스에서는 비밀번호 재설정을 지원하지 않습니다. 로그인 화면으로 돌아갈 수 있습니다.', ['.auth-form-panel a[href="#/email"]']),
  ];
  const credentialLogin = key === 'email' || (key === 'login' && session?.backend_adapter);
  if (key === 'login' && !credentialLogin) return [
    hint('login-providers', '로그인 방법 선택', '활성화된 제공자로 로그인하거나 이메일로 계속할 수 있습니다.', ['.social-buttons']),
    hint('email-login', '이메일로 로그인', '이메일과 비밀번호를 사용하는 로그인 화면으로 이동합니다.', ['.auth-form-panel a[href="#/email"]']),
    hint('signup', '처음이라면 회원가입', '이메일 계정을 만들어 이력서와 보고서를 저장합니다.', ['.auth-switch a[href="#/signup"]']),
  ];
  if (key === 'forgot') return [
    hint('reset-email', '재설정 안내 요청', '가입한 이메일을 입력하고 재설정 안내 받기를 누릅니다.', ['#auth-form']),
    hint('login-back', '로그인으로 돌아가기', '기존 비밀번호로 로그인하려면 돌아가기를 누르세요.', ['.auth-back']),
  ];
  if (key === 'reset') return [
    hint('new-password', '새 비밀번호 저장', '유효한 재설정 링크에서 새 비밀번호를 입력하여 저장합니다.', ['#auth-form']),
  ];
  return [
    ...(key === 'signup' ? [hint('signup-name', '회원 이름', '계정에 사용할 이름을 입력합니다.', ['#auth-name'], 'right')] : []),
    hint('auth-email', '이메일', key === 'signup' ? '가입할 이메일 주소를 입력합니다.' : '가입한 이메일 주소를 입력합니다.', ['#auth-email'], 'right'),
    hint('auth-password', '비밀번호', '비밀번호를 입력하세요. 표시 버튼으로 입력한 내용을 확인할 수 있습니다.', ['.password-wrap'], 'right'),
    hint('auth-submit', key === 'signup' ? '회원가입' : '로그인', key === 'signup' ? '입력한 정보로 계정을 만듭니다. 인증이 필요한 경우 화면 안내를 따라 주세요.' : '계정에 로그인하여 이력서와 보고서 확인을 이어갑니다.', ['#auth-form [type="submit"]'], 'left'),
    hint('auth-switch', key === 'signup' ? '이미 계정이 있다면' : '계정이 없다면', key === 'signup' ? '기존 계정의 이메일 로그인 화면으로 이동합니다.' : '회원가입 화면으로 이동합니다.', ['.auth-switch a'], 'top'),
    hint('password-forgot', '비밀번호 찾기', '가입한 이메일로 비밀번호 재설정 안내를 요청합니다.', ['.forgot-link a'], 'left'),
  ];
}

function postingEditorHints(session) {
  if (session?.user?.demo !== true) return [
    hint('posting-restricted', '공고 편집 안내', '현재 연결된 서버에서는 공고 편집을 지원하지 않습니다. 공고 목록으로 돌아가 탐색할 수 있습니다.', ['#jobs-readonly-note']),
  ];
  return [
    hint('posting-fields', '시연 공고 기본 정보', '회사·직무·근무 조건을 입력합니다. 이 공고는 현재 탭의 시연 자료입니다.', ['#posting-form .two-fields']),
    hint('posting-skills', '기술·역량', '기술을 쉼표로 구분해 입력합니다.', ['#posting-skills'], 'right'),
    hint('posting-body', '공고 본문', '업무·자격 요건·우대 사항을 40자 이상 입력합니다.', ['#posting-description'], 'right'),
    hint('posting-save', '시연 공고 저장', '내용을 이 탭에만 저장합니다. 실제 계정이나 서버에는 저장되지 않습니다.', ['#posting-form [type="submit"]'], 'top'),
  ];
}

const authTitles = { login: '로그인 방법', email: '이메일 로그인', signup: '회원가입', forgot: '비밀번호 찾기', reset: '비밀번호 재설정' };

export function guideForRoute(route = 'intro', { session, section } = {}) {
  const base = String(route).replace(/^#\//, '').split('?')[0] || 'intro';
  if (base === 'resume' && section === 'resume-examples' && memberOf(session)) return {
    title: '가상 이력서 체험',
    items: [
      hint('example-search', '직무·기술·경력 검색', '검색어를 입력하면 해당하는 가상 이력서만 표시됩니다.', ['#resume-examples[open] [data-example-search]'], 'bottom'),
      hint('example-random', '무작위로 체험하기', '현재 검색 결과 중 하나를 무작위로 골라 내 계정의 이력서로 저장합니다.', ['#resume-examples[open] [data-resume-random]'], 'left'),
      hint('example-select', '직접 골라 불러오기', '원하는 카드의 이 버튼을 누르면 이력서가 저장됩니다. 기존 내용이 있으면 교체 여부를 먼저 확인합니다.', ['#resume-examples[open] [data-resume-example]'], 'right'),
      hint('example-pages', '다른 가상 이력서 보기', '이전·다음 버튼으로 다른 이력서들을 확인합니다. 검색 결과가 없으면 검색어를 바꿔 보세요.', ['#resume-examples[open] .resume-example-pagination'], 'top'),
    ],
  };
  const key = base.startsWith('reports/') ? 'result'
    : base === 'jobs/new' || /^jobs\/[^/]+\/edit$/.test(base) ? 'posting-editor'
    : /^jobs\/[^/]+$/.test(base) ? 'job-detail'
    : base === 'job' ? 'desired-role' : base;
  let title, items;
  if (authTitles[key]) { title = authTitles[key]; items = authHints(key, session); }
  else if (key === 'resume') { title = '이력서 준비'; items = resumeHints(memberOf(session)); }
  else if (key === 'result') { title = '분석 보고서'; items = resultHints(memberOf(session)); }
  else if (key === 'posting-editor') { title = base.endsWith('/edit') ? '시연 공고 수정' : '시연 공고 작성'; items = postingEditorHints(session); }
  else [title, items] = pages[key] || pages.intro;
  return { title, items: [...commonHints(key, session), ...items] };
}
