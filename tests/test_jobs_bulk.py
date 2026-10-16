"""The real jobs route with an isolated DB; no worker, database or LLM calls."""
from copy import deepcopy
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.routes.api import router, user
from app.infrastructure.database.postgres import DatabaseError


def ident(index):
    return str(UUID(int=index + 1))


class CatalogDB:
    def __init__(self, size=105):
        self.calls = []
        self.failure = None
        self.rows = [{
            'id': ident(index), 'company_id': ident(1000 + index % 3),
            'title': f'공고 {index}', 'description': f'현재 서버 원문 {index}',
            'requirements': ['Python'], 'preferred_requirements': [],
            'responsibilities': ['API 개발'], 'location': '서울',
            'employment_type': '정규직', 'career_min_months': 0,
            'source_name': 'registered', 'source_external_id': f'{index}.md',
            'collected_at': '2026-10-16T00:00:00Z',
        } for index in range(size)]

    async def select(self, table, **params):
        self.calls.append((table, deepcopy(params)))
        if self.failure == table:
            raise DatabaseError()
        if table == 'companies':
            identifiers = params['id'][4:-1].split(',')
            return [{'id': value, 'name': f'회사 {value[-2:]}'} for value in identifiers]
        assert table == 'job_postings'
        rows = self.rows
        if params.get('company_id'):
            rows = [row for row in rows if row['company_id'] == params['company_id'][3:]]
        if params.get('id'):
            rows = [row for row in rows if row['id'] == params['id'][3:]]
        offset = params.get('offset', 0)
        rows = rows[offset:offset + params.get('limit', len(rows))]
        fields = params.get('select', '*')
        return deepcopy(rows if fields == '*' else [
            {key: value for key, value in row.items() if key in fields.split(',')} for row in rows
        ])


@pytest.fixture
def catalog():
    application = FastAPI()
    application.include_router(router)
    application.state.db = CatalogDB()
    application.state.llm = None
    application.state.config = SimpleNamespace()
    application.dependency_overrides[user] = lambda: ident(9000)
    with TestClient(application, raise_server_exceptions=False) as client:
        yield client, application.state.db, application


def test_optional_bulk_page_uses_two_queries_and_preserves_native_ids(catalog):
    client, db, _ = catalog
    response = client.get('/api/v1/jobs?limit=100&include_details=true')
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 100
    assert len(db.calls) == 2
    assert db.calls[0][1]['order'] == 'collected_at.desc,id.asc'
    assert db.calls[1][0] == 'companies'
    assert db.calls[1][1]['limit'] == 3
    assert db.calls[1][1]['select'] == 'id,name'
    assert rows[0]['id'] == ident(0)
    assert rows[0]['description'] == '현재 서버 원문 0'
    assert rows[0]['requirements'] == ['Python']
    assert rows[0]['companies']['name']
    assert 'companies' not in db.rows[0], 'bulk response must not mutate stored records'
    second = client.get('/api/v1/jobs?limit=100&offset=100&include_details=true').json()
    assert len(second) == 5
    assert not ({row['id'] for row in rows} & {row['id'] for row in second})
    detail = client.get('/api/v1/jobs/' + second[0]['id']).json()
    assert detail['id'] == second[0]['id']
    assert detail['description'] == second[0]['description']


def test_default_summary_contract_and_company_filter_remain_compatible(catalog):
    client, db, _ = catalog
    response = client.get('/api/v1/jobs?limit=2&offset=2&company_id=' + ident(1001))
    assert response.status_code == 200
    assert len(db.calls) == 1
    assert db.calls[0][1]['company_id'] == 'eq.' + ident(1001)
    assert len(response.json()) == 2
    assert all('description' not in row and 'companies' not in row for row in response.json())


def test_empty_page_skips_company_query_and_does_not_fabricate_rows(catalog):
    client, db, _ = catalog
    response = client.get('/api/v1/jobs?offset=1000&include_details=true')
    assert response.status_code == 200
    assert response.json() == []
    assert len(db.calls) == 1
    db.rows = [{**db.rows[0], 'company_id': None}]
    db.calls.clear()
    response = client.get('/api/v1/jobs?include_details=true')
    assert response.json()[0]['companies'] == {'name': ''}
    assert len(db.calls) == 1


@pytest.mark.parametrize('table', ['job_postings', 'companies'])
def test_upstream_failure_is_not_a_successful_empty_catalog(catalog, table):
    client, db, _ = catalog
    db.failure = table
    response = client.get('/api/v1/jobs?include_details=true')
    assert response.status_code == 500
    assert response.text != '[]'


def test_bulk_mode_keeps_auth_and_pagination_validation(catalog):
    client, db, application = catalog
    for query in ['limit=101', 'offset=-1', 'company_id=not-a-uuid']:
        assert client.get('/api/v1/jobs?include_details=true&' + query).status_code == 422
    assert db.calls == []
    application.dependency_overrides.clear()
    assert client.get('/api/v1/jobs?include_details=true').status_code == 401
    assert db.calls == []
