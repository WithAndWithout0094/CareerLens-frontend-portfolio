# CareerLens Frontend

AI를 활용해 프론트엔드 화면과 사용자 흐름을 구현한 개인 포트폴리오입니다. 팀의 기존 분석 백엔드에 동시 분석 처리, 실행 보고서 집계, Redis를 이용한 여러 사용자 상태 관찰을 연결했습니다. 개인 GitHub 저장소를 소스로 본인 Render 계정에 직접 배포합니다. 기존 백엔드의 작성 범위와 개인 수정 사항은 [전체 저장소 README](../README.md)에 구분하여 기록합니다. HTML/CSS와 브라우저 ES module을 사용하며 화면 실행에 npm 빌드는 필요하지 않습니다.

## 실행

기본 실행 방법은 [전체 저장소 README](../README.md)입니다. 루트에서 의존성을 설치하고 `uvicorn app.main:app` 하나를 실행하면 화면·API·평가 워커가 같은 주소에서 작동합니다. 별도 `CareerLens-backend` 폴더나 `start.bat`은 필요하지 않습니다.

루트 `.env`에 현재 PostgreSQL·JWT·모델 설정을 둡니다. 프론트 전용 옵션과 배포 구조는 [통합 안내](../docs/frontend-integration.md)를 참고하세요. `frontend/.env.example`은 선택적으로 `server.py`를 따로 실행하는 개발용 설정 예시이며 통합 실행의 기본 설정 파일은 루트 `.env`입니다.

개인 Render 서비스는 [개인 배포 Blueprint](../blueprints/personal-free.yaml)의 통합 실행을 사용합니다. 팀 저장소와 별도로 관리하는 개인 저장소에서 배포합니다.

## 화면과 결과

이력서 → 채용공고 → 모의지원 흐름과 공고를 먼저 선택하는 경로를 지원합니다. 회원 분석은 기존 평가 API·워커가 실행하고 실제 진행률을 전달합니다. 최종 보고서 수신이 확인되어야 완료 화면을 엽니다. 보고서 점수 표시는 정수로 반올림하지만 저장값과 계산값은 바꾸지 않습니다.

첫 화면에서 AI를 활용한 프론트엔드 포트폴리오임을 바로 안내합니다. 페이지를 이동할 때마다 해당 페이지의 기능을 한 번에 설명하는 안내가 표시되며, 화면 어디든 누르거나 Esc를 누르면 함께 닫힙니다. 상단 **이 페이지 기능 안내**로 다시 열 수 있습니다. 회원의 **랜덤 가상 이력서 체험하기**와 직무별 가상 이력서는 프로젝트의 `app/modules/resumes/이력서_50개/가상_이력서_50개`에 있는 실제 합성 Markdown 파일을 불러옵니다.

비회원도 실제 분석을 먼저 수행합니다. `guest_analysis_engine.py`가 루트 `app/`의 파서·그래프·채점·보고서 엔진을 사용하며 임시 결과는 프론트 서버에 보관합니다. 인증 전에는 본문·점수를 브라우저로 전달하지 않습니다. 로그인·가입 성공 후 같은 결과를 계정에 연결하고 두 번째 분석을 시작하지 않습니다.

모델 설정이나 의존성이 없으면 연결 오류를 표시합니다. `CAREERLENS_GUEST_ANALYSIS=0`은 새 비회원 분석을 끄며 회원 API의 인증이나 기존 보고서 소유권을 바꾸지 않습니다. 기본 비회원 결과 저장 위치는 `.runtime/guest-reports.sqlite3`이며 배포 시 보존 범위는 [통합 안내](../docs/frontend-integration.md#결과-저장과-배포)를 확인하세요.

## 공개 대시보드와 이용 흐름

대시보드와 **관리자용 이용 흐름 모니터링 페이지**는 채용 담당자와 방문자가 로그인 없이 읽기 전용으로 체험할 수 있습니다. `/api/v1/admin/evaluation-performance`, `/api/v1/admin/execution-reports`, `/api/v1/admin/activity-flow`의 공개 응답에는 실행 상태·소요 시간·단계·집계처럼 허용된 운영 정보만 포함합니다. 개인 이력서, 평가 점수, 보고서 원문과 인증 정보는 공개하지 않습니다. 본인의 상세 분석 보고서는 로그인 후 마이페이지에서 확인합니다.

기존 `data/private/evaluation_execution_reports`의 Markdown은 `scripts/prepare_execution_import.py`로 허용된 실행 지표만 추출하고 관리자 가져오기 API를 통해 PostgreSQL에 저장합니다. 개인 PC 경로를 배포 서버가 직접 읽거나 원문을 공개 저장소에 올리지 않습니다. 배포 이후 생성된 회원 분석 실행 보고서도 PostgreSQL의 기록으로 집계하며, 대시보드에서 기존 가져오기 자료와 배포 실행 기록의 출처를 구분합니다. Render의 임시 로컬 파일이 없어져도 DB에 저장된 운영 요약을 조회할 수 있습니다.

이용 흐름은 서버가 Redis로 공유한 여러 사용자의 분석 상태를 조회합니다. 이전의 같은 브라우저 작업 창만 관찰하는 화면에서 공개 서버 모니터링으로 확장했습니다. 시작·진행·완료·실패는 서버가 제공한 실제 상태를 사용하고 연결 장애는 별도로 표시합니다. 입력 원문·보고서 본문·토큰은 관찰 이벤트에 담지 않습니다. **결과 확인**을 누르면 이용 흐름만 별도 팝업으로 열리며, 기존 창의 분석 로딩과 결과 전환은 그대로 이어집니다. 브라우저가 팝업을 차단한 경우 상단 **이용 흐름 새 창**에서 다시 열 수 있습니다.

## 코드와 검증

| 위치 | 역할 |
| --- | --- |
| `src/app`, `src/pages` | 라우팅·상태·화면 |
| `src/features` | 인증·작업·보고서·모션 |
| `src/shared/api` | 회원 API·비회원 결과 어댑터 |
| `server.py` | 프론트 로컬 API·독립 실행 서버 |
| `backend_location.py` | 전체 저장소 및 기존 형제 저장소의 엔진 경로 확인 |
| `guest_analysis_engine.py`, `guest_analysis_service.py` | 실제 계산·임시 저장·인증 후 연결 |

`frontend` 폴더에서 실행합니다.

```powershell
../.venv/Scripts/python.exe -m pytest -q tests
npm ci --prefix tools/matching-eye --ignore-scripts
node --test tests/unit/*.test.mjs
```

`npm ci`는 JavaScript 테스트의 Three.js 의존성 설치용이며 서비스 실행에는 필요하지 않습니다. Python 테스트는 pytest 함수와 unittest 클래스를 모두 실행합니다. 테스트는 합성 자료·가짜 제공자 응답을 사용합니다. 실제 운영 DB나 모델 분석 성공 여부는 별도 확인 대상입니다. 이 폴더의 이전 배포 문서와 계약 snapshot은 과거 구조를 포함하므로 현재 실행·설정은 전체 저장소 안내를 우선합니다.
