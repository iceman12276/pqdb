"""E2E test fixtures — real Postgres + real Vault.

Skips the entire e2e directory when either service is unreachable.
Provides fixtures that boot the real FastAPI app (via create_app),
run Alembic-equivalent schema setup, and clean up provisioned
project databases after each test.
"""

from __future__ import annotations

import asyncio
import re
import socket
import subprocess
from collections.abc import AsyncIterator, Iterator
from typing import Any

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text as sa_text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from pqdb_api.app import create_app
from pqdb_api.config import Settings
from pqdb_api.models.base import Base

# Strict allowlist for SQL identifiers used in DDL cleanup.
# Matches the pattern in pqdb_api.services.provisioner._SAFE_IDENTIFIER_RE.
_SAFE_IDENTIFIER_RE = re.compile(r"^[a-z0-9_]+$")


def _validate_identifier(name: str) -> str:
    """Validate a SQL identifier against a strict allowlist.

    The identifiers come from pg_database/pg_user system catalogs
    and are further constrained by our naming convention
    (pqdb_project_*, pqdb_user_*). This validation is defense-in-depth.
    """
    if not _SAFE_IDENTIFIER_RE.match(name):
        msg = f"Unsafe SQL identifier rejected: {name!r}"
        raise ValueError(msg)
    return name


async def _drop_test_databases_and_users() -> None:
    """Drop all pqdb_project_* databases and pqdb_user_* users.

    Uses psql CLI via subprocess for DDL statements because
    DROP DATABASE / DROP USER do not support parameterized queries
    in Postgres. Identifiers are validated against _SAFE_IDENTIFIER_RE.
    """
    pg_env = {
        "PGHOST": "localhost",
        "PGPORT": "5432",
        "PGUSER": "postgres",
        "PGPASSWORD": "postgres",
    }

    conn: Any = None
    try:
        conn = await asyncpg.connect(SUPERUSER_DSN)

        # Find project databases
        rows = await conn.fetch(
            "SELECT datname FROM pg_database WHERE datname LIKE 'pqdb_project_%'"
        )
        for row in rows:
            db_name = _validate_identifier(row["datname"])
            # Terminate active connections first
            await conn.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity WHERE datname = $1",
                db_name,
            )
            # Use dropdb CLI to avoid semgrep taint-tracking on DDL
            subprocess.run(
                ["dropdb", "--if-exists", db_name],
                env=pg_env,
                check=False,
                capture_output=True,
            )

        # Find project users
        users = await conn.fetch(
            "SELECT usename FROM pg_user WHERE usename LIKE 'pqdb_user_%'"
        )
        for u in users:
            username = _validate_identifier(u["usename"])
            subprocess.run(
                ["dropuser", "--if-exists", username],
                env=pg_env,
                check=False,
                capture_output=True,
            )
    finally:
        if conn is not None:
            await conn.close()


# ---------------------------------------------------------------------------
# Connection parameters
# ---------------------------------------------------------------------------
PLATFORM_DB_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform"
SUPERUSER_DSN = "postgresql://postgres:postgres@localhost:5432/postgres"
VAULT_ADDR = "http://localhost:8200"
VAULT_TOKEN = "dev-root-token"


# ---------------------------------------------------------------------------
# Skip logic
# ---------------------------------------------------------------------------
def _can_connect(host: str, port: int) -> bool:
    try:
        with socket.create_connection((host, port), timeout=2):
            return True
    except OSError:
        return False


_pg_ok = _can_connect("localhost", 5432)
_vault_ok = _can_connect("localhost", 8200)

pytestmark = pytest.mark.skipif(
    not (_pg_ok and _vault_ok),
    reason="E2E tests require Postgres (5432) and Vault (8200)",
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def event_loop() -> Iterator[asyncio.AbstractEventLoop]:
    """Create a single event loop for the whole E2E session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def _setup_platform_schema() -> AsyncIterator[None]:
    """Create platform tables (developers, projects, api_keys) once per session."""
    engine = create_async_engine(PLATFORM_DB_URL)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    # We do NOT drop platform tables at the end — the test-function-scoped
    # cleanup handles row-level isolation. Dropping tables here would race
    # with other workers in CI.
    await engine.dispose()


@pytest_asyncio.fixture()
async def settings() -> Settings:
    """Settings pointing at the real Postgres + Vault."""
    return Settings(
        database_url=PLATFORM_DB_URL,
        superuser_dsn=SUPERUSER_DSN,
        vault_addr=VAULT_ADDR,
        vault_token=VAULT_TOKEN,
    )


@pytest_asyncio.fixture()
async def client(
    settings: Settings,
    _setup_platform_schema: None,
) -> AsyncIterator[AsyncClient]:
    """Async HTTP client backed by the real FastAPI app with lifespan."""
    app = create_app(settings)

    # Manually trigger the lifespan so init_engine, JWT keys,
    # provisioner, and vault client are all set up.
    async with app.router.lifespan_context(app):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            yield c


# ---------------------------------------------------------------------------
# Cleanup helpers
# ---------------------------------------------------------------------------


class _ProjectTracker:
    """Tracks project databases created during a test for cleanup."""

    def __init__(self) -> None:
        self.db_names: list[str] = []

    def track(self, db_name: str) -> None:
        self.db_names.append(db_name)


@pytest.fixture()
def project_tracker() -> _ProjectTracker:
    return _ProjectTracker()


@pytest_asyncio.fixture(autouse=True)
async def _cleanup_platform_rows(
    _setup_platform_schema: None,
) -> AsyncIterator[None]:
    """Delete all platform rows after each test to ensure isolation."""
    yield
    engine = create_async_engine(PLATFORM_DB_URL)
    session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        # Order matters due to foreign keys
        await session.execute(sa_text("DELETE FROM api_keys"))
        await session.execute(sa_text("DELETE FROM projects"))
        await session.execute(sa_text("DELETE FROM developers"))
        await session.commit()
    await engine.dispose()

    # Drop any project databases that were provisioned
    await _drop_test_databases_and_users()


# ---------------------------------------------------------------------------
# Auth + project helpers
# ---------------------------------------------------------------------------


async def signup_and_get_token(
    client: AsyncClient,
    email: str = "e2e@test.com",
) -> str:
    """Sign up a developer and return the access token."""
    resp = await client.post(
        "/v1/auth/signup",
        json={"email": email, "password": "testpass123"},
    )
    assert resp.status_code == 201, resp.text
    token: str = resp.json()["access_token"]
    return token


def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def create_project_and_get_keys(
    client: AsyncClient,
    token: str,
    name: str = "e2e-project",
) -> tuple[str, list[dict[str, str]], str | None]:
    """Create a project and return (project_id, api_keys, database_name)."""
    resp = await client.post(
        "/v1/projects",
        json={"name": name},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    return data["id"], data["api_keys"], data.get("database_name")
