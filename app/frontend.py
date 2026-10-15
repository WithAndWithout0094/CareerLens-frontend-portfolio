"""Serve the frontend alongside the existing API in one ASGI process."""

import os
from pathlib import Path

from starlette.middleware.wsgi import WSGIMiddleware
from starlette.responses import JSONResponse
from werkzeug.exceptions import MethodNotAllowed, NotFound
from werkzeug.routing import RequestRedirect


FRONTEND_ROOT = Path(__file__).resolve().parents[1] / "frontend"
LOCAL_API_PREFIXES = ("/api/v1/local-guest", "/api/v1/local-data")


class _BodyLimitExceeded(Exception):
    pass


class FrontendBoundary:
    """Keep unsupported API requests out of the standalone HTTP proxy.

    Backend routes are registered before this root mount. Only frontend-owned
    API routes reach Flask, so /auth/session stays a 404 for contract discovery
    and no unknown URL can loop back through the internal backend connection.
    """

    def __init__(self, application):
        self.application = application
        self.wsgi = WSGIMiddleware(application)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return
        path = scope["path"]
        if path == "/api" or path.startswith("/api/"):
            local = any(path == prefix or path.startswith(prefix + "/") for prefix in LOCAL_API_PREFIXES)
            endpoint = None
            if local:
                try:
                    endpoint, _ = self.application.url_map.bind("localhost").match(path, method=scope["method"])
                except (NotFound, RequestRedirect):
                    pass
                except MethodNotAllowed as error:
                    response = JSONResponse({"detail": "Method Not Allowed"}, status_code=405,
                                            headers={"Allow": ", ".join(error.valid_methods or [])})
                    await response(scope, receive, send)
                    return
            if not local or endpoint in {None, "api"}:
                await JSONResponse({"detail": "Not Found"}, status_code=404)(scope, receive, send)
                return
        # WSGIMiddleware buffers the body before Flask can enforce its limit.
        # Bound chunked requests here too, before that buffer can grow further.
        body_size = 0
        body_limit = self.application.config["MAX_CONTENT_LENGTH"]

        async def bounded_receive():
            nonlocal body_size
            message = await receive()
            if message["type"] == "http.request":
                body_size += len(message.get("body", b""))
                if body_size > body_limit:
                    raise _BodyLimitExceeded()
            return message

        try:
            await self.wsgi(scope, bounded_receive, send)
        except _BodyLimitExceeded:
            await JSONResponse({"error": {"code": "file_too_large"}}, status_code=413)(scope, receive, send)


def mount_frontend(application):
    from frontend.server import create_app, load_local_env
    from app.infrastructure.flow_manifest import write_manifest

    # Existing Render services may retain an older dashboard build command.
    # Regenerate before serving static files as well as in the Blueprint build.
    # This compiles graph structure only; no evaluator, DB or API call is run.
    write_manifest()
    load_local_env(FRONTEND_ROOT.parent / ".env")
    raw_port = os.environ.get("PORT", "8000")
    if not raw_port.isascii() or not raw_port.isdecimal() or not 1 <= int(raw_port) <= 65535:
        raise ValueError("PORT must be an integer between 1 and 65535")
    frontend = create_app(f"http://127.0.0.1:{int(raw_port)}", integrated=True, internal_backend=True)
    application.state.frontend = frontend
    application.mount("/", FrontendBoundary(frontend), name="frontend")
    return frontend
