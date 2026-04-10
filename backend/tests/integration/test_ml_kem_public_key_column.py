"""Integration tests for US-002: ml_kem_public_key column on developers.

Verifies that:
- The FastAPI app boots and /health returns 200.
- The developers table exposes an ml_kem_public_key column of type BYTEA
  that is nullable, per acceptance criteria in prd.json (US-002).
- The column round-trips None and bytes values via the SQLAlchemy model.
- The Alembic migration 011_add_ml_kem_public_key_to_developers.py applies
  cleanly against a fresh database and is reversible (downgrade -> upgrade).
"""

from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from pqdb_api.models.developer import Developer
from tests.integration.conftest import _make_platform_app

PG_HOST = "localhost"
PG_PORT = 5432
PG_USER = "postgres"
PG_PASS = "postgres"


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


class TestMlKemPublicKeyColumn:
    """US-002 acceptance: developers.ml_kem_public_key is BYTEA NULLABLE."""

    def test_health_endpoint_responds(self, test_db_url: str) -> None:
        """Service responds to health check (/health returns 200)."""
        app = _make_platform_app(test_db_url)
        with TestClient(app) as client:
            resp = client.get("/health")
            assert resp.status_code == 200

    def test_developers_has_ml_kem_public_key_column(self, test_db_url: str) -> None:
        """developers table must expose ml_kem_public_key as BYTEA NULLABLE."""
        app = _make_platform_app(test_db_url)
        with TestClient(app):
            # App must boot cleanly before we inspect the schema
            pass

        async def _inspect() -> tuple[str, str]:
            engine = create_async_engine(test_db_url)
            try:
                async with engine.connect() as conn:
                    row = await conn.execute(
                        text(
                            "SELECT data_type, is_nullable "
                            "FROM information_schema.columns "
                            "WHERE table_name = 'developers' "
                            "AND column_name = 'ml_kem_public_key'"
                        )
                    )
                    result = row.first()
                    assert result is not None, (
                        "developers.ml_kem_public_key column does not exist"
                    )
                    return str(result[0]), str(result[1])
            finally:
                await engine.dispose()

        data_type, is_nullable = asyncio.run(_inspect())
        assert data_type == "bytea", f"expected bytea, got {data_type}"
        assert is_nullable == "YES", f"expected nullable, got {is_nullable}"

    def test_model_roundtrip_none(self, test_db_url: str) -> None:
        """Inserting a developer with ml_kem_public_key=None round-trips."""
        app = _make_platform_app(test_db_url)
        with TestClient(app):
            pass

        async def _run() -> None:
            engine = create_async_engine(test_db_url)
            session_factory = async_sessionmaker(
                engine, class_=AsyncSession, expire_on_commit=False
            )
            try:
                async with session_factory() as session:
                    dev = Developer(
                        id=uuid.uuid4(),
                        email=f"none-{uuid.uuid4().hex[:8]}@test.com",
                        password_hash="x",
                        ml_kem_public_key=None,
                    )
                    session.add(dev)
                    await session.commit()

                    result = await session.execute(
                        select(Developer).where(Developer.id == dev.id)
                    )
                    loaded = result.scalar_one()
                    assert loaded.ml_kem_public_key is None
            finally:
                await engine.dispose()

        asyncio.run(_run())

    def test_model_roundtrip_bytes(self, test_db_url: str) -> None:
        """Inserting a developer with ml_kem_public_key=bytes round-trips."""
        app = _make_platform_app(test_db_url)
        with TestClient(app):
            pass

        key_bytes = b"\x00\x01\x02" + b"A" * 1181  # ML-KEM-768 public key = 1184B

        async def _run() -> None:
            engine = create_async_engine(test_db_url)
            session_factory = async_sessionmaker(
                engine, class_=AsyncSession, expire_on_commit=False
            )
            try:
                async with session_factory() as session:
                    dev = Developer(
                        id=uuid.uuid4(),
                        email=f"bytes-{uuid.uuid4().hex[:8]}@test.com",
                        password_hash="x",
                        ml_kem_public_key=key_bytes,
                    )
                    session.add(dev)
                    await session.commit()

                    result = await session.execute(
                        select(Developer).where(Developer.id == dev.id)
                    )
                    loaded = result.scalar_one()
                    assert loaded.ml_kem_public_key == key_bytes
            finally:
                await engine.dispose()

        asyncio.run(_run())


# ---------------------------------------------------------------------------
# Alembic migration reversibility test
#
# This uses a separate, throwaway database so we can exercise the real
# alembic upgrade head / downgrade -1 / upgrade head cycle without disturbing
# the shared integration test database.
# ---------------------------------------------------------------------------


@pytest.fixture()
def alembic_db() -> Iterator[str]:
    """Create a throwaway database, yield its async URL, drop at teardown."""
    db_name = f"pqdb_alembic_test_{uuid.uuid4().hex[:8]}"
    env = {
        "PGHOST": PG_HOST,
        "PGPORT": str(PG_PORT),
        "PGUSER": PG_USER,
        "PGPASSWORD": PG_PASS,
    }
    subprocess.run(["createdb", db_name], env=env, check=True, capture_output=True)
    try:
        yield (
            f"postgresql+asyncpg://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/{db_name}"
        )
    finally:
        subprocess.run(
            ["dropdb", "--if-exists", db_name],
            env=env,
            check=False,
            capture_output=True,
        )


class TestMigrationReversibility:
    """Acceptance: migration applies cleanly and downgrade removes the column."""

    def _run_alembic(self, db_url: str, *args: str) -> subprocess.CompletedProcess[str]:
        """Invoke alembic CLI pointing at the throwaway database."""
        backend_dir = Path(__file__).resolve().parents[2]
        sync_url = db_url.replace("+asyncpg", "+psycopg2")
        env = os.environ.copy()
        env["PQDB_DATABASE_URL"] = sync_url
        env["PQDB_SUPERUSER_DSN"] = (
            f"postgresql://{PG_USER}:{PG_PASS}@{PG_HOST}:{PG_PORT}/postgres"
        )
        result = subprocess.run(
            ["alembic", *args],
            cwd=backend_dir,
            env=env,
            check=False,
            capture_output=True,
            text=True,
        )
        return result

    def _column_exists(self, db_url: str) -> bool:
        async def _check() -> bool:
            engine = create_async_engine(db_url)
            try:
                async with engine.connect() as conn:
                    row = await conn.execute(
                        text(
                            "SELECT 1 FROM information_schema.columns "
                            "WHERE table_name = 'developers' "
                            "AND column_name = 'ml_kem_public_key'"
                        )
                    )
                    return row.first() is not None
            finally:
                await engine.dispose()

        return asyncio.run(_check())

    def test_upgrade_adds_column_downgrade_removes(self, alembic_db: str) -> None:
        """alembic upgrade head -> column present; downgrade -1 -> column gone."""
        up1 = self._run_alembic(alembic_db, "upgrade", "head")
        assert up1.returncode == 0, f"upgrade head failed: {up1.stderr}"
        assert self._column_exists(alembic_db), "column missing after upgrade head"

        down = self._run_alembic(alembic_db, "downgrade", "-1")
        assert down.returncode == 0, f"downgrade -1 failed: {down.stderr}"
        assert not self._column_exists(alembic_db), (
            "column still present after downgrade -1"
        )

        up2 = self._run_alembic(alembic_db, "upgrade", "head")
        assert up2.returncode == 0, f"second upgrade head failed: {up2.stderr}"
        assert self._column_exists(alembic_db), (
            "column missing after second upgrade head"
        )
