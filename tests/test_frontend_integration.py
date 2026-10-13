"""Fullstack routing checks without database, network or model calls."""

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from app.frontend import mount_frontend


@pytest.fixture
def web(monkeypatch, tmp_path):
    monkeypatch.setenv("PORT", "8123")
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://careerlens.example")
    monkeypatch.setenv("CAREERLENS_GUEST_STORE_PATH", str(tmp_path / "guest.sqlite3"))
    app = FastAPI()

    @app.get("/healthz")
    def health():
        return {"service": "backend"}

    @app.get("/api/v1/jobs")
    def jobs():
        return [{"id": "native-backend-route"}]

    @app.get("/api/v1/admin/evaluation-performance")
    def protected_dashboard():
        raise HTTPException(status_code=401, detail="Authentication required")

    frontend = mount_frontend(app)
    frontend.extensions["guest_analysis"].available = lambda: True

    def no_proxy(**kwargs):
        raise AssertionError("An API request reached the standalone HTTP proxy")

    frontend.view_functions["api"] = no_proxy
    with TestClient(app, base_url="https://careerlens.example") as client:
        yield client, frontend
    frontend.extensions["guest_analysis"].shutdown(wait=False)


def test_same_origin_serves_page_assets_and_guest_capability(web):
    client, _ = web
    page = client.get("/")
    assert page.status_code == 200
    assert "text/html" in page.headers["content-type"]
    script = client.get("/src/app/main.js")
    assert script.status_code == 200
    assert "selectPosting" in script.text
    capability = client.get("/api/v1/local-guest/capabilities")
    assert capability.json()["available"] is True
    assert capability.json()["storage_origin"] == "frontend_guest"
    assert "Secure" in capability.headers["set-cookie"]
    assert "HttpOnly" in capability.headers["set-cookie"]
    assert "SameSite=Strict" in capability.headers["set-cookie"]


def test_native_api_and_authentication_take_precedence(web):
    client, _ = web
    assert client.get("/healthz").json() == {"service": "backend"}
    assert client.get("/api/v1/jobs").json() == [{"id": "native-backend-route"}]
    assert client.get("/api/v1/admin/evaluation-performance").status_code == 401


@pytest.mark.parametrize("path", [
    "/api/v1/auth/session", "/api/v1/unknown", "/api/v1/local-guest/unknown",
    "/api/v1/local-data/unknown", "/api", "/api/unknown",
    "/api/v1/local-data//jobs", "/api/v1/LOCAL-GUEST/capabilities",
])
def test_unsupported_api_never_loops_through_http_proxy(web, path):
    client, _ = web
    response = client.get(path)
    assert response.status_code == 404
    assert response.json() == {"detail": "Not Found"}


def test_guest_request_validation_and_report_authentication(web):
    client, _ = web
    # Invalid input cannot enqueue a computation or touch the model.
    assert client.post("/api/v1/local-guest/analyses", json={}).status_code == 400
    assert client.get("/api/v1/local-guest/reports").status_code == 401
    assert client.post("/api/v1/local-guest/analyses/00000000-0000-0000-0000-000000000000/claim", json={}).status_code == 401


def test_frontend_job_alias_preserves_query_and_authorization(web):
    from urllib.parse import parse_qs

    client, frontend = web
    frontend.extensions["job_catalog"].page = lambda query, authorization: {"query": parse_qs(query), "authorization": authorization}
    response = client.get("/api/v1/local-data/jobs?limit=7&offset=2", headers={"Authorization": "Bearer synthetic-test-token"})
    assert response.status_code == 200
    assert response.json() == {"query": {"limit": ["7"], "offset": ["2"], "include_details": ["true"]},
                               "authorization": "Bearer synthetic-test-token"}


@pytest.mark.parametrize("path", [
    "/.env", "/.git/config", "/.runtime/guest-reports.sqlite3",
    "/server.py", "/src/%2e%2e/server.py",
])
def test_private_files_are_not_published(web, path):
    client, _ = web
    assert client.get(path).status_code == 404


def test_untrusted_host_is_rejected(web):
    client, _ = web
    assert client.get("/", headers={"Host": "untrusted.example"}).status_code == 400


def test_wsgi_body_buffer_respects_frontend_upload_limit(web):
    client, frontend = web
    frontend.config["MAX_CONTENT_LENGTH"] = 32
    response = client.post("/api/v1/local-data/convert-resume", content=(b"x" * 20 for _ in range(3)))
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "file_too_large"


@pytest.mark.parametrize("port", ["0", "65536", "bad", "8000/path"])
def test_internal_backend_port_is_validated(monkeypatch, port):
    monkeypatch.setenv("PORT", port)
    with pytest.raises(ValueError, match="PORT"):
        mount_frontend(FastAPI())


def test_production_entrypoint_keeps_health_and_frontend(monkeypatch):
    monkeypatch.setenv("PORT", "8000")
    from app.main import app

    # No context manager: startup/lifespan (DB and worker) is not invoked.
    client = TestClient(app)
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/", headers={"Host": "localhost"}).status_code == 200
    assert client.get("/api/v1/auth/session").status_code == 404


def test_integrated_startup_ignores_standalone_backend_url():
    """Use a fresh process so import-time factory side effects cannot be cached."""
    import os
    from pathlib import Path
    import subprocess
    import sys

    environment = {
        **os.environ,
        "RENDER": "true",
        "BACKEND_URL": "http://127.0.0.1:5301",
        "PORT": "8000",
    }
    result = subprocess.run(
        [sys.executable, "-c", "from app.main import app; assert app.state.frontend.test_client().get('/health').json['backend_configured'] is True"],
        cwd=Path(__file__).resolve().parents[1], env=environment,
        capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.asyncio
async def test_frontend_shutdown_runs_even_when_backend_cleanup_fails(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from app import main

    class FakeDB:
        def __init__(self, config):
            pass

        async def open(self):
            pass

        async def close(self):
            raise RuntimeError("synthetic cleanup failure")

    async def worker(*args):
        await asyncio.Event().wait()

    shutdown = []
    config = SimpleNamespace(auth_enabled=True, jwt_secret_key=SimpleNamespace(get_secret_value=lambda: "x" * 32))
    monkeypatch.setattr(main, "settings", lambda: config)
    monkeypatch.setattr(main, "DB", FakeDB)
    monkeypatch.setattr(main, "LLM", lambda config: object())
    monkeypatch.setattr(main, "run_worker", worker)
    application = FastAPI()
    application.state.frontend = SimpleNamespace(extensions={"guest_analysis": SimpleNamespace(shutdown=lambda **kwargs: shutdown.append(kwargs))})
    with pytest.raises(RuntimeError, match="synthetic cleanup failure"):
        async with main.lifespan(application):
            pass
    assert shutdown == [{"wait": False}]
