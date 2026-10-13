import { icon } from '../shared/components/ui.js';

export function introductionPage() {
  return `
    <section class="introduction" aria-labelledby="introduction-title" data-introduction>
      <div class="introduction__topline">
        <span class="introduction__eyebrow">나의 다음 커리어를 보는 시간</span>
        <button type="button" class="button secondary compact" data-intro-skip>
          건너뛰기 ${icon('arrow', 16)}
        </button>
      </div>
      <div class="introduction__body">
        <div class="introduction__visual" aria-hidden="true" data-intro-journey></div>
        <div class="introduction__copy">
          <p class="introduction__wordmark">Career<span>Lens</span></p>
          <h1 id="introduction-title">경험을 살피고,<br />다음 기회를 준비하세요.</h1>
          <p class="introduction__description">AI를 활용해 구현한 프론트엔드 포트폴리오</p>
          <p class="portfolio-contribution"><strong>개인 작업:</strong> 화면·사용자 흐름 구현과 개인 GitHub / Render 직접 배포.<br><strong>기존 팀 백엔드에 추가한 개선:</strong> 동시 분석 처리, 실행 보고서 연동, Redis 상태 연결.<br><strong>관리자용 이용 흐름 모니터링 페이지</strong>와 대시보드는 개인정보를 제외한 읽기 전용 공개 체험으로 열어 두었습니다.</p>
        </div>
      </div>
      <div class="introduction__bottomline">
        <span class="introduction__progress" aria-hidden="true"><span></span></span>
        <p>잠시 후 이력서 화면으로 이동합니다.</p>
      </div>
    </section>
  `;
}
