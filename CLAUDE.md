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
uv run uvicorn pqdb_api.app:create_app --factory --reload --host 0.0.0.0  # Dev server (0.0.0.0 required for Caddy Docker proxy)
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
docker compose -f infra/compose.yaml up -d     # Start Postgres + Vault + Caddy
docker compose -f infra/compose.yaml down -v    # Tear down with volumes
```

### Full Local Dev Stack
Start everything in order:
```bash
# 1. Infrastructure (Postgres, Vault, Caddy TLS proxy)
docker compose -f infra/compose.yaml up -d

# 2. Backend (must use --host 0.0.0.0 for Caddy Docker to reach it)
cd backend && uv run alembic upgrade head
uv run uvicorn pqdb_api.app:create_app --factory --reload --host 0.0.0.0

# 3. Dashboard (must use --host 0.0.0.0 for Caddy Docker to reach it)
cd dashboard && npm run dev -- --host 0.0.0.0

# 4. MCP Server (optional, set PQDB_DASHBOARD_URL if Caddy is on non-standard port)
cd mcp && node dist/cli.js --transport http --port 3002 --project-url http://localhost:8000
```

Access via:
- Dashboard: https://localhost (or https://localhost:8443 if port 80/443 is in use)
- Backend API: https://localhost/v1/ (proxied by Caddy)
- MCP Server: http://localhost:3002

**Port conflicts:** If port 80/443 is in use by another container, change Caddy ports in
`infra/compose.yaml` (e.g., `8443:443`, `8080:80`) and set `PQDB_DASHBOARD_URL=https://localhost:8443`
when starting the MCP server. Use `pkexec ss -tlnp | grep ':80 '` to find the conflicting process.

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

### Integration test acceptance criteria (MANDATORY for PRDs)

A PRD story is NOT complete until an integration test proves the **user-observable outcome**, not just that the pipeline connects. Acceptance criteria like "proxy can list tools" or "server responds to health check" are transport-layer smoke tests — necessary but never sufficient on their own.

**When writing acceptance criteria for any story that spans service boundaries** (proxy ↔ server, client ↔ API, SDK ↔ backend, MCP ↔ dashboard), the story must include one integration test that:

1. **Exercises the real user goal**, not a proxy for it. If the feature is "data inserted via MCP is decryptable in the dashboard," the test must insert via MCP and then read it back via the other path and assert the plaintext matches. "MCP can connect" is not the goal.
2. **Uses real components across the boundary**, not mocks on both sides. Mock one side at most; the other side must be the real implementation so the wire format, serialization, and error handling are actually exercised.
3. **Asserts on the observable outcome a user would see**, not on intermediate internal state. "Response status was 200" is weaker than "the decrypted plaintext equals the inserted plaintext."
4. **Includes an adversarial assertion** where it's cheap — for crypto features, verify that an actor with the wrong key gets nothing useful. This turns the zero-knowledge guarantee into a test property.

Precedent: see `mcp/tests/e2e/proxy-crypto-roundtrip.test.ts` for the canonical pattern — real backend, real hosted MCP over HTTP, real proxy CryptoInterceptor, plaintext-marker assertions on both the plaintext round-trip and the foreign-key adversarial case.

**Anti-pattern (from the Phase 5e incident)**: US-010 through US-016 shipped with the acceptance criterion "integration test: start hosted MCP, start proxy, verify proxy connects and can list tools." Five stacked bugs in the crypto pipeline were invisible to that test because it never exercised crypto. The story read as "complete" for weeks until the first real insert-and-decrypt attempt was made. Do not let this happen again.

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
