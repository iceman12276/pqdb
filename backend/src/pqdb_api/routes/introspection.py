"""Postgres catalog introspection endpoints (US-096).

Queries system catalogs (pg_proc, pg_trigger, pg_type, pg_extension,
pg_indexes, pg_publication) so the dashboard can display database
objects. All endpoints filter out system schemas and pqdb internals.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from pqdb_api.middleware.api_key import get_project_session

router = APIRouter(prefix="/v1/db/catalog", tags=["introspection"])


# --- SQL constants ---
# All queries below are fully static (no user input interpolated).
# System schema exclusion is hardcoded in each query literal.

_FUNCTIONS_SQL = text("""
    SELECT
        p.proname AS name,
        n.nspname AS schema,
        pg_catalog.pg_get_function_arguments(p.oid) AS args,
        t.typname AS return_type,
        l.lanname AS language,
        p.prosrc AS source
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_type t ON t.oid = p.prorettype
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND p.prorettype != 'pg_catalog.trigger'::pg_catalog.regtype
      AND l.lanname NOT IN ('c', 'internal')
    ORDER BY n.nspname, p.proname
""")

_TRIGGERS_SQL = text("""
    SELECT
        t.tgname AS name,
        c.relname AS table_name,
        CASE
            WHEN (t.tgtype::int & 2) != 0 THEN 'BEFORE'
            WHEN (t.tgtype::int & 64) != 0 THEN 'INSTEAD OF'
            ELSE 'AFTER'
        END AS timing,
        array_remove(ARRAY[
            CASE WHEN (t.tgtype::int & 4) != 0 THEN 'INSERT' END,
            CASE WHEN (t.tgtype::int & 8) != 0 THEN 'DELETE' END,
            CASE WHEN (t.tgtype::int & 16) != 0 THEN 'UPDATE' END,
            CASE WHEN (t.tgtype::int & 32) != 0 THEN 'TRUNCATE' END
        ], NULL) AS events,
        p.proname AS function_name
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND c.relname NOT LIKE '_pqdb_%'
    ORDER BY c.relname, t.tgname
""")

_ENUMS_SQL = text("""
    SELECT
        t.typname AS name,
        n.nspname AS schema,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    GROUP BY t.typname, n.nspname
    ORDER BY n.nspname, t.typname
""")

_EXTENSIONS_SQL = text("""
    SELECT
        e.extname AS name,
        e.extversion AS version,
        n.nspname AS schema,
        d.description AS comment
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
    LEFT JOIN pg_catalog.pg_description d
        ON d.objoid = e.oid AND d.classoid = 'pg_extension'::regclass
    ORDER BY e.extname
""")

_INDEXES_SQL = text("""
    SELECT
        i.indexname AS name,
        i.tablename AS table_name,
        i.indexdef AS definition,
        ix.indisunique AS is_unique,
        pg_catalog.pg_relation_size(c.oid) AS size_bytes
    FROM pg_catalog.pg_indexes i
    JOIN pg_catalog.pg_class c ON c.relname = i.indexname
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        AND n.nspname = i.schemaname
    LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid = c.oid
    WHERE i.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
      AND i.tablename NOT LIKE '_pqdb_%'
    ORDER BY i.tablename, i.indexname
""")

_PUBLICATIONS_SQL = text("""
    SELECT
        p.pubname AS name,
        p.puballtables AS all_tables,
        p.pubinsert AS pub_insert,
        p.pubupdate AS pub_update,
        p.pubdelete AS pub_delete,
        COALESCE(
            array_agg(c.relname ORDER BY c.relname)
            FILTER (WHERE c.relname IS NOT NULL),
            '{}'
        ) AS tables
    FROM pg_catalog.pg_publication p
    LEFT JOIN pg_catalog.pg_publication_rel pr ON pr.prpubid = p.oid
    LEFT JOIN pg_catalog.pg_class c ON c.oid = pr.prrelid
    GROUP BY p.pubname, p.puballtables, p.pubinsert,
             p.pubupdate, p.pubdelete
    ORDER BY p.pubname
""")


@router.get("/functions")
async def list_functions(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List user-defined functions from pg_proc + pg_namespace."""
    result = await session.execute(_FUNCTIONS_SQL)
    return [
        {
            "name": row[0],
            "schema": row[1],
            "args": row[2],
            "return_type": row[3],
            "language": row[4],
            "source": row[5],
        }
        for row in result.fetchall()
    ]


@router.get("/triggers")
async def list_triggers(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List user-defined triggers from pg_trigger + pg_class."""
    result = await session.execute(_TRIGGERS_SQL)
    return [
        {
            "name": row[0],
            "table": row[1],
            "timing": row[2],
            "events": list(row[3]) if row[3] else [],
            "function_name": row[4],
        }
        for row in result.fetchall()
    ]


@router.get("/enums")
async def list_enums(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List user-defined enum types from pg_type + pg_enum."""
    result = await session.execute(_ENUMS_SQL)
    return [
        {
            "name": row[0],
            "schema": row[1],
            "values": list(row[2]) if row[2] else [],
        }
        for row in result.fetchall()
    ]


@router.get("/extensions")
async def list_extensions(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List installed Postgres extensions from pg_extension."""
    result = await session.execute(_EXTENSIONS_SQL)
    return [
        {
            "name": row[0],
            "version": row[1],
            "schema": row[2],
            "comment": row[3],
        }
        for row in result.fetchall()
    ]


@router.get("/indexes")
async def list_indexes(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List indexes from pg_indexes view with size info."""
    result = await session.execute(_INDEXES_SQL)
    return [
        {
            "name": row[0],
            "table": row[1],
            "definition": row[2],
            "unique": bool(row[3]),
            "size_bytes": row[4] or 0,
        }
        for row in result.fetchall()
    ]


@router.get("/publications")
async def list_publications(
    session: AsyncSession = Depends(get_project_session),
) -> list[dict[str, Any]]:
    """List logical replication publications from pg_publication."""
    result = await session.execute(_PUBLICATIONS_SQL)
    return [
        {
            "name": row[0],
            "all_tables": bool(row[1]),
            "insert": bool(row[2]),
            "update": bool(row[3]),
            "delete": bool(row[4]),
            "tables": list(row[5]) if row[5] else [],
        }
        for row in result.fetchall()
    ]


_BACKUPS_SQL = text("""
    SELECT
        archived_count,
        failed_count,
        last_archived_wal,
        last_archived_time,
        last_failed_wal,
        last_failed_time
    FROM pg_catalog.pg_stat_archiver
""")


@router.get("/backups")
async def get_backup_stats(
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """Get WAL archiver stats from pg_stat_archiver."""
    result = await session.execute(_BACKUPS_SQL)
    row = result.fetchone()
    if row is None:
        return {
            "archived_count": 0,
            "failed_count": 0,
            "last_archived_wal": None,
            "last_archived_time": None,
            "last_failed_wal": None,
            "last_failed_time": None,
        }
    return {
        "archived_count": row[0] or 0,
        "failed_count": row[1] or 0,
        "last_archived_wal": row[2],
        "last_archived_time": str(row[3]) if row[3] else None,
        "last_failed_wal": row[4],
        "last_failed_time": str(row[5]) if row[5] else None,
    }


# ---------------------------------------------------------------------------
# Foreign Data Wrappers (US-109)
# ---------------------------------------------------------------------------

_WRAPPERS_SQL = text("""
    SELECT
        fdw.fdwname AS name,
        h.proname AS handler,
        v.proname AS validator
    FROM pg_catalog.pg_foreign_data_wrapper fdw
    LEFT JOIN pg_catalog.pg_proc h ON h.oid = fdw.fdwhandler
    LEFT JOIN pg_catalog.pg_proc v ON v.oid = fdw.fdwvalidator
    ORDER BY fdw.fdwname
""")

_FOREIGN_SERVERS_SQL = text("""
    SELECT
        s.srvname AS name,
        fdw.fdwname AS wrapper,
        COALESCE(s.srvoptions, '{}') AS options
    FROM pg_catalog.pg_foreign_server s
    JOIN pg_catalog.pg_foreign_data_wrapper fdw ON fdw.oid = s.srvfdw
    ORDER BY s.srvname
""")

_FOREIGN_TABLES_SQL = text("""
    SELECT
        ft.foreign_table_name AS name,
        fs.srvname AS server,
        ft.foreign_table_schema AS schema,
        c.column_name AS col_name,
        c.data_type AS col_type
    FROM information_schema.foreign_tables ft
    JOIN pg_catalog.pg_foreign_server fs
        ON fs.srvname = ft.foreign_server_name
    LEFT JOIN information_schema.columns c
        ON c.table_name = ft.foreign_table_name
        AND c.table_schema = ft.foreign_table_schema
    ORDER BY ft.foreign_table_name, c.ordinal_position
""")


@router.get("/wrappers")
async def list_wrappers(
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, Any]:
    """List foreign data wrappers, servers, and foreign tables."""
    wrappers_result = await session.execute(_WRAPPERS_SQL)
    wrappers = [
        {
            "name": row[0],
            "handler": row[1],
            "validator": row[2],
        }
        for row in wrappers_result.fetchall()
    ]

    servers_result = await session.execute(_FOREIGN_SERVERS_SQL)
    servers = [
        {
            "name": row[0],
            "wrapper": row[1],
            "options": list(row[2]) if row[2] else [],
        }
        for row in servers_result.fetchall()
    ]

    tables_result = await session.execute(_FOREIGN_TABLES_SQL)
    tables_map: dict[str, dict[str, Any]] = {}
    for row in tables_result.fetchall():
        tbl_name = row[0]
        if tbl_name not in tables_map:
            tables_map[tbl_name] = {
                "name": tbl_name,
                "server": row[1],
                "schema": row[2],
                "columns": [],
            }
        if row[3]:  # column name present
            tables_map[tbl_name]["columns"].append({"name": row[3], "type": row[4]})

    return {
        "wrappers": wrappers,
        "servers": servers,
        "tables": list(tables_map.values()),
    }


# --- Replication (US-106) ---

_REPLICATION_SLOTS_SQL = text("""
    SELECT
        slot_name,
        slot_type,
        active,
        restart_lsn::text,
        confirmed_flush_lsn::text
    FROM pg_catalog.pg_replication_slots
    ORDER BY slot_name
""")

_REPLICATION_STATS_SQL = text("""
    SELECT
        client_addr::text,
        state,
        sent_lsn::text,
        write_lsn::text,
        replay_lsn::text,
        replay_lag::text
    FROM pg_catalog.pg_stat_replication
    ORDER BY client_addr
""")


@router.get("/replication")
async def list_replication(
    session: AsyncSession = Depends(get_project_session),
) -> dict[str, list[dict[str, Any]]]:
    """List replication slots and active replication connections."""
    slots_result = await session.execute(_REPLICATION_SLOTS_SQL)
    slots = [
        {
            "slot_name": row[0],
            "slot_type": row[1],
            "active": bool(row[2]),
            "restart_lsn": row[3],
            "confirmed_flush_lsn": row[4],
        }
        for row in slots_result.fetchall()
    ]

    stats_result = await session.execute(_REPLICATION_STATS_SQL)
    stats = [
        {
            "client_addr": row[0],
            "state": row[1],
            "sent_lsn": row[2],
            "write_lsn": row[3],
            "replay_lsn": row[4],
            "replay_lag": row[5],
        }
        for row in stats_result.fetchall()
    ]

    return {"slots": slots, "stats": stats}
