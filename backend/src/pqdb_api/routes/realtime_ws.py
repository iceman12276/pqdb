"""Realtime WebSocket endpoint.

Provides ``/v1/realtime`` WebSocket connections with:
- Auth via query params: ``apikey`` (required) + ``token`` (optional user JWT)
- Subscribe/unsubscribe to table change events
- Server heartbeat every 30 seconds
- pg_notify listener for INSERT/UPDATE/DELETE events
- Row fetch on INSERT/UPDATE, id-only on DELETE
- Per-event RLS enforcement before delivery (US-065)
"""

from __future__ import annotations

import asyncio
import json
import uuid as uuid_mod
from datetime import datetime
from typing import Any

import asyncpg
import structlog
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from pqdb_api.middleware.api_key import (
    ProjectContext,
    _build_project_database_url,
    _get_or_create_engine,
    _parse_api_key,
)
from pqdb_api.models.api_key import ApiKey
from pqdb_api.models.project import Project
from pqdb_api.services.api_keys import verify_api_key
from pqdb_api.services.realtime_ws import (
    HEARTBEAT_INTERVAL_SECONDS,
    ConnectionState,
    RealtimeProtocol,
    WSRateLimiter,
    check_realtime_rls,
    parse_ws_message,
)

logger = structlog.get_logger()

# Module-level rate limiter for WebSocket reconnections
_ws_rate_limiter = WSRateLimiter()


def _get_client_ip(websocket: WebSocket) -> str:
    """Extract client IP from the WebSocket connection."""
    client = websocket.client
    if client:
        return client.host
    return "unknown"


async def _authenticate_ws(
    websocket: WebSocket,
) -> ProjectContext | None:
    """Validate apikey query param and return ProjectContext, or None on failure.

    Does NOT accept the WebSocket — caller must do that. On failure,
    closes the WebSocket with an appropriate code.
    """
    apikey = websocket.query_params.get("apikey")
    if not apikey:
        await websocket.close(code=4001, reason="Missing apikey parameter")
        return None

    try:
        prefix, _role = _parse_api_key(apikey)
    except ValueError:
        await websocket.close(code=4001, reason="Invalid API key format")
        return None

    # Look up the key in the platform database
    from pqdb_api.database import get_engine

    engine = get_engine()
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    async with factory() as session:
        result = await session.execute(
            select(ApiKey).where(ApiKey.key_prefix == prefix)
        )
        candidates = list(result.scalars().all())

        matched_key: ApiKey | None = None
        for candidate in candidates:
            if verify_api_key(candidate.key_hash, apikey):
                matched_key = candidate
                break

        if matched_key is None:
            await websocket.close(code=4001, reason="Invalid API key")
            return None

        proj_result = await session.execute(
            select(Project).where(Project.id == matched_key.project_id)
        )
        project = proj_result.scalar_one_or_none()
        if project is None or project.database_name is None:
            await websocket.close(code=4001, reason="Project not provisioned")
            return None

        return ProjectContext(
            project_id=matched_key.project_id,
            key_role=matched_key.role,
            database_name=project.database_name,
        )


def _parse_user_token(
    websocket: WebSocket,
    project_id: uuid_mod.UUID,
) -> tuple[uuid_mod.UUID | None, str | None]:
    """Extract user_id and role from optional token query param.

    Returns (user_id, user_role) or (None, None) if no token or invalid.
    """
    token = websocket.query_params.get("token")
    if not token:
        return None, None

    try:
        from pqdb_api.middleware.user_auth import _validate_user_jwt

        key = websocket.app.state.jwt_public_key
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
        from cryptography.hazmat.primitives.serialization import load_pem_public_key

        if isinstance(key, (str, bytes)):
            pem = key.encode() if isinstance(key, str) else key
            loaded = load_pem_public_key(pem)
            if not isinstance(loaded, Ed25519PublicKey):
                return None, None
            key = loaded
        elif not isinstance(key, Ed25519PublicKey):
            return None, None

        user_ctx = _validate_user_jwt(token, key, expected_project_id=project_id)
        if user_ctx is None:
            return None, None
        return user_ctx.user_id, user_ctx.role
    except Exception:
        return None, None


def _build_raw_dsn(asyncpg_url: str) -> str:
    """Convert a SQLAlchemy asyncpg URL to a raw PostgreSQL DSN.

    ``postgresql+asyncpg://...`` → ``postgresql://...``
    """
    return asyncpg_url.replace("postgresql+asyncpg://", "postgresql://", 1)


async def _fetch_row(
    session: AsyncSession, table: str, pk: str
) -> dict[str, Any] | None:
    """Fetch a single row by primary key. Returns None if not found."""
    # Validate table name to prevent SQL injection
    from pqdb_api.services.realtime import _validate_identifier

    safe_table = _validate_identifier(table)
    # Table name is validated against ^[a-z][a-z0-9_]*$ — safe for interpolation.
    # The pk comes from the trigger as text (NEW.id::text), but id is bigint —
    # cast to int so asyncpg doesn't reject the string-to-integer bind.
    # nosemgrep: avoid-sqlalchemy-text
    sql = text(f"SELECT * FROM {safe_table} WHERE id = :pk")  # noqa: S608
    result = await session.execute(sql, {"pk": int(pk)})
    row = result.mappings().fetchone()
    if row is None:
        return None
    # Convert non-JSON-serializable types for JSON serialization
    out: dict[str, Any] = {}
    for k, v in row.items():
        if isinstance(v, (bytes, bytearray, memoryview)):
            out[k] = bytes(v).decode("utf-8")
        elif isinstance(v, uuid_mod.UUID):
            out[k] = str(v)
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


async def _get_column_meta_for_rls(
    session: AsyncSession, table_name: str
) -> list[dict[str, Any]]:
    """Load column metadata for RLS checks. Returns empty list on failure."""
    try:
        from pqdb_api.services.schema_engine import ensure_metadata_table

        await ensure_metadata_table(session)
        result = await session.execute(
            text(
                "SELECT column_name, sensitivity, data_type, is_owner "
                "FROM _pqdb_columns WHERE table_name = :name ORDER BY id"
            ),
            {"name": table_name},
        )
        return [
            {
                "name": r[0],
                "sensitivity": r[1],
                "data_type": r[2],
                "is_owner": bool(r[3]),
            }
            for r in result.fetchall()
        ]
    except Exception:
        return []


async def _resolve_policies_for_rls(
    session: AsyncSession,
    table_name: str,
    user_role: str | None,
) -> list[dict[str, Any]] | None:
    """Resolve RLS policies for realtime delivery (select operation).

    Returns:
    - None if no policies exist for this table (fall back to basic RLS)
    - A list with the matching policy dict if found
    - An empty list if policies exist but not for this role/op => deny
    """
    try:
        from pqdb_api.services.auth_engine import ensure_auth_tables
        from pqdb_api.services.roles_policies import (
            get_policies_for_table,
            lookup_policy,
        )

        await ensure_auth_tables(session)
        all_policies = await get_policies_for_table(session, table_name)
        if not all_policies:
            return None

        role = user_role if user_role else "anon"
        policy = await lookup_policy(session, table_name, "select", role)
        if policy is None:
            return []
        return [policy]
    except Exception:
        return None


async def _listen_loop(
    conn: asyncpg.Connection,
    state: ConnectionState,
    websocket: WebSocket,
    project_session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Listen for pg_notify events and forward to the WebSocket client."""
    queue: asyncio.Queue[asyncpg.Record | str] = asyncio.Queue()

    def _listener(
        conn: asyncpg.Connection,
        pid: int,
        channel: str,
        payload: str,
    ) -> None:
        queue.put_nowait(payload)

    await conn.add_listener("pqdb_realtime", _listener)

    try:
        while True:
            try:
                payload_str = await asyncio.wait_for(queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            if not isinstance(payload_str, str):
                continue

            try:
                payload = json.loads(payload_str)
            except (json.JSONDecodeError, TypeError):
                continue

            table = payload.get("table", "")
            event = payload.get("event", "")
            pk = payload.get("pk", "")

            if not state.subscriptions.is_subscribed(table):
                continue

            if event == "DELETE":
                row_data: dict[str, Any] = {"id": pk}
            else:
                # Fetch the full row for INSERT/UPDATE
                async with project_session_factory() as session:
                    fetched = await _fetch_row(session, table, pk)
                if fetched is None:
                    continue
                row_data = fetched

            # Per-event RLS check before delivery (US-065)
            async with project_session_factory() as session:
                columns_meta = await _get_column_meta_for_rls(session, table)
                policies = await _resolve_policies_for_rls(
                    session, table, state.user_role
                )

            if not check_realtime_rls(
                row=row_data,
                key_role=state.key_role,
                user_id=state.user_id,
                user_role=state.user_role,
                columns_meta=columns_meta,
                policies=policies,
            ):
                logger.debug(
                    "realtime_ws.rls_filtered",
                    table=table,
                    event_type=event,
                    pk=pk,
                )
                continue

            msg = RealtimeProtocol.event(
                table=table,
                event_type=event,
                row=row_data,
            )

            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(msg)
    except asyncio.CancelledError:
        pass
    finally:
        await conn.remove_listener("pqdb_realtime", _listener)


async def _heartbeat_loop(websocket: WebSocket) -> None:
    """Send heartbeat messages at regular intervals."""
    try:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECONDS)
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_json(RealtimeProtocol.heartbeat())
    except asyncio.CancelledError:
        pass


async def realtime_ws_endpoint(websocket: WebSocket) -> None:
    """Main WebSocket handler for /v1/realtime."""
    # Rate limit check
    client_ip = _get_client_ip(websocket)
    if not _ws_rate_limiter.check(client_ip):
        await websocket.close(code=4029, reason="Too many connections")
        return

    # Authenticate
    context = await _authenticate_ws(websocket)
    if context is None:
        return

    # Parse optional user token for RLS
    user_id, user_role = _parse_user_token(websocket, context.project_id)

    # Accept the connection
    await websocket.accept()

    state = ConnectionState(
        project_id=str(context.project_id),
        key_role=context.key_role,
        user_id=user_id,
        user_role=user_role,
    )

    settings = websocket.app.state.settings
    project_db_url = _build_project_database_url(
        settings.database_url, context.database_name
    )

    # Create project-scoped engine/session factory
    engine = _get_or_create_engine(
        websocket.app.state, project_db_url, context.database_name
    )
    project_session_factory = async_sessionmaker(
        engine, class_=AsyncSession, expire_on_commit=False
    )

    # Connect raw asyncpg for LISTEN
    raw_dsn = _build_raw_dsn(project_db_url)
    pg_conn: asyncpg.Connection | None = None
    listen_task: asyncio.Task[None] | None = None
    heartbeat_task: asyncio.Task[None] | None = None

    try:
        pg_conn = await asyncpg.connect(raw_dsn)

        # Start background tasks
        listen_task = asyncio.create_task(
            _listen_loop(pg_conn, state, websocket, project_session_factory)
        )
        heartbeat_task = asyncio.create_task(_heartbeat_loop(websocket))

        # Main message loop
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break

            msg = parse_ws_message(raw)

            if msg["type"] == "error":
                await websocket.send_json(RealtimeProtocol.error(msg["message"]))
                continue

            if msg["type"] == "heartbeat":
                await websocket.send_json(RealtimeProtocol.heartbeat())
                continue

            if msg["type"] == "subscribe":
                table = msg["table"]
                ok = state.subscriptions.subscribe(table)
                if ok:
                    await websocket.send_json(RealtimeProtocol.ack("subscribe", table))
                else:
                    if state.subscriptions.is_subscribed(table):
                        await websocket.send_json(
                            RealtimeProtocol.error(f"Already subscribed to '{table}'")
                        )
                    else:
                        await websocket.send_json(
                            RealtimeProtocol.error(
                                "Maximum table subscriptions reached (50)"
                            )
                        )
                continue

            if msg["type"] == "unsubscribe":
                table = msg["table"]
                ok = state.subscriptions.unsubscribe(table)
                if ok:
                    await websocket.send_json(
                        RealtimeProtocol.ack("unsubscribe", table)
                    )
                else:
                    await websocket.send_json(
                        RealtimeProtocol.error(f"Not subscribed to '{table}'")
                    )
                continue

    except Exception:
        logger.exception("realtime_ws.error", project_id=str(context.project_id))
    finally:
        # Clean up background tasks
        if listen_task is not None:
            listen_task.cancel()
            try:
                await listen_task
            except asyncio.CancelledError:
                pass
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
        if pg_conn is not None:
            await pg_conn.close()

        logger.info(
            "realtime_ws.disconnected",
            project_id=str(context.project_id),
            client_ip=client_ip,
        )
