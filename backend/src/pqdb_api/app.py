"""FastAPI application factory."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from cryptography.hazmat.primitives.serialization import (
    load_pem_private_key,
    load_pem_public_key,
)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from pqdb_api.config import Settings
from pqdb_api.database import dispose_engine, init_engine
from pqdb_api.logging import setup_logging
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.auth_settings import router as auth_settings_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.mfa import router as mfa_router
from pqdb_api.routes.oauth_providers import router as oauth_providers_router
from pqdb_api.routes.policies import router as policies_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.routes.roles import router as roles_router
from pqdb_api.routes.user_auth import router as user_auth_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient


def _init_jwt_keys(app: FastAPI, settings: Settings) -> None:
    """Load or generate Ed25519 key pair for JWT signing."""
    if settings.jwt_private_key_pem and settings.jwt_public_key_pem:
        app.state.jwt_private_key = load_pem_private_key(
            settings.jwt_private_key_pem.encode(), password=None
        )
        app.state.jwt_public_key = load_pem_public_key(
            settings.jwt_public_key_pem.encode()
        )
    else:
        private_key, public_key = generate_ed25519_keypair()
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Manage application startup and shutdown."""
    settings: Settings = app.state.settings
    setup_logging(debug=settings.debug)
    init_engine(settings.database_url)
    _init_jwt_keys(app, settings)
    app.state.provisioner = DatabaseProvisioner(
        superuser_dsn=settings.superuser_dsn,
    )
    app.state.vault_client = VaultClient(
        vault_addr=settings.vault_addr,
        vault_token=settings.vault_token,
    )
    app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
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
    app.include_router(user_auth_router)
    app.include_router(mfa_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    app.include_router(auth_settings_router)
    app.include_router(roles_router)
    app.include_router(oauth_providers_router)
    app.include_router(db_router)
    app.include_router(policies_router)

    return app
