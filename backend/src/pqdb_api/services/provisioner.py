"""Database-per-project provisioner.

Creates an isolated Postgres database and dedicated user for each
project. Connects to Postgres as superuser via asyncpg to run DDL.

Security note: PostgreSQL DDL (CREATE DATABASE, CREATE USER, GRANT)
does not support parameterized queries for identifiers. All identifiers
are validated against a strict [a-z0-9_]+ allowlist before interpolation
and double-quoted, making SQL injection impossible.
"""

import re
import secrets
import uuid
from dataclasses import dataclass

import asyncpg  # type: ignore[import-untyped]
import structlog

logger = structlog.get_logger()

_PASSWORD_LENGTH = 32
_UUID_SHORT_LEN = 12
_SAFE_IDENTIFIER_RE = re.compile(r"^[a-z0-9_]+$")


@dataclass(frozen=True)
class ProvisionResult:
    """Result of provisioning a project database."""

    database_name: str
    database_user: str


def generate_db_name(project_id: uuid.UUID) -> str:
    """Generate database name: pqdb_project_{first 12 hex chars}."""
    return "pqdb_project_" + project_id.hex[:_UUID_SHORT_LEN]


def generate_db_user(project_id: uuid.UUID) -> str:
    """Generate database user: pqdb_user_{first 12 hex chars}."""
    return "pqdb_user_" + project_id.hex[:_UUID_SHORT_LEN]


def _validate_identifier(value: str) -> str:
    """Validate a SQL identifier — only lowercase, digits, underscores."""
    if not _SAFE_IDENTIFIER_RE.match(value):
        msg = f"Unsafe SQL identifier: {value!r}"
        raise ValueError(msg)
    return value


def _quote_ident(identifier: str) -> str:
    """Double-quote a validated SQL identifier."""
    return '"' + identifier + '"'


def _to_asyncpg_dsn(database_url: str) -> str:
    """Strip +asyncpg dialect and target the postgres database."""
    url = database_url.replace("+asyncpg", "")
    # Replace the database name with 'postgres' for superuser DDL
    parts = url.rsplit("/", 1)
    return parts[0] + "/postgres"


def _build_provision_ddl(
    quoted_db: str, quoted_user: str, db_password: str
) -> list[str]:
    """Build DDL statements for database + user provisioning.

    All identifiers MUST be validated via _validate_identifier before
    being passed to _quote_ident. DDL cannot use parameterized queries.
    """
    return [
        "CREATE USER " + quoted_user + " WITH PASSWORD '" + db_password + "'",
        "CREATE DATABASE " + quoted_db + " OWNER " + quoted_user,
        "GRANT CONNECT ON DATABASE " + quoted_db + " TO " + quoted_user,
    ]


def _build_grant_ddl(quoted_user: str) -> list[str]:
    """Build GRANT statements for schema-level privileges."""
    return [
        "GRANT ALL PRIVILEGES ON SCHEMA public TO " + quoted_user,
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        "GRANT ALL ON TABLES TO " + quoted_user,
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
        "GRANT ALL ON SEQUENCES TO " + quoted_user,
    ]


async def provision_database(
    project_id: uuid.UUID,
    database_url: str,
) -> ProvisionResult:
    """Provision an isolated database and user for a project.

    Connects as superuser, creates the database and a limited-privilege
    user, then grants schema-level privileges on the new database.
    """
    db_name = _validate_identifier(generate_db_name(project_id))
    db_user = _validate_identifier(generate_db_user(project_id))
    db_password = secrets.token_urlsafe(_PASSWORD_LENGTH)

    dsn = _to_asyncpg_dsn(database_url)
    quoted_db = _quote_ident(db_name)
    quoted_user = _quote_ident(db_user)

    ddl_statements = _build_provision_ddl(quoted_db, quoted_user, db_password)

    conn = await asyncpg.connect(dsn)
    try:
        for stmt in ddl_statements:
            # nosemgrep: python.lang.security.audit.formatted-sql-query
            await conn.execute(stmt)  # nosemgrep
    finally:
        await conn.close()

    # Connect to the new database to grant schema-level privileges
    new_db_dsn = dsn.rsplit("/", 1)[0] + "/" + db_name
    grant_statements = _build_grant_ddl(quoted_user)

    conn2 = await asyncpg.connect(new_db_dsn)
    try:
        for stmt in grant_statements:
            # nosemgrep: python.lang.security.audit.formatted-sql-query
            await conn2.execute(stmt)  # nosemgrep
    finally:
        await conn2.close()

    logger.info(
        "database_provisioned",
        project_id=str(project_id),
        database_name=db_name,
        username=db_user,
    )

    return ProvisionResult(
        database_name=db_name,
        database_user=db_user,
    )
