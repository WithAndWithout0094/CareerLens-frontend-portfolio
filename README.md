# CareerLens · AI를 활용한 프론트엔드 포트폴리오

**신영석의 프론트엔드 구현 작업물입니다.** AI 도구를 활용해 화면, 인터랙션, 페이지별 안내, 분석 진행·결과 연결을 구현하고, 본인의 GitHub와 Render 계정으로 직접 배포했습니다.

[배포 사이트 체험](https://careerlens-personal-web.onrender.com) · [개인 GitHub](https://github.com/WithAndWithout0094/CareerLens-frontend-portfolio) · [기여 범위와 백엔드 변경 내역](docs/portfolio-contributions.md)

| 구분 | 작업 범위 |
| --- | --- |
| 주 작업: 프론트엔드 | HTML/CSS/JavaScript 화면, 이력서·공고·분석·보고서 흐름, 모션, 페이지별 기능 안내, 대시보드와 관찰 창 |
| AI 활용 | AI와 함께 구현·수정·테스트한 작업물이며 AI 사용 사실을 명시합니다. |
| 기존 팀 백엔드 | 인증, PostgreSQL 데이터 구조, LLM 평가·채점·보고서 엔진은 기존 팀 결과물을 기반으로 합니다. |
| 개인 추가 백엔드 수정 | 동시 분석 워커, Redis 상태 공유, 공개 운영 지표의 개인정보 제외, 실행 기록 조회·가져오기, 프로젝트 가상 이력서 연결 |
| 개인 배포 | 본인 GitHub 저장소에서 본인 Render 서비스로 배포하고 DB·환경변수·상태 점검을 구성했습니다. |

처음 열면 프론트엔드 작업 소개가 즉시 표시되며, 페이지를 이동할 때마다 해당 페이지 기능을 함께 안내합니다. 화면을 클릭하거나 Escape를 누르면 안내가 닫힙니다. **대시보드와 이용 흐름은 로그인 없이 공개 체험**할 수 있습니다. 개인 이력서·분석 결과·보고서 본문은 본인 계정으로만 확인합니다.

실제 분석에는 서버의 개인 OpenAI API 설정과 사용 가능한 크레딧이 필요합니다. 키는 서버 환경변수로만 관리하고 요청 횟수를 제한합니다. 키·개인 이력서·운영 보고서 원문은 이 공개 저장소에 포함하지 않습니다. CV 예시는 프로젝트용 가상 자료입니다.

---

프론트 화면, FastAPI, 평가 워커를 개인 Render 서비스에서 실행합니다. 기존 팀 통합본에 개인 포트폴리오 기능을 추가한 배포 소스이며, 현재 기여 범위는 [개인 변경 내역](docs/portfolio-contributions.md)을 참고하세요.

## 로컬 실행

Python 3.13 (`.python-version`)과 설정된 PostgreSQL DB가 필요합니다. 저장소 루트에서 실행합니다.

```powershell
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -r requirements.txt
Copy-Item .env.example .env
```

이미 `.env`가 있다면 복사하지 않고 기존 설정을 보존합니다. 루트 `.env`에 `DATABASE_URL`, 32자 이상의 `JWT_SECRET_KEY`, `OPENAI_API_KEY`를 설정합니다. 새 DB 초기화와 기존 DB를 구분하는 기준은 [백엔드 실행 안내](docs/backend-implementation.md)를 참고하세요. 프론트 연결을 위해 기존 DB를 초기화할 필요는 없습니다.

```powershell
$env:PORT = "5400"
$env:FRONTEND_PUBLIC_ORIGIN = "http://127.0.0.1:5400"
./.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5400 --loop app.core.asyncio:uvicorn_loop_factory
```

브라우저에서 [http://127.0.0.1:5400](http://127.0.0.1:5400)을 엽니다. `PORT`와 Uvicorn `--port`를 같은 값으로 지정해야 프론트 내부 API 연결이 맞습니다. 루트 의존성 설치에 프론트 의존성도 포함되며 별도 npm 빌드는 필요하지 않습니다. 평가 워커는 FastAPI가 시작하므로 별도 워커를 실행하지 않습니다.

## 분석과 인증

- 회원 분석과 저장 보고서는 기존 PostgreSQL API·워커를 사용합니다. 인증은 현재 백엔드의 이메일·비밀번호와 JWT를 사용합니다.
- 비회원 분석은 프론트 서버가 루트 `app/`의 실제 엔진으로 계산하고 비공개 임시 저장소에 결과를 보관합니다. 보고서 본문·점수는 로그인 또는 가입 후 인증을 확인하여 보여주며 재분석하지 않습니다.
- 비회원 엔진을 사용할 수 없으면 연결 오류를 표시합니다. 저장소를 받는 것만으로 모델 키나 DB 설정이 복사되지는 않습니다.
- 대시보드와 이용 흐름은 개인정보를 제외한 공개 운영 화면입니다. 이용 흐름은 Redis와 PostgreSQL의 실제 다중 사용자 실행 상태를 읽습니다.
- 대시보드의 실행 기록은 단계별 시간·LLM 호출 수 등 허용된 지표만 제공합니다. 모델 응답·이력서·개인 점수·보고서 원문은 공개 응답에 포함하지 않습니다.

## 배포와 확인

개인 무료 Render 구성은 [blueprints/personal-free.yaml](blueprints/personal-free.yaml)을 사용합니다. 개인 웹·PostgreSQL·Redis 호환 저장소를 명시하며 팀 서비스 이름과 구분합니다. `python -m scripts.bootstrap_personal_render`는 개인 DB의 초기화 확인과 추가 운영 요약 테이블 준비를 수행하고, `uvicorn app.main:app`이 화면과 API를 함께 제공합니다. 다른 Blueprint는 이전 구성의 참고 자료입니다.

`/healthz`는 프로세스 생존, `/health`는 DB 연결, `/api/v1/local-guest/capabilities`는 비회원 엔진의 의존성·설정 가용성을 확인합니다. 가용성 응답은 실제 모델 요청이나 분석 성공을 보증하지 않습니다.

비회원 결과의 기본 저장 위치는 `frontend/.runtime/guest-reports.sqlite3`입니다. 임시 파일 시스템의 배포에서는 재시작·재배포로 결과가 사라질 수 있습니다. 기존 영속 디스크를 사용할 때 `CAREERLENS_GUEST_STORE_PATH`를 그 디스크의 파일 경로로 지정합니다. 회원 API가 저장한 PostgreSQL 보고서와는 별도 저장소입니다.

새 실행 보고서는 PostgreSQL `intermediate_artifacts`에 저장된 기록에서 운영 요약을 읽어 대시보드에 반영합니다. PC의 기존 `data/private/evaluation_execution_reports/*.md`는 `scripts.prepare_execution_import`로 원문을 제외한 지표를 만든 뒤 소유자 인증이 필요한 가져오기 API로 저장합니다. 배포 서버가 개인 PC 폴더를 직접 읽는 방식이 아닙니다.

공개 분석은 전체 하루 60회·회원별 하루 10회, 비회원별 시간당 5회 이내로 제한하며 기존 비회원 접속별 제한도 유지합니다. Redis 사용량 검증에 실패하면 새 분석을 중지합니다. 요청 수 제한은 모델 요금의 금액 상한이 아니며 무료 Redis 재시작 시 카운터가 초기화될 수 있습니다. 개인 API 키는 Render 환경변수에만 저장합니다.

연결 구조, 환경변수, 다른 PC에서의 점검 순서는 [프론트 통합 안내](docs/frontend-integration.md), 화면 동작은 [프론트 README](frontend/README.md)를 참고하세요.

## 코드 위치와 검증

| 위치 | 역할 |
| --- | --- |
| `frontend/` | 화면·모션·API 어댑터·비회원 분석과 결과 연결 |
| `app/frontend.py` | 같은 프로세스에 프론트 연결·API 경계 |
| `app/api/`, `app/application/` | 회원 API·업무 흐름 |
| `app/agent/`, `app/modules/` | 분석 그래프·채점·보고서 |
| `app/infrastructure/database/` | PostgreSQL 연결 |
| `workers/` | FastAPI가 실행하는 평가 워커 |

```powershell
./.venv/Scripts/python.exe -m pytest -q
npm ci --prefix frontend/tools/matching-eye --ignore-scripts
Push-Location frontend
../.venv/Scripts/python.exe -m pytest -q tests
node --test tests/unit/*.test.mjs
Pop-Location
```

`npm ci`는 JavaScript 테스트에 필요한 Three.js 의존성을 설치합니다. 서비스 실행에는 npm 설치가 필요하지 않습니다. 합성 응답 기반 테스트와 실제 모델·DB 분석은 구분합니다. 이 실행 안내는 원격 DB 초기화, 실제 유료 분석, GitHub 게시 또는 운영 배포를 자동 수행하지 않습니다.

