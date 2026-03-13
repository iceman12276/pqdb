"""FastAPI application factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pqdb_api.config import Settings
from pqdb_api.database import dispose_engine, init_engine
from pqdb_api.logging import setup_logging
from pqdb_api.routes.health import router as health_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage application startup and shutdown."""
    settings: Settings = app.state.settings
    setup_logging(debug=settings.debug)
    init_engine(settings.database_url)
    yield
    await dispose_engine()


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    if settings is None:
        settings = Settings()

    app = FastAPI(title="pqdb", lifespan=lifespan)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health_router)

    return app
