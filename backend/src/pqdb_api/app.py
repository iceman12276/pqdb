"""FastAPI application factory."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.config import Settings
from pqdb_api.database import dispose_engine, init_engine
from pqdb_api.logging import setup_logging
from pqdb_api.middleware.audit import AuditMiddleware
from pqdb_api.middleware.rate_limit import RateLimitMiddleware
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.auth_settings import router as auth_settings_router
from pqdb_api.routes.branches import router as branches_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.developer_oauth import router as developer_oauth_router
from pqdb_api.routes.google_oauth import router as google_oauth_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.indexes import router as indexes_router
from pqdb_api.routes.introspection import router as introspection_router
from pqdb_api.routes.logs import router as logs_router
from pqdb_api.routes.mfa import router as mfa_router
from pqdb_api.routes.migrations import router as migrations_router
from pqdb_api.routes.oauth_github import router as oauth_github_router
from pqdb_api.routes.oauth_providers import router as oauth_providers_router
from pqdb_api.routes.passkeys import router as passkeys_router
from pqdb_api.routes.performance_advisor import router as performance_advisor_router
from pqdb_api.routes.policies import router as policies_router
from pqdb_api.routes.project_overview import router as overview_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.realtime_ws import realtime_ws_endpoint
from pqdb_api.routes.roles import router as roles_router
from pqdb_api.routes.security_advisor import router as security_advisor_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.routes.webhooks import router as webhooks_router
from pqdb_api.services.auth import generate_mldsa65_keypair
from pqdb_api.services.db_webhook import webhook_listen_loop
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient

_logger = structlog.get_logger()


def _build_raw_dsn(sa_url: str) -> str:
    """Convert ``postgresql+asyncpg://…`` to ``postgresql://…`` for asyncpg."""
    return sa_url.replace("postgresql+asyncpg://", "postgresql://", 1)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage application startup and shutdown."""
    settings: Settings = app.state.settings
    setup_logging(debug=settings.debug)
    init_engine(settings.database_url)
    mldsa_private, mldsa_public = generate_mldsa65_keypair()
    app.state.mldsa65_private_key = mldsa_private
    app.state.mldsa65_public_key = mldsa_public
    app.state.provisioner = DatabaseProvisioner(
        superuser_dsn=settings.superuser_dsn,
    )
    app.state.vault_client = VaultClient(
        vault_addr=settings.vault_addr,
        vault_token=settings.vault_token,
    )
    app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
    app.state.crud_rate_limiter = RateLimiter(
        max_requests=settings.rate_limit_crud, window_seconds=60
    )
    app.state.auth_rate_limiter = RateLimiter(
        max_requests=settings.rate_limit_auth, window_seconds=60
    )

    # Start the webhook NOTIFY listener
    raw_dsn = _build_raw_dsn(settings.database_url)
    webhook_engine = create_async_engine(settings.database_url)
    webhook_session_factory = async_sessionmaker(
        webhook_engine, class_=AsyncSession, expire_on_commit=False
    )
    webhook_task = asyncio.create_task(
        webhook_listen_loop(raw_dsn, webhook_session_factory)
    )
    app.state.webhook_listener_task = webhook_task

    yield

    # Shut down the webhook listener
    webhook_task.cancel()
    try:
        await webhook_task
    except asyncio.CancelledError:
        pass
    await webhook_engine.dispose()
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
    app.add_middleware(AuditMiddleware)
    app.add_middleware(RateLimitMiddleware)

    app.include_router(health_router)
    app.include_router(user_auth_router)
    app.include_router(mfa_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(auth_settings_router)
    app.include_router(roles_router)
    app.include_router(oauth_github_router)
    app.include_router(oauth_providers_router)
    app.include_router(google_oauth_router)
    app.include_router(introspection_router)
    app.include_router(db_router)
    app.include_router(logs_router)
    app.include_router(overview_router)
    app.include_router(developer_oauth_router)
    app.include_router(passkeys_router)
    app.include_router(policies_router)
    app.include_router(indexes_router)
    app.include_router(migrations_router)
    app.include_router(branches_router)
    app.include_router(webhooks_router)
    app.include_router(security_advisor_router)
    app.include_router(performance_advisor_router)

    app.add_websocket_route("/v1/realtime", realtime_ws_endpoint)

    return app
