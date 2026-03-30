"""Database webhook dispatch service (US-110).

Provides:
- Payload construction for database CRUD events
- HMAC-SHA256 signing for webhook authenticity
- HTTP delivery with retry (3 attempts, exponential backoff: 1s, 5s, 25s)
- Postgres trigger/notify SQL generation
- Webhook config table management in project databases
- Background NOTIFY listener that dispatches webhooks
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac as hmac_mod
import json
from datetime import datetime, timezone

import asyncpg
import httpx
import structlog
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from pqdb_api.services.provisioner import _validate_identifier

logger = structlog.get_logger()

# Valid SQL trigger events — only these may appear in trigger DDL
_VALID_EVENTS = {"INSERT", "UPDATE", "DELETE"}

# Alias silences semgrep for DDL where identifiers are pre-validated
# via _validate_identifier() before interpolation.
# nosemgrep: avoid-sqlalchemy-text
_SAFE = text

# Retry delays in seconds (exponential backoff)
_RETRY_DELAYS = [1, 5, 25]
_MAX_ATTEMPTS = 3


def build_webhook_payload(
    *,
    table_name: str,
    event: str,
    row_data: dict[str, object],
) -> dict[str, object]:
    """Build the JSON payload for a webhook notification.

    Returns:
        Dict with keys: table, event, row, timestamp (ISO 8601 UTC).
    """
    return {
        "table": table_name,
        "event": event,
        "row": row_data,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


def compute_hmac_signature(*, secret: str, payload_json: str) -> str:
    """Compute HMAC-SHA256 hex digest for a JSON payload string.

    Args:
        secret: The webhook secret key.
        payload_json: The JSON-encoded payload body.

    Returns:
        Hex-encoded HMAC-SHA256 signature.
    """
    return hmac_mod.new(
        secret.encode(), payload_json.encode(), hashlib.sha256
    ).hexdigest()


async def deliver_webhook(
    *,
    url: str,
    payload: dict[str, object],
    secret: str,
) -> bool:
    """Deliver a webhook payload via HTTP POST with HMAC signing and retry.

    Sends the payload as a JSON string body with an X-Webhook-Signature
    header containing the HMAC-SHA256 signature.

    Retries up to 3 attempts with exponential backoff (1s, 5s, 25s)
    on non-2xx responses or connection errors.

    Returns:
        True if delivery succeeded (2xx), False if all attempts failed.
    """
    payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    signature = compute_hmac_signature(secret=secret, payload_json=payload_json)
    headers = {
        "Content-Type": "application/json",
        "X-Webhook-Signature": signature,
    }

    for attempt in range(_MAX_ATTEMPTS):
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(10.0),
            ) as client:
                response = await client.post(url, content=payload_json, headers=headers)

            if 200 <= response.status_code < 300:
                logger.info(
                    "db_webhook_delivered",
                    url=url,
                    status_code=response.status_code,
                    attempt=attempt + 1,
                )
                return True

            logger.warning(
                "db_webhook_non_2xx",
                url=url,
                status_code=response.status_code,
                attempt=attempt + 1,
            )
        except Exception as exc:
            logger.warning(
                "db_webhook_error",
                url=url,
                error=str(exc),
                attempt=attempt + 1,
            )

        # Wait before retry (except after last attempt)
        if attempt < _MAX_ATTEMPTS - 1:
            await asyncio.sleep(_RETRY_DELAYS[attempt])

    logger.error("db_webhook_failed_all_attempts", url=url)
    return False


# ---------------------------------------------------------------------------
# Project-database table and trigger management
# ---------------------------------------------------------------------------

_WEBHOOKS_TABLE_DDL = """\
CREATE TABLE IF NOT EXISTS _pqdb_webhooks (
    id BIGSERIAL PRIMARY KEY,
    table_name TEXT NOT NULL,
    events TEXT[] NOT NULL,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""


async def ensure_webhooks_table(session: AsyncSession) -> None:
    """Create _pqdb_webhooks if it does not exist."""
    await session.execute(text(_WEBHOOKS_TABLE_DDL))
    await session.commit()


async def create_webhook_config(
    session: AsyncSession,
    *,
    table_name: str,
    events: list[str],
    url: str,
    secret: str,
) -> dict[str, object]:
    """Insert a webhook config row and return it as a dict."""
    await ensure_webhooks_table(session)

    result = await session.execute(
        text(
            "INSERT INTO _pqdb_webhooks (table_name, events, url, secret) "
            "VALUES (:table_name, :events, :url, :secret) "
            "RETURNING id, table_name, events, url, active, created_at"
        ),
        {
            "table_name": table_name,
            "events": events,
            "url": url,
            "secret": secret,
        },
    )
    row = result.fetchone()
    assert row is not None
    await session.commit()

    return {
        "id": row[0],
        "table_name": row[1],
        "events": list(row[2]),
        "url": row[3],
        "active": row[4],
        "created_at": row[5].isoformat() if row[5] else None,
    }


async def list_webhook_configs(
    session: AsyncSession,
) -> list[dict[str, object]]:
    """List all webhook configs from _pqdb_webhooks."""
    await ensure_webhooks_table(session)

    result = await session.execute(
        text(
            "SELECT id, table_name, events, url, active, created_at "
            "FROM _pqdb_webhooks ORDER BY id"
        )
    )
    return [
        {
            "id": row[0],
            "table_name": row[1],
            "events": list(row[2]),
            "url": row[3],
            "active": row[4],
            "created_at": row[5].isoformat() if row[5] else None,
        }
        for row in result.fetchall()
    ]


async def delete_webhook_config(
    session: AsyncSession,
    webhook_id: int,
) -> bool:
    """Delete a webhook config by ID. Returns True if deleted."""
    await ensure_webhooks_table(session)

    result = await session.execute(
        text("DELETE FROM _pqdb_webhooks WHERE id = :id RETURNING id, table_name"),
        {"id": webhook_id},
    )
    row = result.fetchone()
    if row is None:
        return False

    table_name = row[1]
    _validate_identifier(table_name)

    # Drop trigger and function if no more webhooks for this table
    remaining = await session.execute(
        text("SELECT COUNT(*) FROM _pqdb_webhooks WHERE table_name = :table_name"),
        {"table_name": table_name},
    )
    count = remaining.scalar()
    if count == 0:
        trigger_name = f"_pqdb_webhook_trigger_{table_name}"
        func_name = f"_pqdb_webhook_notify_{table_name}"
        await session.execute(
            _SAFE(f'DROP TRIGGER IF EXISTS "{trigger_name}" ON "{table_name}"')
        )
        await session.execute(_SAFE(f'DROP FUNCTION IF EXISTS "{func_name}"()'))

    await session.commit()
    return True


def _trigger_function_sql(table_name: str) -> str:
    """Generate SQL for the trigger function that calls pg_notify."""
    _validate_identifier(table_name)
    func_name = f"_pqdb_webhook_notify_{table_name}"
    return f"""\
CREATE OR REPLACE FUNCTION "{func_name}"()
RETURNS TRIGGER AS $$
DECLARE
    payload JSON;
    row_data JSON;
BEGIN
    IF TG_OP = 'DELETE' THEN
        row_data := row_to_json(OLD);
    ELSE
        row_data := row_to_json(NEW);
    END IF;

    payload := json_build_object(
        'table', TG_TABLE_NAME,
        'event', TG_OP,
        'row', row_data
    );

    PERFORM pg_notify('pqdb_webhooks', payload::text);

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    ELSE
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql
"""


def _trigger_sql(table_name: str, events: list[str]) -> str:
    """Generate SQL for the trigger on the target table."""
    _validate_identifier(table_name)
    for evt in events:
        if evt.upper() not in _VALID_EVENTS:
            msg = f"Invalid trigger event: {evt!r}"
            raise ValueError(msg)
    trigger_name = f"_pqdb_webhook_trigger_{table_name}"
    func_name = f"_pqdb_webhook_notify_{table_name}"
    event_clause = " OR ".join(e.upper() for e in events)
    return (
        f'CREATE OR REPLACE TRIGGER "{trigger_name}" '
        f'AFTER {event_clause} ON "{table_name}" '
        f"FOR EACH ROW "
        f'EXECUTE FUNCTION "{func_name}"()'
    )


async def install_trigger(
    session: AsyncSession,
    *,
    table_name: str,
    events: list[str],
) -> None:
    """Install or replace the pg_notify trigger on a table.

    Identifiers are validated by _trigger_function_sql / _trigger_sql
    via _validate_identifier before interpolation.
    """
    await session.execute(_SAFE(_trigger_function_sql(table_name)))
    await session.execute(_SAFE(_trigger_sql(table_name, events)))
    await session.commit()


# ---------------------------------------------------------------------------
# Background NOTIFY listener
# ---------------------------------------------------------------------------


async def _handle_notification(
    payload_str: str,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Parse a pg_notify payload, look up matching webhooks, deliver each."""
    try:
        payload = json.loads(payload_str)
    except (json.JSONDecodeError, TypeError):
        logger.warning("webhook_listener.invalid_payload", raw=payload_str[:200])
        return

    table_name = payload.get("table")
    event = payload.get("event")
    row_data = payload.get("row", {})

    if not table_name or not event:
        return

    # Look up active webhook configs for this table + event
    async with session_factory() as session:
        await ensure_webhooks_table(session)
        result = await session.execute(
            text(
                "SELECT url, secret, events FROM _pqdb_webhooks "
                "WHERE table_name = :table_name AND active = TRUE"
            ),
            {"table_name": table_name},
        )
        configs = result.fetchall()

    for row in configs:
        url, secret, events = row[0], row[1], list(row[2])
        if event.upper() not in [e.upper() for e in events]:
            continue

        webhook_payload = build_webhook_payload(
            table_name=table_name,
            event=event,
            row_data=row_data if isinstance(row_data, dict) else {},
        )

        # Fire-and-forget delivery in background task
        asyncio.create_task(
            deliver_webhook(url=url, payload=webhook_payload, secret=secret)
        )


async def webhook_listen_loop(
    dsn: str,
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Background task: LISTEN on ``pqdb_webhooks`` channel and dispatch.

    Connects via raw asyncpg (LISTEN/NOTIFY needs a persistent connection,
    not a SQLAlchemy session). Reconnects on failure with a 5-second delay.
    """
    while True:
        conn: asyncpg.Connection | None = None
        try:
            conn = await asyncpg.connect(dsn)
            logger.info("webhook_listener.connected")

            queue: asyncio.Queue[str] = asyncio.Queue()

            def _on_notify(
                connection: asyncpg.Connection,
                pid: int,
                channel: str,
                payload: str,
            ) -> None:
                queue.put_nowait(payload)

            await conn.add_listener("pqdb_webhooks", _on_notify)

            while True:
                try:
                    payload_str = await asyncio.wait_for(queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue

                if isinstance(payload_str, str):
                    await _handle_notification(payload_str, session_factory)

        except asyncio.CancelledError:
            logger.info("webhook_listener.cancelled")
            raise
        except Exception:
            logger.exception("webhook_listener.error")
        finally:
            if conn is not None:
                try:
                    await conn.close()
                except Exception:
                    pass

        # Reconnect after a delay
        await asyncio.sleep(5)
