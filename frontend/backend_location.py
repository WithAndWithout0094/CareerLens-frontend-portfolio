"""Locate backend source in the supported, repository-owned layouts."""

from pathlib import Path


def resolve_backend_root(frontend_root: Path) -> Path:
    parent = frontend_root.resolve().parent
    if (parent / "app" / "__init__.py").is_file():
        return parent
    return parent / "CareerLens-backend"
