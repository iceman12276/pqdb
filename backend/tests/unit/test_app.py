"""Unit tests for FastAPI app factory."""

from fastapi import FastAPI
from starlette.routing import Route

from pqdb_api.app import create_app


def test_create_app_returns_fastapi_instance() -> None:
    app = create_app()
    assert isinstance(app, FastAPI)


def test_create_app_has_title() -> None:
    app = create_app()
    assert app.title == "pqdb"


def test_create_app_includes_health_routes() -> None:
    app = create_app()
    route_paths = [route.path for route in app.routes if isinstance(route, Route)]
    assert "/health" in route_paths
    assert "/ready" in route_paths


def test_create_app_has_cors_middleware() -> None:
    app = create_app()
    middleware_classes = [
        m.cls.__name__  # type: ignore[attr-defined]
        for m in app.user_middleware
    ]
    assert "CORSMiddleware" in middleware_classes
