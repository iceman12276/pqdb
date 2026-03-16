"""Auth engine — per-project user tables and auth settings.

Creates and manages _pqdb_users, _pqdb_sessions, and _pqdb_auth_settings
tables in project databases. All tables use the _pqdb_ prefix to avoid
conflicts with user-created tables.

Tables are lazily initialized on first auth-related request via
ensure_auth_tables().
"""

from __future__ import annotations

from typing import Any

import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.services.webhook import validate_webhook_url

logger = structlog.get_logger()

# nosemgrep: avoid-sqlalchemy-text
_SAFE = text

_ALLOWED_SETTINGS = frozenset(
    {
        "require_email_verification",
        "magic_link_webhook",
        "password_min_length",
        "mfa_enabled",
    }
)

# ---------------------------------------------------------------------------
# PostgreSQL DDL
# ---------------------------------------------------------------------------
_SQL_CREATE_USERS_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_users ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  email text UNIQUE NOT NULL,"
    "  password_hash text NOT NULL,"
    "  role text NOT NULL DEFAULT 'authenticated',"
    "  email_verified boolean NOT NULL DEFAULT FALSE,"
    "  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,"
    "  created_at timestamptz NOT NULL DEFAULT now(),"
    "  updated_at timestamptz NOT NULL DEFAULT now()"
    ")"
)

_SQL_CREATE_SESSIONS_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_sessions ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  user_id uuid NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  refresh_token_hash text NOT NULL,"
    "  expires_at timestamptz NOT NULL,"
    "  revoked boolean NOT NULL DEFAULT FALSE,"
    "  created_at timestamptz NOT NULL DEFAULT now()"
    ")"
)

_SQL_CREATE_AUTH_SETTINGS_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_auth_settings ("
    "  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),"
    "  require_email_verification boolean NOT NULL DEFAULT FALSE,"
    "  magic_link_webhook text,"
    "  password_min_length integer NOT NULL DEFAULT 8,"
    "  mfa_enabled boolean NOT NULL DEFAULT FALSE,"
    "  updated_at timestamptz NOT NULL DEFAULT now()"
    ")"
)

_SQL_INSERT_DEFAULT_SETTINGS_PG = _SAFE(
    "INSERT INTO _pqdb_auth_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING"
)

_SQL_CREATE_VERIFICATION_TOKENS_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_verification_tokens ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  user_id uuid REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  email text NOT NULL,"
    "  token_hash text NOT NULL,"
    "  type text NOT NULL,"
    "  expires_at timestamptz,"
    "  used boolean NOT NULL DEFAULT FALSE,"
    "  created_at timestamptz NOT NULL DEFAULT now()"
    ")"
)

# MFA tables (US-039)
_SQL_CREATE_MFA_FACTORS_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_mfa_factors ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  user_id uuid NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  type text NOT NULL DEFAULT 'totp',"
    "  secret text NOT NULL,"
    "  verified boolean NOT NULL DEFAULT FALSE,"
    "  created_at timestamptz NOT NULL DEFAULT now()"
    ")"
)

_SQL_CREATE_RECOVERY_CODES_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_recovery_codes ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  user_id uuid NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  code_hash text NOT NULL,"
    "  used boolean NOT NULL DEFAULT FALSE"
    ")"
)

_SQL_CREATE_OAUTH_IDENTITIES_PG = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_oauth_identities ("
    "  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),"
    "  user_id uuid NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  provider text NOT NULL,"
    "  provider_uid text NOT NULL,"
    "  email text,"
    "  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,"
    "  created_at timestamptz NOT NULL DEFAULT now(),"
    "  UNIQUE(provider, provider_uid)"
    ")"
)

# ---------------------------------------------------------------------------
# SQLite DDL (for unit tests)
# ---------------------------------------------------------------------------
_SQL_CREATE_USERS_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_users ("
    "  id TEXT PRIMARY KEY,"
    "  email TEXT UNIQUE NOT NULL,"
    "  password_hash TEXT NOT NULL,"
    "  role TEXT NOT NULL DEFAULT 'authenticated',"
    "  email_verified INTEGER NOT NULL DEFAULT 0,"
    "  metadata TEXT NOT NULL DEFAULT '{}',"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
    "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
    ")"
)

_SQL_CREATE_SESSIONS_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_sessions ("
    "  id TEXT PRIMARY KEY,"
    "  user_id TEXT NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  refresh_token_hash TEXT NOT NULL,"
    "  expires_at TEXT NOT NULL,"
    "  revoked INTEGER NOT NULL DEFAULT 0,"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now'))"
    ")"
)

_SQL_CREATE_AUTH_SETTINGS_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_auth_settings ("
    "  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),"
    "  require_email_verification INTEGER NOT NULL DEFAULT 0,"
    "  magic_link_webhook TEXT,"
    "  password_min_length INTEGER NOT NULL DEFAULT 8,"
    "  mfa_enabled INTEGER NOT NULL DEFAULT 0,"
    "  updated_at TEXT NOT NULL DEFAULT (datetime('now'))"
    ")"
)

_SQL_INSERT_DEFAULT_SETTINGS_SQLITE = _SAFE(
    "INSERT OR IGNORE INTO _pqdb_auth_settings (id) VALUES (1)"
)

_SQL_CREATE_VERIFICATION_TOKENS_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_verification_tokens ("
    "  id TEXT PRIMARY KEY,"
    "  user_id TEXT REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  email TEXT NOT NULL,"
    "  token_hash TEXT NOT NULL,"
    "  type TEXT NOT NULL,"
    "  expires_at TEXT,"
    "  used INTEGER NOT NULL DEFAULT 0,"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now'))"
    ")"
)

# MFA tables — SQLite (for unit tests)
_SQL_CREATE_MFA_FACTORS_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_mfa_factors ("
    "  id TEXT PRIMARY KEY,"
    "  user_id TEXT NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  type TEXT NOT NULL DEFAULT 'totp',"
    "  secret TEXT NOT NULL,"
    "  verified INTEGER NOT NULL DEFAULT 0,"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now'))"
    ")"
)

_SQL_CREATE_RECOVERY_CODES_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_recovery_codes ("
    "  id TEXT PRIMARY KEY,"
    "  user_id TEXT NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  code_hash TEXT NOT NULL,"
    "  used INTEGER NOT NULL DEFAULT 0"
    ")"
)

_SQL_CREATE_OAUTH_IDENTITIES_SQLITE = _SAFE(
    "CREATE TABLE IF NOT EXISTS _pqdb_oauth_identities ("
    "  id TEXT PRIMARY KEY,"
    "  user_id TEXT NOT NULL REFERENCES _pqdb_users(id) ON DELETE CASCADE,"
    "  provider TEXT NOT NULL,"
    "  provider_uid TEXT NOT NULL,"
    "  email TEXT,"
    "  metadata TEXT NOT NULL DEFAULT '{}',"
    "  created_at TEXT NOT NULL DEFAULT (datetime('now')),"
    "  UNIQUE(provider, provider_uid)"
    ")"
)


def _is_sqlite(session: AsyncSession) -> bool:
    """Check if the session is connected to a SQLite database."""
    bind = session.bind
    if bind is None:
        return False
    return bind.dialect.name == "sqlite"


class AuthEngineError(Exception):
    """Raised when auth engine operations fail."""


async def ensure_auth_tables(session: AsyncSession) -> None:
    """Create auth tables if they don't exist. Idempotent.

    Creates:
    - _pqdb_users: end-user accounts
    - _pqdb_sessions: refresh token sessions
    - _pqdb_auth_settings: single-row project auth config
    - _pqdb_verification_tokens: auth event verification tokens

    Called lazily on first auth-related request.
    Raises AuthEngineError if table creation fails.
    """
    sqlite = _is_sqlite(session)

    try:
        if sqlite:
            await session.execute(_SQL_CREATE_USERS_SQLITE)
            await session.execute(_SQL_CREATE_SESSIONS_SQLITE)
            await session.execute(_SQL_CREATE_AUTH_SETTINGS_SQLITE)
            await session.execute(_SQL_INSERT_DEFAULT_SETTINGS_SQLITE)
            await session.execute(_SQL_CREATE_VERIFICATION_TOKENS_SQLITE)
            await session.execute(_SQL_CREATE_MFA_FACTORS_SQLITE)
            await session.execute(_SQL_CREATE_RECOVERY_CODES_SQLITE)
            await session.execute(_SQL_CREATE_OAUTH_IDENTITIES_SQLITE)
        else:
            await session.execute(_SQL_CREATE_USERS_PG)
            await session.execute(_SQL_CREATE_SESSIONS_PG)
            await session.execute(_SQL_CREATE_AUTH_SETTINGS_PG)
            await session.execute(_SQL_INSERT_DEFAULT_SETTINGS_PG)
            await session.execute(_SQL_CREATE_VERIFICATION_TOKENS_PG)
            await session.execute(_SQL_CREATE_MFA_FACTORS_PG)
            await session.execute(_SQL_CREATE_RECOVERY_CODES_PG)
            await session.execute(_SQL_CREATE_OAUTH_IDENTITIES_PG)

        await session.commit()
    except Exception as exc:
        logger.error("auth_tables_creation_failed", error=str(exc))
        raise AuthEngineError(f"Failed to create auth tables: {exc}") from exc

    logger.info("auth_tables_ensured", dialect="sqlite" if sqlite else "postgresql")


async def get_auth_settings(session: AsyncSession) -> dict[str, Any]:
    """Get the auth settings for the project.

    Ensures auth tables exist before reading.
    Returns a dict with all settings fields.
    """
    await ensure_auth_tables(session)

    result = await session.execute(
        _SAFE(
            "SELECT require_email_verification, magic_link_webhook, "
            "password_min_length, mfa_enabled "
            "FROM _pqdb_auth_settings WHERE id = 1"
        )
    )
    row = result.fetchone()
    if row is None:
        # Should never happen after ensure_auth_tables — indicates a serious bug
        raise RuntimeError(
            "Auth settings row missing after ensure_auth_tables. "
            "This indicates a bug in table initialization."
        )

    return {
        "require_email_verification": bool(row[0]),
        "magic_link_webhook": row[1],
        "password_min_length": row[2],
        "mfa_enabled": bool(row[3]),
    }


async def update_auth_settings(
    session: AsyncSession,
    updates: dict[str, Any],
) -> dict[str, Any]:
    """Update auth settings for the project.

    Only allowed fields can be updated. Raises ValueError for unknown fields.
    Returns the full settings dict after update.
    """
    if not updates:
        return await get_auth_settings(session)

    unknown = set(updates.keys()) - _ALLOWED_SETTINGS
    if unknown:
        raise ValueError(f"Unknown auth setting(s): {', '.join(sorted(unknown))}")

    # Validate webhook URL is HTTPS (if being set to a non-None value)
    webhook_url = updates.get("magic_link_webhook")
    if webhook_url is not None:
        validate_webhook_url(webhook_url)

    await ensure_auth_tables(session)

    # Build SET clause from validated field names
    set_parts: list[str] = []
    params: dict[str, Any] = {}
    for field_name, value in updates.items():
        # field_name is already validated against _ALLOWED_SETTINGS
        set_parts.append(f"{field_name} = :{field_name}")
        params[field_name] = value

    set_clause = ", ".join(set_parts)
    sql = f"UPDATE _pqdb_auth_settings SET {set_clause} WHERE id = 1"  # noqa: S608
    await session.execute(_SAFE(sql), params)
    await session.commit()

    logger.info("auth_settings_updated", fields=list(updates.keys()))

    return await get_auth_settings(session)
