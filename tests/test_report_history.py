"""Account report-history queries keep server ownership and filter before paging."""
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.routes.api import router, user


def test_completed_history_is_owner_scoped_and_filters_before_pagination():
    owner = str(uuid4())
    rows = [
        {'id': str(uuid4()), 'user_id': owner, 'status': 'failed'} for _ in range(25)
    ] + [{'id': str(uuid4()), 'user_id': owner, 'status': 'completed'},
         {'id': str(uuid4()), 'user_id': owner, 'status': 'partial'},
         {'id': str(uuid4()), 'user_id': str(uuid4()), 'status': 'completed'}]
    calls = []

    class DB:
        async def select(self, table, **params):
            calls.append((table, params))
            selected = [row for row in rows if row['user_id'] == params['user_id'][3:]]
            if params.get('status') == 'in.(completed,partial)':
                selected = [row for row in selected if row['status'] in {'completed', 'partial'}]
            return selected[params['offset']:params['offset'] + params['limit']]

    application = FastAPI()
    application.include_router(router)
    application.state.db, application.state.llm, application.state.config = DB(), None, SimpleNamespace()
    application.dependency_overrides[user] = lambda: owner
    with TestClient(application) as client:
        first = client.get('/api/v1/evaluations?completed_only=true&limit=1&offset=0')
        second = client.get('/api/v1/evaluations?completed_only=true&limit=1&offset=1')
        ordinary = client.get('/api/v1/evaluations?limit=1&offset=0')
    assert [first.json()[0]['status'], second.json()[0]['status']] == ['completed', 'partial']
    assert ordinary.json()[0]['status'] == 'failed'
    assert all(call[1]['user_id'] == f'eq.{owner}' for call in calls)
    assert calls[0][1]['order'] == 'created_at.desc,id.desc'
    assert 'status' not in calls[2][1]


def test_report_history_requires_authentication():
    application = FastAPI()
    application.include_router(router)
    with TestClient(application) as client:
        assert client.get('/api/v1/evaluations?completed_only=true').status_code == 401
