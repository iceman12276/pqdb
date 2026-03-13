"""SQLAlchemy async engine and session setup."""

from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """Return the current async engine. Raises if not initialized."""
    if _engine is None:
        msg = "Database engine not initialized. Call init_engine() first."
        raise RuntimeError(msg)
    return _engine


def init_engine(database_url: str) -> AsyncEngine:
    """Create and store the async engine with connection pooling."""
    global _engine, _session_factory  # noqa: PLW0603
    _engine = create_async_engine(
        database_url,
        pool_size=5,
        max_overflow=10,
        pool_pre_ping=True,
    )
    _session_factory = async_sessionmaker(
        _engine, class_=AsyncSession, expire_on_commit=False
    )
    return _engine


async def dispose_engine() -> None:
    """Dispose the current engine, closing all connections."""
    global _engine, _session_factory  # noqa: PLW0603
    if _engine is not None:
        await _engine.dispose()
        _engine = None
        _session_factory = None


async def get_session() -> AsyncIterator[AsyncSession]:
    """Yield an async database session. For use as a FastAPI dependency."""
    if _session_factory is None:
        msg = "Session factory not initialized. Call init_engine() first."
        raise RuntimeError(msg)
    async with _session_factory() as session:
        yield session
