"""Deployment boundaries without real keys, models, databases or cloud resources."""
import os
from pathlib import Path
from unittest.mock import patch

import pytest
import server


def test_private_docker_api_requires_operator_allowlist():
    with patch.dict(os.environ, {"BACKEND_URL": "http://api:5301"}, clear=True):
        with pytest.raises(ValueError):
            server.create_app()
        with patch.dict(os.environ, {"CAREERLENS_INTERNAL_API_HOST": "api"}):
            app = server.create_app()
            assert app.test_client().get('/health').json['backend_configured']
            with pytest.raises(ValueError):
                server.create_app('http://untrusted:5301')


def test_tls_proxy_secure_cookie_and_durable_guest_path(tmp_path):
    path = tmp_path / 'persistent' / 'reports.sqlite3'
    values = {"BACKEND_URL": "http://api:5301", "CAREERLENS_INTERNAL_API_HOST": "api",
              "FRONTEND_PUBLIC_ORIGIN": "https://career.example.test", "CAREERLENS_TRUST_PROXY": "1",
              "CAREERLENS_GUEST_STORE_PATH": str(path)}
    with patch.dict(os.environ, values, clear=True), patch('server.engine_available', return_value=True):
        app = server.create_app()
        assert app.extensions['guest_analysis'].path == path
        client = app.test_client()
        response = client.get('/api/v1/local-guest/capabilities', base_url='http://career.example.test',
                              headers={'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '192.0.2.40'})
        assert response.status_code == 200
        assert 'Secure;' in response.headers['Set-Cookie']
        assert 'HttpOnly;' in response.headers['Set-Cookie']
        assert client.get('/health', base_url='https://attacker.example.test').status_code == 400
        assert not path.exists()  # A capability probe does not initialize/delete stored runs.


def test_default_local_server_does_not_trust_forwarded_proto():
    with patch.dict(os.environ, {}, clear=True):
        app = server.create_app('http://127.0.0.1:5301')
        response = app.test_client().get('/api/v1/local-guest/capabilities', headers={'X-Forwarded-Proto': 'https'})
        assert 'Secure;' not in response.headers['Set-Cookie']


def test_monorepo_deployment_keeps_one_api_worker_process_and_frontend_dependencies():
    import yaml
    root = Path(__file__).resolve().parents[2]
    standalone = yaml.safe_load((root / 'render.yaml').read_text(encoding='utf-8'))['services']
    team = yaml.safe_load((root / 'blueprints/team3.yaml').read_text(encoding='utf-8'))
    services = team['projects'][0]['environments'][0]['services']
    assert len(standalone) == len(services) == 1
    for service in standalone + services:
        assert service['startCommand'] == 'uvicorn app.main:app --host 0.0.0.0 --port $PORT'
        assert service['buildCommand'] == 'pip install -r requirements.txt'
    assert services[0]['name'] == 'agentservice-team3'
    assert '-r frontend/requirements.txt' in (root / 'requirements.txt').read_text()
