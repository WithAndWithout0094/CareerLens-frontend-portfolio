# CareerLens Render 통합 배포

현재 전체 저장소에서는 루트 FastAPI `app.main:app`가 프론트 화면·기존 회원 API·평가 워커를 함께 제공합니다. 이 파일의 이전 무료 프론트 전용 배포 절차는 현재 `frontend/render.yaml`에 적용하지 않습니다.

팀 서비스는 저장소 루트의 `blueprints/team3.yaml`, 독립 환경은 루트 `render.yaml`을 사용합니다. 기존 팀의 프로젝트·서비스·DB 이름과 DB 연결·JWT 키를 유지합니다. 이번 프론트 통합을 위해 별도 프론트 서비스·워커·디스크를 새로 만들 필요는 없습니다.

```sh
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

작업 디렉터리는 전체 저장소 루트입니다. 루트 의존성 설치에 프론트 의존성이 포함됩니다. 통합 실행에서는 `BACKEND_URL` 대신 같은 프로세스의 내부 API 연결을 사용하며 `PORT`와 Uvicorn 포트가 일치해야 합니다. 플랫폼 기본 공개 주소는 자동 허용하고, 별도 도메인은 `FRONTEND_PUBLIC_ORIGIN`에 지정합니다.

현재 서버 설정은 PostgreSQL `DATABASE_URL`, `JWT_SECRET_KEY`, `OPENAI_API_KEY`입니다. 기존 DB를 다시 초기화하거나 Supabase 설정으로 되돌리지 않습니다. 새 환경의 DB 준비와 기존 운영 서비스 설정은 [백엔드 안내](../../../docs/backend-implementation.md)를 참고하세요.

확인 경로는 `/`의 화면, `/healthz`의 프로세스 생존, `/health`의 DB 연결, `/api/v1/local-guest/capabilities`의 비회원 엔진 가용성입니다. 비회원 `available: true`는 실제 모델 요청·완료 결과까지 검증한 응답이 아닙니다. 회원 API의 인증과 보고서 소유권은 그대로 적용됩니다.

비회원 계산·계정 연결 결과는 기본 `frontend/.runtime/guest-reports.sqlite3`에 보관합니다. 임시 파일 시스템에서는 재배포 후 보존을 보장할 수 없으며 이미 구성된 영속 저장소가 있다면 `CAREERLENS_GUEST_STORE_PATH`를 사용합니다. 회원 API의 PostgreSQL 보고서와 이 저장소를 구분합니다.

실행 보고서 Markdown의 쓰기 경로 `EVALUATION_EXECUTION_REPORT_DIR`와 읽기 경로 `CAREERLENS_EXECUTION_REPORTS_DIR`는 같은 서버 폴더를 지정합니다. 기본값은 루트 `data/private/evaluation_execution_reports`이며 개인 PC 파일은 자동 복사되지 않습니다.

상세 연결 구조와 저장소 설정은 [프론트 통합 안내](../../../docs/frontend-integration.md)를 참고하세요. 소스 준비와 운영 배포 완료는 별도로 확인합니다.
