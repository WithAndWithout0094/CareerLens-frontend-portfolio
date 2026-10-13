"""Standalone WSGI entrypoint for the optional frontend-only deployment."""

if __package__:
    from .server import create_app
else:
    from server import create_app

app = create_app()
