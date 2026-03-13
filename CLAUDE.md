# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

pqdb is a multi-tenant database platform with post-quantum cryptography (PQC) and zero-knowledge architecture. The server never holds decryption keys — all sensitive data is encrypted client-side using NIST-standardized PQC algorithms (ML-KEM-768) before transmission.

Full requirements: `tasks/prd-pqdb-mvp.md` | Machine-readable: `prd.json`

## Repository Structure

```
/backend    Python 3.12+ FastAPI API server (managed by uv)
/sdk        TypeScript 5.x @pqdb/client library (npm, bundled with tsup)
/infra      Docker Compose configs, init scripts, deployment
```

## Build & Dev Commands

### Backend (`/backend`)
```bash
uv sync                          # Install dependencies
uv run pytest                    # Run all tests
uv run pytest tests/unit/        # Unit tests only
uv run pytest tests/integration/ # Integration tests only
uv run pytest -k "test_name"     # Single test by name
uv run ruff check .              # Lint
uv run ruff format .             # Format
uv run mypy .                    # Type check (strict)
uv run uvicorn pqdb_api.app:create_app --factory --reload  # Dev server
uv run alembic upgrade head      # Run migrations
uv run alembic revision --autogenerate -m "description"    # Create migration
```

### SDK (`/sdk`)
```bash
npm install                      # Install dependencies
npm test                         # Run vitest
npm test -- --run tests/unit/    # Unit tests only
npm test -- -t "test name"       # Single test by name
npm run build                    # Production build (tsup → dist/)
npm run typecheck                # tsc --noEmit (strict mode)
```

### Infrastructure
```bash
docker compose -f infra/compose.yaml up -d     # Start Postgres + Vault
docker compose -f infra/compose.yaml down -v    # Tear down with volumes
```

## Architecture

### Multi-Tenancy Model

- **Platform database** (`pqdb_platform`): developer accounts, projects, API keys
- **Project databases** (`pqdb_project_{uuid}`): one isolated Postgres DB per project, provisioned on project creation

### Three Column Sensitivity Levels

| Level | Physical Columns | Queryable | Client Operations |
|-------|-----------------|-----------|-------------------|
| `searchable` | `{col}_encrypted` (bytea) + `{col}_index` (text) | `.eq()`, `.in()` only | ML-KEM encrypt + HMAC-SHA3-256 blind index |
| `private` | `{col}_encrypted` (bytea) | No server-side filtering | ML-KEM encrypt only |
| `plain` | `{col}` (native type) | All filter ops | Passthrough |

The original column name is **never** created in the physical table for sensitive fields. The SDK transparently maps `email` → `email_encrypted`/`email_index`.

### Shadow Column Naming Convention
- Encrypted: `{original_name}_encrypted` (bytea)
- Blind index: `{original_name}_index` (text)
- Metadata tracked in `_pqdb_columns` table per project database

### Authentication & Authorization

- **Developer auth**: Ed25519 JWT (PyJWT + cryptography), argon2id password hashing
- **Project auth**: API keys in `apikey` header, format `pqdb_{role}_{random_32_chars}`, stored as argon2id hashes
- **Two API key roles**: `anon` and `service_role` per project
- **HMAC keys**: per-project, 256-bit, stored in HashiCorp Vault at `secret/pqdb/projects/{project_id}/hmac`

### Request Flow

```
SDK (client-side encrypt) → apikey header → API middleware validates key
→ resolves project_id → routes to project database → returns ciphertext
→ SDK (client-side decrypt) → plaintext to developer
```

### API Structure

All endpoints prefixed with `/v1/`. Error format: `{"error": {"code": "...", "message": "..."}}`.

- `/health`, `/ready` — platform health
- `/v1/auth/*` — developer signup/login/refresh
- `/v1/projects/*` — project CRUD, API keys, HMAC key retrieval
- `/v1/db/*` — project-scoped: table management, CRUD, introspection (requires `apikey` header)

## Coding Conventions

### Backend (Python)
- FastAPI with async handlers, SQLAlchemy async engine
- App factory pattern in `src/pqdb_api/app.py` with lifespan handler
- Structured JSON logging via `structlog`
- Alembic for all schema migrations against platform DB
- `mypy --strict` must pass

### SDK (TypeScript)
- Strict mode, ES2022 target, ESM + CJS dual output via tsup
- Query builder pattern: `client.from(table).select().eq(col, val)`
- All query execution returns `{ data, error }` — never throws
- All crypto operations are async (WASM)
- `tsc --noEmit` must pass with zero errors

### Testing
- **TDD**: write failing test first, then implement
- **Test pyramid**: many unit tests, some integration, few E2E
- Backend integration tests: boot the real FastAPI app with `TestClient`, hit actual endpoints
- SDK unit tests: test query builder payloads, crypto round-trips, shadow column mapping
- E2E tests: Docker Compose + real backend + SDK, full encrypt/query/decrypt round-trip

### Dependencies
- Backend: use `uv add <package>` (never edit pyproject.toml manually)
- SDK: use `npm install <package>` (commit package-lock.json)
- Always pin exact versions

## Non-Goals (Phase 1)

These are explicitly deferred — do not implement:
- Dashboard/Studio UI (Phase 3)
- MCP server for AI agents (Phase 3)
- PQC TLS / ML-DSA-65 auth tokens (Phase 2)
- Vector similarity search `.similarTo()` (Phase 3)
- Realtime subscriptions (Phase 3)
- Key rotation (Phase 2)
- Range queries on encrypted columns (mathematically impossible with blind indexing)
- npm publishing (SDK used locally via workspace)
- Auth-as-a-service for end-users (Phase 2)
- Passkey/WebAuthn developer login (Phase 3 — needs dashboard UI)
