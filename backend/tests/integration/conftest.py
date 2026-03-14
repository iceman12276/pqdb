"""Shared fixtures for integration tests — real Postgres.

Creates a unique test database per session for isolation,
provides app factory functions that connect to real Postgres
instead of in-memory SQLite.
"""

from __future__ import annotations

import re
import socket
import subprocess
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.database import get_session
from pqdb_api.middleware.api_key import get_project_session
from pqdb_api.models.base import Base
from pqdb_api.routes.api_keys import router as api_keys_router
from pqdb_api.routes.auth import router as auth_router
from pqdb_api.routes.db import router as db_router
from pqdb_api.routes.health import router as health_router
from pqdb_api.routes.projects import router as projects_router
from pqdb_api.services.auth import generate_ed25519_keypair
from pqdb_api.services.provisioner import DatabaseProvisioner, make_database_name
from pqdb_api.services.rate_limiter import RateLimiter
from pqdb_api.services.vault import VaultClient

# Strict allowlist for SQL identifiers used in DDL cleanup.
_SAFE_IDENTIFIER_RE = re.compile(r"^[a-z0-9_]+$")

# ---------------------------------------------------------------------------
# Connection parameters
# ---------------------------------------------------------------------------
PG_USER = "postgres"
PG_PASS = "postgres"
PG_HOST = "localhost"
PG_PORT = 5432
ADMIN_DSN = f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/postgres"


def _pg_available() -> bool:
    try:
        with socket.create_connection((PG_HOST, PG_PORT), timeout=2):
            return True
    except OSError:
        return False


pytestmark = pytest.mark.skipif(
    not _pg_available(),
    reason="Integration tests require Postgres on localhost:5432",
)


# ---------------------------------------------------------------------------
# Session-scoped: create / drop a unique test database
# ---------------------------------------------------------------------------
@pytest.fixture(scope="session")
def test_db_name() -> str:
    """Generate a unique database name for this test session."""
    short_id = uuid.uuid4().hex[:8]
    return f"pqdb_inttest_{short_id}"


@pytest.fixture(scope="session")
def test_db_url(test_db_name: str) -> str:
    return (
        f"postgresql+asyncpg://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{test_db_name}"
    )


def _validate_db_name(name: str) -> str:
    """Validate a database name against a strict allowlist.

    The name is generated internally (pqdb_inttest_{hex}), but we
    validate defense-in-depth before passing to CLI tools.
    """
    if not _SAFE_IDENTIFIER_RE.match(name):
        msg = f"Unsafe database name rejected: {name!r}"
        raise ValueError(msg)
    return name


def _pg_env() -> dict[str, str]:
    """Environment variables for psql/createdb/dropdb CLI tools."""
    return {
        "PGHOST": PG_HOST,
        "PGPORT": str(PG_PORT),
        "PGUSER": PG_USER,
        "PGPASSWORD": PG_PASS,
    }


@pytest.fixture(scope="session", autouse=True)
def _create_test_database(test_db_name: str) -> Iterator[None]:
    """Create the test database before the session, drop it after.

    Uses createdb/dropdb CLI to avoid semgrep taint-tracking on DDL
    (CREATE/DROP DATABASE cannot use parameterized queries).
    """
    import asyncio

    db_name = _validate_db_name(test_db_name)
    env = _pg_env()

    subprocess.run(
        ["createdb", db_name],
        env=env,
        check=True,
        capture_output=True,
    )

    # Create platform tables (developers, projects, api_keys)
    loop = asyncio.new_event_loop()

    async def _bootstrap() -> None:
        engine = create_async_engine(
            f"postgresql+asyncpg://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{db_name}"
        )
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        await engine.dispose()

    loop.run_until_complete(_bootstrap())
    loop.close()

    yield

    # Terminate active connections before dropping
    loop2 = asyncio.new_event_loop()

    async def _terminate() -> None:
        conn: Any = await asyncpg.connect(ADMIN_DSN)
        try:
            await conn.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity WHERE datname = $1",
                db_name,
            )
        finally:
            await conn.close()

    loop2.run_until_complete(_terminate())
    loop2.close()

    subprocess.run(
        ["dropdb", "--if-exists", db_name],
        env=env,
        check=False,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Per-test cleanup: drop dynamic tables and truncate platform tables.
# Runs OUTSIDE the TestClient context so there's no event loop conflict.
# Uses subprocess (psql) for DDL and a short-lived engine for TRUNCATE.
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _clean_tables(test_db_name: str, test_db_url: str) -> Iterator[None]:
    """Clean all tables after each test for isolation."""
    import asyncio

    yield

    db_name = _validate_db_name(test_db_name)
    env = _pg_env()

    # 1. Drop dynamically created user tables via psql
    # Query _pqdb_columns for table names, then drop them
    result = subprocess.run(
        [
            "psql",
            "-h",
            PG_HOST,
            "-p",
            str(PG_PORT),
            "-U",
            PG_USER,
            "-d",
            db_name,
            "-t",
            "-A",
            "-c",
            "SELECT DISTINCT table_name FROM _pqdb_columns",
        ],
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0 and result.stdout.strip():
        for tbl in result.stdout.strip().split("\n"):
            tbl = tbl.strip()
            if tbl and _SAFE_IDENTIFIER_RE.match(tbl):
                subprocess.run(
                    [
                        "psql",
                        "-h",
                        PG_HOST,
                        "-p",
                        str(PG_PORT),
                        "-U",
                        PG_USER,
                        "-d",
                        db_name,
                        "-c",
                        f'DROP TABLE IF EXISTS "{tbl}" CASCADE',
                    ],
                    env=env,
                    check=False,
                    capture_output=True,
                )

    # Drop the _pqdb_columns metadata table
    subprocess.run(
        [
            "psql",
            "-h",
            PG_HOST,
            "-p",
            str(PG_PORT),
            "-U",
            PG_USER,
            "-d",
            db_name,
            "-c",
            "DROP TABLE IF EXISTS _pqdb_columns CASCADE",
        ],
        env=env,
        check=False,
        capture_output=True,
    )

    # 2. Truncate platform tables using a short-lived engine
    loop = asyncio.new_event_loop()

    async def _truncate() -> None:
        from sqlalchemy import text as sa_text

        engine = create_async_engine(test_db_url)
        try:
            async with engine.begin() as conn:
                await conn.execute(
                    sa_text("TRUNCATE api_keys, projects, developers CASCADE")
                )
        except Exception:
            pass  # Tables may not exist in project-only test databases
        finally:
            await engine.dispose()

    loop.run_until_complete(_truncate())
    loop.close()


# ---------------------------------------------------------------------------
# Fixtures for platform-level tests (auth, projects, api_keys, etc.)
# ---------------------------------------------------------------------------
def _make_platform_app(
    test_db_url: str,
    provisioner_side_effect: Exception | None = None,
    vault_keys: dict[str, bytes] | None = None,
    include_db_router: bool = False,
) -> FastAPI:
    """Build a test FastAPI app backed by real Postgres.

    Creates its own engine inside the lifespan so it runs on
    the TestClient's event loop (avoids "attached to different loop" errors).
    """
    private_key, public_key = generate_ed25519_keypair()

    # Mock provisioner
    mock_provisioner = AsyncMock(spec=DatabaseProvisioner)
    mock_provisioner.superuser_dsn = "postgresql://test:test@localhost/test"

    async def _mock_provision(project_id: uuid.UUID) -> str:
        if provisioner_side_effect is not None:
            raise provisioner_side_effect
        return make_database_name(project_id)

    mock_provisioner.provision = AsyncMock(side_effect=_mock_provision)

    # Mock vault client
    stored_keys: dict[str, bytes] = vault_keys if vault_keys is not None else {}
    mock_vault = MagicMock(spec=VaultClient)

    def _mock_store(project_id: uuid.UUID, key: bytes) -> None:
        stored_keys[str(project_id)] = key

    def _mock_get(project_id: uuid.UUID) -> bytes:
        key = stored_keys.get(str(project_id))
        if key is None:
            from pqdb_api.services.vault import VaultError

            raise VaultError("Key not found")
        return key

    def _mock_delete(project_id: uuid.UUID) -> None:
        stored_keys.pop(str(project_id), None)

    mock_vault.store_hmac_key = MagicMock(side_effect=_mock_store)
    mock_vault.get_hmac_key = MagicMock(side_effect=_mock_get)
    mock_vault.delete_hmac_key = MagicMock(side_effect=_mock_delete)

    from pqdb_api.config import Settings

    settings = Settings(
        database_url=test_db_url,
        superuser_dsn="postgresql://test:test@localhost/test",
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_session] = _override_get_session
        app.state.jwt_private_key = private_key
        app.state.jwt_public_key = public_key
        app.state.provisioner = mock_provisioner
        app.state.vault_client = mock_vault
        app.state.hmac_rate_limiter = RateLimiter(max_requests=10, window_seconds=60)
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.state.settings = settings
    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(projects_router)
    app.include_router(api_keys_router)
    if include_db_router:
        app.include_router(db_router)
    return app


# ---------------------------------------------------------------------------
# Fixtures for project-level tests (schema engine, CRUD, introspection, etc.)
# ---------------------------------------------------------------------------
def _make_project_app(test_db_url: str) -> FastAPI:
    """Build a minimal test app for project-scoped endpoints.

    Creates its own engine inside the lifespan so it runs on
    the TestClient's event loop.
    """

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        engine = create_async_engine(test_db_url)
        session_factory = async_sessionmaker(
            engine, class_=AsyncSession, expire_on_commit=False
        )

        async def _override_get_project_session() -> AsyncIterator[AsyncSession]:
            async with session_factory() as session:
                yield session

        app.dependency_overrides[get_project_session] = _override_get_project_session
        yield
        await engine.dispose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(health_router)
    app.include_router(db_router)
    return app


# ---------------------------------------------------------------------------
# Convenience helpers used across test files
# ---------------------------------------------------------------------------
def signup_and_get_token(client: TestClient, email: str = "dev@test.com") -> str:
    """Sign up a developer and return the access token."""
    resp = client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201
    token: str = resp.json()["access_token"]
    return token


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def create_project(
    client: TestClient,
    token: str,
    name: str = "test-project",
) -> dict:  # type: ignore[type-arg]
    """Create a project and return the response JSON."""
    resp = client.post(
        "/v1/projects",
        json={"name": name},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data: dict = resp.json()  # type: ignore[type-arg]
    return data
