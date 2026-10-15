"""Profile contract regressions using an isolated API and in-memory accounts.

No application lifespan, real database, model client, or production credentials
are involved. Both account records carry extra private fields so the API must
explicitly project its public profile response.
"""

import time
from types import SimpleNamespace
from uuid import uuid4

import jwt
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api.v1.routes.api import router


PROFILE_FIELDS = {'user_id', 'display_name', 'email', 'is_admin'}


class ProfileDatabase:
    def __init__(self):
        self.accounts = {}
        self.profiles = {}
        self.refresh_tokens = []
        self.writes = []

    def seed(self, *, email, name):
        uid = str(uuid4())
        self.accounts[uid] = {
            'id': uid,
            'email': email,
            'password_hash': 'PRIVATE_ACCOUNT_HASH',
            'internal_note': 'PRIVATE_ACCOUNT_NOTE',
        }
        self.profiles[uid] = {
            'user_id': uid,
            'display_name': name,
            'resume_text': 'PRIVATE_RESUME_CONTENT',
            'is_admin': True,
        }
        return uid

    async def create_account(self, email, password_hash, display_name=None):
        uid = self.seed(email=email, name=display_name)
        self.accounts[uid]['password_hash'] = password_hash
        self.writes.append(('create_account', uid, display_name))
        return dict(self.accounts[uid])

    async def select(self, table, **params):
        records = self.profiles if table == 'profiles' else self.accounts
        key = 'user_id' if table == 'profiles' else 'id'
        rows = list(records.values())
        for field in (key, 'email'):
            if field in params:
                expected = params[field].removeprefix('eq.')
                rows = [row for row in rows if row.get(field) == expected]
        # Deliberately do not apply the column projection: the route must never
        # return unrelated private data even if a storage adapter adds fields.
        return [dict(row) for row in rows[:params.get('limit', len(rows))]]

    async def insert(self, table, values):
        assert table == 'refresh_tokens'
        self.refresh_tokens.append(dict(values))
        return [dict(values)]

    async def update(self, table, values, **params):
        assert table == 'profiles'
        self.writes.append(('update', table, dict(values), dict(params)))
        uid = params.get('user_id', '').removeprefix('eq.')
        if uid not in self.profiles:
            return []
        self.profiles[uid].update(values)
        return [dict(self.profiles[uid])]


@pytest.fixture
def profile_api():
    database = ProfileDatabase()
    config = SimpleNamespace(
        jwt_secret_key=SecretStr('profile-regression-only-' + 'x' * 40),
        jwt_issuer='profile-regression',
        access_token_seconds=900,
        refresh_token_days=30,
        admin_user_ids='',
    )
    isolated_app = FastAPI()
    isolated_app.include_router(router)
    isolated_app.state.db = database
    isolated_app.state.llm = None
    isolated_app.state.config = config

    def headers(uid):
        now = int(time.time())
        token = jwt.encode(
            {'sub': uid, 'iat': now, 'exp': now + 900, 'iss': config.jwt_issuer},
            config.jwt_secret_key.get_secret_value(),
            algorithm='HS256',
        )
        return {'Authorization': f'Bearer {token}'}

    with TestClient(isolated_app) as client:
        yield SimpleNamespace(client=client, database=database, headers=headers)


def test_signup_name_is_stored_and_returned_by_authenticated_profile(profile_api):
    response = profile_api.client.post('/api/v1/auth/signup', json={
        'email': 'New.Member@Example.test',
        'password': 'test-only-password',
        'name': '  홍 길동  ',
    })
    assert response.status_code == 201
    signup = response.json()
    assert set(signup) == {
        'user_id', 'access_token', 'refresh_token', 'email_confirmation_required',
    }
    assert profile_api.database.profiles[signup['user_id']]['display_name'] == '홍 길동'
    response = profile_api.client.get('/api/v1/me', headers={
        'Authorization': f"Bearer {signup['access_token']}",
    })
    assert response.status_code == 200
    assert response.json() == {
        'user_id': signup['user_id'], 'display_name': '홍 길동',
        'email': 'new.member@example.test', 'is_admin': False,
    }
    assert response.headers['cache-control'] == 'no-store'


def test_legacy_signup_without_name_does_not_invent_a_display_name(profile_api):
    response = profile_api.client.post('/api/v1/auth/signup', json={
        'email': 'legacy@example.test', 'password': 'test-only-password',
    })
    assert response.status_code == 201
    account = response.json()
    profile = profile_api.client.get('/api/v1/me', headers={
        'Authorization': f"Bearer {account['access_token']}",
    })
    assert profile.status_code == 200
    assert profile.json()['display_name'] is None
    assert profile.json()['email'] == 'legacy@example.test'


def test_me_only_returns_current_accounts_name_and_email(profile_api):
    own = profile_api.database.seed(email='self@example.test', name='내 이름')
    other = profile_api.database.seed(email='other@example.test', name='다른 사람')
    response = profile_api.client.get(
        f'/api/v1/me?user_id={other}', headers=profile_api.headers(own),
    )
    assert response.status_code == 200
    assert response.json() == {
        'user_id': own, 'display_name': '내 이름',
        'email': 'self@example.test', 'is_admin': False,
    }
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE_' not in response.text
    assert other not in response.text
    assert 'other@example.test' not in response.text


def test_patch_name_is_persisted_for_authenticated_account_only(profile_api):
    own = profile_api.database.seed(email='self@example.test', name=None)
    other = profile_api.database.seed(email='other@example.test', name='다른 사람')
    response = profile_api.client.patch(
        '/api/v1/me', json={'name': '  새 이름  '}, headers=profile_api.headers(own),
    )
    assert response.status_code == 200
    assert response.json() == {
        'user_id': own, 'display_name': '새 이름',
        'email': 'self@example.test', 'is_admin': False,
    }
    assert set(response.json()) == PROFILE_FIELDS
    assert response.headers['cache-control'] == 'no-store'
    assert 'PRIVATE_' not in response.text
    assert profile_api.database.writes == [
        ('update', 'profiles', {'display_name': '새 이름'}, {'user_id': f'eq.{own}'}),
    ]
    assert profile_api.database.profiles[other]['display_name'] == '다른 사람'
    reopened = profile_api.client.get('/api/v1/me', headers=profile_api.headers(own))
    assert reopened.json() == response.json()


@pytest.mark.parametrize('name', ['', '   ', '가' * 81, '이\x00름', '이\n름', '이\x7f름', 12, {}])
def test_signup_rejects_invalid_names_without_creating_account(profile_api, name):
    response = profile_api.client.post('/api/v1/auth/signup', json={
        'email': 'new@example.test', 'password': 'test-only-password', 'name': name,
    })
    assert response.status_code == 422
    assert profile_api.database.accounts == {}
    assert profile_api.database.writes == []


@pytest.mark.parametrize('body', [
    {}, {'name': None}, {'name': ''}, {'name': '   '}, {'name': '가' * 81},
    {'name': '이\x00름'}, {'name': '이\n름'}, {'name': '이\x7f름'},
    {'name': 12}, {'name': {}},
])
def test_patch_rejects_missing_or_invalid_name_without_changing_profile(profile_api, body):
    own = profile_api.database.seed(email='self@example.test', name='기존 이름')
    response = profile_api.client.patch(
        '/api/v1/me', json=body, headers=profile_api.headers(own),
    )
    assert response.status_code == 422
    assert profile_api.database.profiles[own]['display_name'] == '기존 이름'
    assert profile_api.database.writes == []


@pytest.mark.parametrize('extra', ['user_id', 'id', 'email', 'display_name', 'is_admin', 'password_hash'])
def test_patch_rejects_forged_targets_and_uneditable_fields(profile_api, extra):
    own = profile_api.database.seed(email='self@example.test', name='기존 이름')
    other = profile_api.database.seed(email='other@example.test', name='다른 사람')
    response = profile_api.client.patch(
        '/api/v1/me', json={'name': '변경 이름', extra: other}, headers=profile_api.headers(own),
    )
    assert response.status_code == 422
    assert profile_api.database.profiles[own]['display_name'] == '기존 이름'
    assert profile_api.database.profiles[other]['display_name'] == '다른 사람'
    assert profile_api.database.writes == []


@pytest.mark.parametrize('method', ['get', 'patch'])
def test_profile_requires_authentication(profile_api, method):
    own = profile_api.database.seed(email='self@example.test', name='기존 이름')
    kwargs = {'json': {'name': '변경 이름'}} if method == 'patch' else {}
    response = getattr(profile_api.client, method)('/api/v1/me', **kwargs)
    assert response.status_code == 401
    assert profile_api.database.profiles[own]['display_name'] == '기존 이름'
    assert profile_api.database.writes == []


@pytest.mark.parametrize('method', ['get', 'patch'])
def test_deleted_account_cannot_read_or_create_a_profile(profile_api, method):
    kwargs = {'json': {'name': '변경 이름'}} if method == 'patch' else {}
    response = getattr(profile_api.client, method)(
        '/api/v1/me', headers=profile_api.headers(str(uuid4())), **kwargs,
    )
    assert response.status_code == 401
    assert profile_api.database.writes == []
