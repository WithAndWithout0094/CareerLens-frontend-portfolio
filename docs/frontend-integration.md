# 프론트 통합 안내

## 기준과 실행 구조

현재 통합 작업본은 `CareerLens-fullstack`의 `main` 커밋 `0ad148b`을 기준으로 기존 프론트 통합 작업과 회원 대시보드 API를 연결합니다. PostgreSQL·JWT·문서 파싱·UUID 및 날짜 직렬화 수정을 유지하며 대시보드에 계정 소유 실행 보고서 파일 조회를 추가합니다. 실행 구성은 화면·API·워커가 같은 Render 서비스에 있는 통합 방식입니다. 이 문서는 준비된 소스의 실행 방법이며 운영 배포 완료 기록이 아닙니다.

```text
브라우저 /                 → 프론트 화면·모션
브라우저 /api/v1/...       → 기존 FastAPI 회원 API
  /local-guest/...         → 프론트 비회원 계산·인증 후 결과 연결
  /member/...              → 현재 계정의 평가 대시보드 API
  /local-data/...          → 문서 변환·공고 자료·호환 대시보드·실행 보고서 파일
FastAPI lifespan          → PostgreSQL 연결·회원 평가 워커
비회원 엔진               → 루트 app/ 파서·그래프·채점·보고서
```

`app.main:app`가 기존 API 라우트 뒤에 프론트를 연결합니다. `/api/v1/auth/session`처럼 구현되지 않은 API는 404를 유지하여 프론트의 API 모드 판별이 작동합니다. 프론트가 제공하는 로컬 API만 별도 경계를 통과합니다. 같은 프로세스의 프론트 내부 요청은 `127.0.0.1:$PORT`로 연결합니다.

## 설정

설정 파일은 저장소 루트 `.env`입니다. 프로세스 환경변수가 파일보다 우선하며 키는 서버에서만 사용합니다.

| 설정 | 용도 |
| --- | --- |
| `DATABASE_URL` | 현재 PostgreSQL 연결 |
| `JWT_SECRET_KEY` | 현재 계정 인증 서명 키, 최소 32자 |
| `OPENAI_API_KEY` | 실제 분석 모델 호출 |
| `EMBEDDING_DIMENSIONS=1536` | 지원되는 비회원 임베딩 차원 |
| `PORT` | 통합 서버의 내부 연결 포트, Uvicorn 포트와 일치 |
| `FRONTEND_PUBLIC_ORIGIN` | 브라우저 주소, 사용자 지정 HTTPS 도메인도 여기 지정 |
| `CAREERLENS_GUEST_ANALYSIS` | `1` 기본, `0`이면 새 비회원 계산 중지 |
| `CAREERLENS_GUEST_STORE_PATH` | 선택 사항, 비회원 결과 SQLite 파일의 서버 경로 |
| `EVALUATION_EXECUTION_REPORT_DIR` | 백엔드가 실행 보고서 Markdown을 쓰는 서버 폴더 |
| `CAREERLENS_EXECUTION_REPORTS_DIR` | 프론트가 실행 보고서 Markdown을 읽는 서버 폴더, 위 경로와 일치 |

현재 계정·DB 연결에 Supabase URL·키를 넣지 않습니다. 이전 Supabase 계정·저장 자료가 현재 PostgreSQL로 자동 이전되지는 않습니다. 통합 실행은 내부 주소를 사용하므로 `BACKEND_URL`을 설정할 필요가 없습니다. `frontend/.env`와 `FRONTEND_PORT`는 독립 프론트 실행에만 해당합니다.

루트 `requirements.txt`는 `frontend/requirements.txt`도 설치합니다. 전체 저장소만 받아 실행할 수 있으며 형제 `CareerLens-backend` 폴더가 필요하지 않습니다. 이전 분리 저장소 방식의 엔진 경로는 호환 목적으로 지원합니다. 새 통합 실행에서 별도 `workers.evaluation` 프로세스를 추가하지 않습니다.

Windows 로컬 예시:

```powershell
$env:PORT = "5400"
$env:FRONTEND_PUBLIC_ORIGIN = "http://127.0.0.1:5400"
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5400 --loop app.core.asyncio:uvicorn_loop_factory
```

다른 포트를 사용하면 두 포트 값과 브라우저 주소를 함께 바꿉니다. Uvicorn `--port`는 `.env`의 `PORT`만으로 자동 변경되지 않습니다.

## 결과 저장과 배포

회원 API의 이력서·평가·보고서는 PostgreSQL에 저장됩니다. 비회원이 먼저 계산한 결과는 기본 `frontend/.runtime/guest-reports.sqlite3`에 저장되며 인증 후 연결한 결과도 이 저장소를 사용합니다. 해당 결과를 기존 회원 DB로 자동 이관하지 않습니다. 인증 전 결과 본문·점수는 반환하지 않습니다.

임시 파일 시스템만 사용하는 Render 구성에서는 프론트 SQLite 결과가 재시작·재배포 때 유지된다고 보장할 수 없습니다. 이미 사용할 수 있는 영속 디스크가 있다면 `CAREERLENS_GUEST_STORE_PATH`를 그 디스크의 파일 경로로 지정합니다. 이 통합은 디스크를 신규 생성하거나 유료 리소스를 신청하지 않습니다. 여러 인스턴스가 각자 별도 SQLite를 사용하면 결과·쿠키 연결이 공유되지 않으므로 현재 저장소 구성을 확인한 후 운영 범위를 정해야 합니다.

Render 통합 실행의 기존 팀 Blueprint는 `blueprints/team3.yaml`입니다. `aio2-team3`, `agentservice-team3`, `agent-db-team3` 이름과 기존 DB 연결·JWT 키를 유지합니다. 루트 `render.yaml`은 독립 환경용입니다. 두 구성의 `pip install -r requirements.txt` 및 `uvicorn app.main:app --host 0.0.0.0 --port $PORT`가 프론트까지 포함합니다. 이 구성에서는 별도 프론트 서비스나 별도 워커가 필요하지 않습니다.

`frontend/render.yaml`의 이전 프론트 전용 배포 정의는 통합 실행에 사용하지 않습니다. 운영 서비스의 배포 완료와 비회원 가용성은 실제 적용 후 확인해야 합니다. 이번 로컬 작업으로 GitHub나 운영 서비스가 자동 변경되지는 않습니다.

## 실행 보고서 파일 연결

대시보드에서 실제 평가가 만든 실행 기록 Markdown을 목록으로 조회하고 선택해 읽습니다. 기본 읽기 경로는 전체 저장소의 `data/private/evaluation_execution_reports`입니다. 이전 분리 저장소의 로컬 프론트에서는 형제 `CareerLens-backend/data/private/evaluation_execution_reports`를 사용합니다. 다른 폴더를 지정할 때 `CAREERLENS_EXECUTION_REPORTS_DIR`를 사용하며 요청 URL이나 브라우저에서 임의 파일 경로를 받지 않습니다.

목록 API는 `GET /api/v1/local-data/execution-reports?limit=100&offset=0`, 상세 API는 `GET /api/v1/local-data/execution-reports/{run_id}`입니다. 서버가 현재 계정을 검증하고 본인 `/evaluations` 목록에 있는 UUID 파일만 연결합니다. 상세 조회는 `/evaluations/{run_id}` 소유권을 다시 확인합니다. 파일의 평가 UUID와 선택 ID가 일치해야 하며 파일에 소유자 ID가 있으면 현재 계정과 비교합니다. 목록 페이지의 `has_more`와 `next_offset`으로 다음 평가 기록을 확인합니다.

파일은 읽기 전용입니다. 경로 탈출·심볼릭 링크·디렉터리 연결·하드 링크를 차단하고 읽기 크기를 제한합니다. 표시 내용에서 계정 식별자·키·토큰 등 인증정보를 가리며 응답을 캐시에 저장하지 않습니다. 사용자의 모델 응답과 근거 인용은 본인 보고서 열람 범위에서만 표시합니다.

Render 단일 서비스에서는 파일을 만드는 백엔드와 읽는 프론트가 같은 폴더를 사용해야 합니다. 기본 경로를 사용한다면 추가 경로 설정이 필요하지 않습니다. 이미 구성된 영속 디스크를 사용하는 경우 두 환경변수에 그 디스크의 같은 폴더를 지정합니다. 아래 경로는 예시이며 실제 존재하는 서버 경로로 바꿉니다.

```dotenv
EVALUATION_EXECUTION_REPORT_DIR=/existing-private-disk/evaluation_execution_reports
CAREERLENS_EXECUTION_REPORTS_DIR=/existing-private-disk/evaluation_execution_reports
```

개인 PC에 있는 Markdown은 Git이나 배포 서버로 자동 복사되지 않습니다. 임시 파일 시스템에만 둔 보고서는 재배포 후 사라질 수 있으며 폴더가 비어 있으면 파일 목록도 비어 있습니다. 새 경로 설정은 이미 생성된 파일을 옮기지 않으며 이전 파일의 이동이나 운영 리소스 생성도 자동 수행하지 않습니다.

| 보고서 종류 | 저장 위치·조회 기준 |
| --- | --- |
| 회원 평가 결과 | PostgreSQL, 기존 회원 결과·보고서 API |
| 비회원 계산 후 계정에 연결한 결과 | 프론트 SQLite, `CAREERLENS_GUEST_STORE_PATH` |
| 단계·LLM 실행 기록 Markdown | 위 실행 보고서 폴더, 현재 계정의 평가 소유권 |

실행 기록 파일이 없다는 이유로 회원 결과를 삭제하거나 새 유료 분석을 시작하지 않습니다. 파일 형식 검증과 실제 계정 API 연동 검증은 별도로 확인합니다.

## 다른 PC에서 다를 때

1. 같은 `CareerLens-fullstack` 브랜치·커밋을 사용하는지 확인합니다. 이전 분리 저장소의 `main` 또는 `sub-main/withandwithout` 이름만 맞추는 것으로는 같은 백엔드 버전이 보장되지 않습니다.
2. 루트 의존성을 서버가 실행되는 동일한 가상환경에 설치했는지 확인합니다. 프론트의 네 가지 패키지만 설치하면 실제 분석 엔진을 불러올 수 없습니다.
3. 루트 `.env` 또는 서버 환경에 현재 PostgreSQL·JWT·모델 설정이 있는지 확인합니다. 개인 `.env`는 Git으로 전달되지 않습니다.
4. `PORT`와 Uvicorn `--port`, 브라우저 주소가 일치하는지 확인합니다.
5. `/api/v1/local-guest/capabilities`의 `available`을 확인합니다. `true`는 엔진 import·설정 확인이며 실제 모델 응답·잔액·DB·완료 결과를 검사한 값은 아닙니다.

`/healthz`는 생존, `/health`는 DB 상태를 확인합니다. 비회원 계산 가능 여부와 보고서 열람 권한은 다릅니다. 현재 흐름은 로그인 전 계산, 로그인·가입 후 본문 표시입니다. 회원 보고서 API가 인증 없이 401을 반환하는 것은 의도된 동작입니다.

현재 백엔드는 `/api/v1/member/evaluation-performance`와 `/api/v1/local-data/member-performance`로 본인 평가를 조회합니다. 최신 main의 `/admin/evaluation-performance` 호환 동작도 유지하여 일반 회원에게는 본인 기록만 반환하고 전체 집계는 관리자에게만 허용합니다. 실행 보고서가 보이지 않으면 로그인 계정·백엔드 연결 대상·파일 존재 여부와 읽기/쓰기 경로 일치를 각각 확인합니다.

최신 main의 회원 DB 보고서 조회는 유지하면서, 이 통합본은 인증 후 계정에 연결한 비회원 저장 보고서도 목록에 포함합니다. 비회원 저장소를 제공하지 않는 백엔드에서는 회원 DB 목록만 조회합니다. 비회원 저장소를 제공하는 통합 실행에서는 내부 API 주소와 소유권 검증을 연결하여 두 종류의 저장 결과를 함께 복원합니다.
