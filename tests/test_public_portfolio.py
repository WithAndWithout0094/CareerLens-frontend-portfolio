"""Public operational summaries are separated from owner-only writes and reports."""
import time
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
import jwt
import pytest

from app.api.v1.routes.api import router
from app.application.execution_reports import summarize_markdown

RUN = '11111111-1111-4111-8111-111111111111'
OWNER = '22222222-2222-4222-8222-222222222222'
MEMBER = '33333333-3333-4333-8333-333333333333'
WHEN = '2026-10-13T01:00:00+00:00'
PRIVATE = 'PRIVATE_CANDIDATE_BODY_OR_PROVIDER_SECRET'
RAW = f'''# 평가 실행 기록
- 평가 run ID: `{RUN}`
- LLM 호출 수: 1
- 계측 단계 수: 1
## 단계별 소요 시간
| parse_resume | — | 1 | completed | 125 | — |
## LLM 호출 기록
| 1 | document_parse | resume | ParsedResume | 성공 | 125 | 20/5 |
### 호출 1
```json
{{"resume": "{PRIVATE}", "api_key": "{PRIVATE}"}}
```
'''


class FakeDB:
    def __init__(self):
        self.writes = []

    async def rpc(self, *_args):
        return {'runs': [{'id': RUN, 'status': 'completed', 'created_at': WHEN,
                          'user_id': OWNER, 'email': PRIVATE, 'original_text': PRIVATE, 'report': PRIVATE,
                          'total_ms': 125, 'stages': [{'stage': 'parse_resume', 'duration_ms': 125, 'status': 'completed',
                                                    'attempt_number': 1, 'details': {'response': PRIVATE}}]}]}

    async def select(self, table, **query):
        if table == 'admin_execution_imports':
            return []
        if table == 'intermediate_artifacts':
            return [{'run_id': RUN, 'created_at': WHEN, 'content': {'markdown': RAW}}]
        if table == 'evaluation_runs':
            return [{'id': RUN, 'status': 'completed', 'created_at': WHEN}]
        if table == 'evaluation_stage_timings':
            return [{'stage': 'parse_resume', 'duration_ms': 125, 'status': 'completed', 'attempt_number': 1}]
        raise AssertionError(table)

    async def upsert(self, table, rows, **_kwargs):
        self.writes.append((table, rows))


@pytest.fixture
def site():
    application = FastAPI()
    application.include_router(router)
    config = SimpleNamespace(jwt_secret_key=SecretStr('public-portfolio-test-' + 'x' * 40),
                             jwt_issuer='portfolio-test', admin_user_ids=OWNER)
    db = FakeDB()
    application.state.config, application.state.db, application.state.llm = config, db, None
    with TestClient(application) as client:
        yield client, config, db


def token(config, identity):
    now = int(time.time())
    encoded = jwt.encode({'sub': identity, 'iss': config.jwt_issuer, 'iat': now, 'exp': now + 60},
                         config.jwt_secret_key.get_secret_value(), algorithm='HS256')
    return {'Authorization': f'Bearer {encoded}'}


@pytest.mark.parametrize('path', [
    '/admin/evaluation-performance', f'/admin/evaluation-performance/{RUN}',
    '/admin/execution-reports', f'/admin/execution-reports/{RUN}',
])
def test_anonymous_reads_only_operational_metadata(site, path):
    client, _config, db = site
    response = client.get('/api/v1' + path)
    assert response.status_code == 200
    assert PRIVATE not in response.text
    assert OWNER not in response.text
    assert 'api_key' not in response.text and 'original_text' not in response.text
    assert db.writes == []


def test_import_requires_owner_role_and_projects_injected_fields(site):
    client, config, db = site
    summary = summarize_markdown(RAW, RUN)
    body = {'reports': [{'run_id': RUN, 'modified_at': WHEN, 'summary': {**summary, 'resume': PRIVATE}}]}
    endpoint = '/api/v1/admin/execution-reports/import'
    assert client.post(endpoint, json=body).status_code == 401
    assert client.post(endpoint, json=body, headers=token(config, MEMBER)).status_code == 403
    assert db.writes == []
    response = client.post(endpoint, json=body, headers=token(config, OWNER))
    assert response.status_code == 200 and response.json() == {'imported_count': 1}
    assert db.writes[0][0] == 'admin_execution_imports'
    assert PRIVATE not in str(db.writes)


def test_public_view_does_not_relax_personal_routes(site):
    client, _config, _db = site
    for path in ['/me', '/resumes', '/evaluations', f'/evaluations/{RUN}']:
        assert client.get('/api/v1' + path).status_code == 401


def test_native_public_routes_precede_frontend_catchall(monkeypatch):
    from app.main import app
    monkeypatch.setattr(app.state, 'db', FakeDB(), raising=False)
    # Do not enter lifespan: this verifies real routing without model/DB calls.
    client = TestClient(app)
    try:
        response = client.get('/api/v1/admin/execution-reports')
        assert response.status_code == 200
        assert response.json()['reports'][0]['source'] == 'deployed'
        assert 'text/html' not in response.headers['content-type']
    finally:
        client.close()
