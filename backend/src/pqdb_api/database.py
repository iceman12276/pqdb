"""SQLAlchemy async engine and session setup."""

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

_engine: AsyncEngine | None = None


def get_engine() -> AsyncEngine:
    """Return the current async engine. Raises if not initialized."""
    if _engine is None:
        msg = "Database engine not initialized. Call init_engine() first."
        raise RuntimeError(msg)
    return _engine


def init_engine(database_url: str) -> AsyncEngine:
    """Create and store the async engine with connection pooling."""
    global _engine  # noqa: PLW0603
    _engine = create_async_engine(
        database_url,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
    )
    return _engine


async def dispose_engine() -> None:
    """Dispose the current engine, closing all connections."""
    global _engine  # noqa: PLW0603
    if _engine is not None:
        await _engine.dispose()
        _engine = None
