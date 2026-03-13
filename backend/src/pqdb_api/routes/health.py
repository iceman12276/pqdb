"""Health and readiness endpoints."""

import structlog
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from pqdb_api.database import get_engine

logger = structlog.get_logger()

router = APIRouter()


@router.get("/health")
async def health() -> dict[str, str]:
    """Liveness probe — always returns 200."""
    return {"status": "ok"}


@router.get("/ready")
async def ready() -> JSONResponse:
    """Readiness probe — checks Postgres connectivity."""
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return JSONResponse(status_code=200, content={"status": "ok"})
    except Exception:
        logger.warning("readiness_check_failed", exc_info=True)
        return JSONResponse(status_code=503, content={"status": "unavailable"})
