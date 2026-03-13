# PRD: pqdb Phase 1 — Core MVP

## Introduction

pqdb is a developer-first, multi-tenant database platform that combines the Supabase-like developer experience with post-quantum cryptography (PQC) and a zero-knowledge architecture. The server never holds decryption keys — all sensitive data is encrypted client-side using NIST-standardized PQC algorithms before it leaves the developer's application.

Phase 1 delivers the Core MVP: a working encrypted database platform that a developer can connect to via a TypeScript SDK, define schemas with column-level sensitivity, store PQC-encrypted data, query via blind indexes, and receive transparently decrypted results — all with database-per-project isolation.

### Problem

Existing database platforms (Supabase, Firebase, PlanetScale) store data in plaintext on the server. Developers building privacy-sensitive applications must bolt on encryption as an afterthought, and none offer post-quantum protection. As quantum computing advances, data harvested today ("harvest now, decrypt later") becomes vulnerable. There is no developer-friendly platform that provides zero-knowledge guarantees with PQC out of the box.

### Solution

A platform where:
1. The server literally cannot read sensitive data (zero-knowledge)
2. All encryption uses NIST-standardized post-quantum algorithms (ML-KEM-768)
3. Searchable encryption via blind indexing allows exact-match queries on encrypted columns
4. A TypeScript SDK makes encryption transparent — developers use a familiar query builder

## Goals

- **G-1:** Developer can sign up, create a project, and receive API keys via the platform API
- **G-2:** Each project gets an isolated Postgres database (database-per-project multi-tenancy)
- **G-3:** Schema engine auto-generates shadow columns (`_encrypted`, `_index`) based on sensitivity declarations
- **G-4:** SDK encrypts sensitive data client-side using ML-KEM-768 before transmission
- **G-5:** SDK computes HMAC-based blind indexes client-side for searchable encrypted columns
- **G-6:** Server stores only ciphertext and blind index hashes — never plaintext for sensitive columns
- **G-7:** CRUD operations work transparently through the SDK with automatic encrypt/decrypt
- **G-8:** HMAC keys are stored in HashiCorp Vault from day one (no migration needed later)
- **G-9:** E2E round-trip proven: SDK insert → API → DB storage → SDK query → decrypted result

## User Stories

### US-001: Monorepo scaffolding
**Description:** As a developer, I want a well-structured monorepo so that backend, SDK, and infrastructure code are organized with proper tooling from the start.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Create `/backend` directory with Python project: `pyproject.toml` using `uv`, `src/pqdb_api/` package structure
- [ ] Create `/sdk` directory with TypeScript project: `package.json`, `tsconfig.json`, `src/` structure
- [ ] Create `/infra` directory for Docker Compose and deployment configs
- [ ] Root `.gitignore` covers Python (`__pycache__`, `.venv`), Node (`node_modules`, `dist`), and IDE files
- [ ] Root `CLAUDE.md` with project conventions, repo structure, and build commands
- [ ] `uv` lockfile committed for backend; `package-lock.json` committed for SDK
- [ ] Unit tests pass
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-002: Docker Compose development environment
**Description:** As a developer, I want a single `docker compose up` command to start Postgres and Vault so that I can develop locally without manual service setup.

**Dependencies:** US-001

**Acceptance Criteria:**
- [ ] `infra/compose.yaml` defines `postgres` service (PostgreSQL 16) and `vault` service (HashiCorp Vault in dev mode)
- [ ] `.env.example` with all required environment variables documented
- [ ] Postgres healthcheck ensures database is ready before dependent services
- [ ] Vault initializes with a dev root token and transit secrets engine enabled
- [ ] `pgvector` extension is available in the Postgres image
- [ ] A platform database (`pqdb_platform`) is auto-created on first boot via init script
- [ ] `docker compose up` starts all services cleanly; `docker compose down -v` tears down completely
- [ ] Unit tests pass
- [ ] Integration tests pass (services start and respond to health checks)
- [ ] CI passes

---

### US-003: CI pipeline
**Description:** As a developer, I want automated CI so that every push runs linting, typechecking, and tests for both backend and SDK.

**Dependencies:** US-001

**Acceptance Criteria:**
- [ ] `.github/workflows/ci.yml` triggers on push and pull request to `main`
- [ ] Backend job: install via `uv`, run `ruff` lint, `mypy` typecheck, `pytest` tests
- [ ] SDK job: `npm ci`, `tsc --noEmit` typecheck, test runner (vitest)
- [ ] Both jobs run in parallel
- [ ] Docker Compose services start in CI for integration tests (Postgres + Vault)
- [ ] CI passes on a clean checkout with no test failures
- [ ] Unit tests pass
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-004: FastAPI project skeleton with health check
**Description:** As a developer, I want a FastAPI application with proper structure so that I can build platform and project endpoints on a solid foundation.

**Dependencies:** US-001

**Acceptance Criteria:**
- [ ] FastAPI app factory in `src/pqdb_api/app.py` with lifespan handler
- [ ] `GET /health` returns `{"status": "ok"}` with 200
- [ ] `GET /ready` checks Postgres connectivity and returns 200/503
- [ ] CORS middleware configured (permissive for MVP, tighten later)
- [ ] Structured JSON logging via `structlog`
- [ ] SQLAlchemy async engine setup with connection pooling
- [ ] Alembic configured for migrations against the platform database
- [ ] `uvicorn` entrypoint in `pyproject.toml` scripts
- [ ] Unit tests pass
- [ ] Integration tests pass (health and readiness endpoints respond correctly)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-005: Platform developer authentication
**Description:** As a developer, I want to sign up and log in to the pqdb platform so that I can manage my projects.

**Dependencies:** US-004, US-002

**Acceptance Criteria:**
- [ ] `developers` table in platform DB: `id` (UUID), `email` (unique), `password_hash`, `created_at`
- [ ] Alembic migration creates the `developers` table
- [ ] `POST /v1/auth/signup` accepts `{email, password}`, returns JWT access + refresh tokens
- [ ] `POST /v1/auth/login` accepts `{email, password}`, validates credentials, returns tokens
- [ ] `POST /v1/auth/refresh` accepts refresh token, returns new access token
- [ ] JWT tokens signed with Ed25519 (PyJWT + cryptography library)
- [ ] Auth middleware extracts and validates JWT from `Authorization: Bearer` header
- [ ] Password hashed with argon2id
- [ ] Returns 401 for invalid/expired tokens, 409 for duplicate email on signup
- [ ] Unit tests pass
- [ ] Integration tests pass (signup → login → authenticated request flow)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-006: Project CRUD API
**Description:** As an authenticated developer, I want to create, list, get, and delete projects so that I can manage isolated database environments.

**Dependencies:** US-005

**Acceptance Criteria:**
- [ ] `projects` table in platform DB: `id` (UUID), `developer_id` (FK), `name`, `region`, `status`, `created_at`
- [ ] Alembic migration creates the `projects` table
- [ ] `POST /v1/projects` creates a project (name required, region optional defaults to "us-east-1")
- [ ] `GET /v1/projects` lists all projects for the authenticated developer
- [ ] `GET /v1/projects/{id}` returns project details (scoped to developer)
- [ ] `DELETE /v1/projects/{id}` soft-deletes the project (sets status to "archived")
- [ ] All endpoints require valid JWT; return 401 without it
- [ ] Returns 404 when accessing another developer's project
- [ ] Unit tests pass
- [ ] Integration tests pass (CRUD operations work end-to-end)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-007: Database-per-project provisioning
**Description:** As a developer, when I create a project, I want an isolated Postgres database provisioned automatically so that my project data is fully separated from other projects.

**Dependencies:** US-006, US-002

**Acceptance Criteria:**
- [ ] Creating a project (US-006) triggers provisioning of a new Postgres database named `pqdb_project_{uuid_short}`
- [ ] Provisioner connects to Postgres as superuser and runs `CREATE DATABASE`
- [ ] A dedicated database user is created per project with limited privileges (no superuser)
- [ ] `projects` table updated with `database_name` and `status = "active"` after provisioning
- [ ] Provisioning failure sets `status = "provisioning_failed"` with error details
- [ ] Deleting a project does NOT drop the database (soft delete only for MVP)
- [ ] Connection pooling configuration supports routing to per-project databases
- [ ] Unit tests pass
- [ ] Integration tests pass (project creation results in a reachable database)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-008: Project API key generation
**Description:** As a developer, I want API keys generated for each project so that my applications can authenticate against a specific project's database.

**Dependencies:** US-006

**Acceptance Criteria:**
- [ ] `api_keys` table in platform DB: `id`, `project_id` (FK), `key_hash`, `key_prefix` (first 8 chars), `role` (anon/service), `created_at`
- [ ] Alembic migration creates the `api_keys` table
- [ ] Creating a project auto-generates both an `anon` key and a `service_role` key
- [ ] `GET /v1/projects/{id}/keys` lists keys (shows prefix only, not full key)
- [ ] `POST /v1/projects/{id}/keys/rotate` generates new keys and invalidates old ones
- [ ] Keys are returned in full ONLY at creation time (one-time display)
- [ ] Keys are stored as argon2id hashes (never plaintext)
- [ ] API key format: `pqdb_{role}_{random_32_chars}` (e.g., `pqdb_anon_a1b2c3...`)
- [ ] Unit tests pass
- [ ] Integration tests pass (key generation and listing work)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-009: Project-scoped request routing
**Description:** As a developer using API keys, I want my requests automatically routed to my project's database so that all operations are project-isolated.

**Dependencies:** US-008, US-007

**Acceptance Criteria:**
- [ ] Middleware reads `apikey` header from incoming requests
- [ ] Middleware validates key by hashing and comparing against `api_keys` table
- [ ] On valid key, middleware resolves `project_id` → `database_name` and injects a project-scoped DB session into the request
- [ ] All `/v1/db/*` endpoints use the project-scoped session (not the platform DB)
- [ ] Returns 401 for missing key, 403 for invalid key
- [ ] Request context carries `project_id` and `key_role` for downstream authorization
- [ ] Connection to project database is pooled and reused across requests
- [ ] Unit tests pass
- [ ] Integration tests pass (request with valid API key reaches correct project database)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-010: Schema engine — column sensitivity metadata
**Description:** As a developer, I want to declare column sensitivity levels so that the server automatically creates shadow columns for encrypted and indexed data.

**Dependencies:** US-009

**Acceptance Criteria:**
- [ ] `POST /v1/db/tables` accepts a table definition with columns and sensitivity levels: `searchable`, `private`, or `plain` (default)
- [ ] `_pqdb_columns` metadata table auto-created in each project database storing: `table_name`, `column_name`, `sensitivity`, `data_type`
- [ ] For `sensitive('searchable')` columns: creates `{col}_encrypted` (bytea) and `{col}_index` (text) shadow columns
- [ ] For `sensitive('private')` columns: creates `{col}_encrypted` (bytea) shadow column only
- [ ] For `plain` columns: creates the column as-is with standard SQL type
- [ ] Original column name is NOT created in the physical table (only shadow columns exist for sensitive fields)
- [ ] `pgvector` extension enabled; `vector(N)` type supported for plain columns
- [ ] `GET /v1/db/tables` lists all tables in the project database with column metadata
- [ ] `GET /v1/db/tables/{name}` returns full schema including sensitivity levels
- [ ] Unit tests pass
- [ ] Integration tests pass (table creation results in correct physical columns)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-011: Vault HMAC key management
**Description:** As a platform operator, I want per-project HMAC keys stored in HashiCorp Vault so that blind index computation uses securely managed keys.

**Dependencies:** US-009, US-002

**Acceptance Criteria:**
- [ ] On project creation, generate a unique HMAC key and store it in Vault at `secret/pqdb/projects/{project_id}/hmac`
- [ ] `GET /v1/projects/{id}/hmac-key` returns the HMAC key to authenticated project owners (developer JWT required)
- [ ] SDK retrieves HMAC key once at client initialization and caches it in memory
- [ ] HMAC key is 256-bit, generated using `secrets.token_bytes(32)`
- [ ] Vault access uses AppRole auth method (not dev root token) in non-dev environments
- [ ] Key retrieval endpoint is rate-limited (max 10 requests/minute per project)
- [ ] Unit tests pass
- [ ] Integration tests pass (key stored in Vault, retrievable via API)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-012: CRUD endpoints with project scoping and blind index routing
**Description:** As a developer, I want to INSERT, SELECT, UPDATE, and DELETE data through the API with automatic blind-index-aware query routing so that encrypted columns are queryable without the server seeing plaintext.

**Dependencies:** US-010, US-011

**Acceptance Criteria:**
- [ ] `POST /v1/db/{table}/insert` accepts rows with `_encrypted` and `_index` suffixed fields, stores in correct shadow columns
- [ ] `POST /v1/db/{table}/select` accepts filters; `.eq()` on a searchable column is rewritten to `WHERE {col}_index = ?`
- [ ] `POST /v1/db/{table}/update` accepts filters + update payload; matches via blind index, updates encrypted columns
- [ ] `POST /v1/db/{table}/delete` accepts filters; matches via blind index
- [ ] `select` supports: `columns` (projection), `filters` (eq, gt, lt, gte, lte, in — plain columns only for range ops), `limit`, `offset`, `order_by`
- [ ] Filtering on `private` columns returns 400 ("column is not searchable")
- [ ] All endpoints validate against `_pqdb_columns` metadata — reject unknown columns
- [ ] All endpoints enforce project scoping via US-009 middleware
- [ ] Returns proper error codes: 400 (bad request), 404 (table not found), 409 (unique constraint violation)
- [ ] Unit tests pass
- [ ] Integration tests pass (insert → select → update → delete round-trip with blind index)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-013: Schema introspection endpoint
**Description:** As an AI agent or SDK consumer, I want to query schema metadata so that I know which columns are queryable, which operations are valid, and which columns are encrypted.

**Dependencies:** US-010

**Acceptance Criteria:**
- [ ] `GET /v1/db/introspect` returns all tables with column metadata for the project
- [ ] `GET /v1/db/introspect/{table}` returns column-level detail for a specific table
- [ ] Response includes per-column: `name`, `type`, `sensitivity` (searchable/private/plain), `queryable` (bool), `operations` (list of valid filter ops)
- [ ] `searchable` columns: `queryable: true`, `operations: ["eq", "in"]`
- [ ] `private` columns: `queryable: false`, `note: "retrieve only — no server-side filtering"`
- [ ] `plain` columns: `queryable: true`, `operations: ["eq", "gt", "lt", "gte", "lte", "in", "between"]`
- [ ] Response includes `sensitivity_summary`: count of searchable, private, and plain columns
- [ ] Endpoint requires valid API key (anon or service role)
- [ ] Unit tests pass
- [ ] Integration tests pass (introspection returns accurate schema after table creation)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-014: Schema migrations
**Description:** As a developer, I want to add, remove, and alter columns on existing tables while preserving encryption metadata and shadow columns.

**Dependencies:** US-010

**Acceptance Criteria:**
- [ ] `POST /v1/db/tables/{name}/columns` adds a column with sensitivity declaration
- [ ] Adding a `searchable` column creates both `_encrypted` and `_index` shadow columns
- [ ] Adding a `private` column creates only `_encrypted` shadow column
- [ ] `DELETE /v1/db/tables/{name}/columns/{col}` removes the column and its shadow columns
- [ ] `_pqdb_columns` metadata table is updated atomically with DDL changes (wrapped in transaction)
- [ ] Cannot change sensitivity level of an existing column (must drop and re-add)
- [ ] Cannot drop a table's primary key column
- [ ] Returns 409 if column already exists, 404 if table/column not found
- [ ] Unit tests pass
- [ ] Integration tests pass (add column, verify shadow columns exist, drop column, verify cleanup)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-015: SDK project setup
**Description:** As an SDK developer, I want a properly configured TypeScript project so that I can build the `@pqdb/client` library with type safety and modern tooling.

**Dependencies:** US-001

**Acceptance Criteria:**
- [ ] `sdk/package.json` with name `@pqdb/client`, proper exports configuration (ESM + CJS dual)
- [ ] `tsconfig.json` with strict mode, ES2022 target, declaration output
- [ ] Build pipeline using `tsup` for bundling (ESM + CJS output)
- [ ] Vitest configured for unit tests with TypeScript support
- [ ] Source structure: `src/index.ts` barrel export, `src/client/`, `src/crypto/`, `src/query/`
- [ ] `npm run build` produces `dist/` with `.js`, `.mjs`, and `.d.ts` files
- [ ] `npm run test` runs vitest
- [ ] `npm run typecheck` runs `tsc --noEmit`
- [ ] Unit tests pass (at least one smoke test)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-016: PQC crypto evaluation spike
**Description:** As the engineering team, we need to evaluate PQC WASM libraries for the TypeScript SDK so that we choose the right ML-KEM implementation for client-side encryption.

**Dependencies:** US-015

**Acceptance Criteria:**
- [ ] Evaluate at minimum: Cloudflare CIRCL (Go→WASM), liboqs-WASM, pqcrypto-wasm, and any other viable candidates
- [ ] For each candidate, measure: WASM bundle size, ML-KEM-768 keygen/encaps/decaps latency, browser compatibility, Node.js compatibility
- [ ] Produce `sdk/docs/pqc-spike-results.md` with comparison table, recommendation, and rationale
- [ ] Implement a proof-of-concept test: generate keypair → encapsulate → decapsulate → verify shared secret matches
- [ ] Recommendation includes fallback strategy if primary choice has issues
- [ ] HMAC-SHA3-256 implementation identified (may be same library or separate)
- [ ] Unit tests pass (proof-of-concept round-trip test)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-017: SDK createClient and authentication
**Description:** As a developer using the SDK, I want to initialize a client and authenticate so that I can make authenticated requests to my pqdb project.

**Dependencies:** US-015, US-008

**Acceptance Criteria:**
- [ ] `createClient(projectUrl, apiKey, options?)` factory function exported from `@pqdb/client`
- [ ] Options include `encryptionKey` (master key for ML-KEM — never transmitted to server)
- [ ] Client stores API key and sends it in `apikey` header on all requests
- [ ] `client.auth.signUp({email, password})` calls platform signup endpoint
- [ ] `client.auth.signIn({email, password})` calls platform login endpoint, stores JWT
- [ ] `client.auth.signOut()` clears stored tokens
- [ ] JWT auto-attached to platform API requests via `Authorization: Bearer` header
- [ ] Token refresh handled automatically when access token expires
- [ ] HTTP client uses `fetch` (works in browser + Node.js)
- [ ] Full TypeScript types for all options, responses, and errors
- [ ] Unit tests pass (client construction, header attachment, auth flow with mocked HTTP)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-018: SDK defineTable and query builder
**Description:** As a developer, I want to define table schemas and build queries in TypeScript so that I get type-safe access to my pqdb data.

**Dependencies:** US-017

**Acceptance Criteria:**
- [ ] `client.defineTable(name, schema)` registers a table with typed columns
- [ ] Column helpers: `column.uuid()`, `column.text()`, `column.integer()`, `column.timestamp()`, `column.boolean()`, `column.vector(dimensions)`
- [ ] Sensitivity decorator: `column.text().sensitive('searchable')`, `column.text().sensitive('private')`
- [ ] `.primaryKey()` chain marks the primary key column
- [ ] `client.from(table).select(columns?)` builds SELECT query
- [ ] `client.from(table).insert(rows)` builds INSERT
- [ ] `client.from(table).update(values)` builds UPDATE
- [ ] `client.from(table).delete()` builds DELETE
- [ ] Filter chains: `.eq(col, val)`, `.gt()`, `.lt()`, `.gte()`, `.lte()`, `.in(col, vals)`
- [ ] Modifier chains: `.limit(n)`, `.offset(n)`, `.order(col, direction)`
- [ ] Query execution returns `{ data, error }` — never throws
- [ ] TypeScript generics infer row types from table schema definition
- [ ] Unit tests pass (query builder produces correct request payloads)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-019: SDK encryption layer and blind indexing
**Description:** As a developer, I want the SDK to automatically encrypt sensitive columns and compute blind indexes so that encryption is transparent and I never send plaintext to the server.

**Dependencies:** US-018, US-016

**Acceptance Criteria:**
- [ ] On first query, SDK retrieves HMAC key from server (`GET /v1/projects/{id}/hmac-key`) and caches in memory
- [ ] On `.insert()`: `searchable` columns → ML-KEM encrypt value → set `{col}_encrypted`, compute HMAC-SHA3-256 → set `{col}_index`
- [ ] On `.insert()`: `private` columns → ML-KEM encrypt value → set `{col}_encrypted`
- [ ] On `.insert()`: `plain` columns → pass through unchanged
- [ ] On `.eq(col, val)` for searchable columns: compute HMAC of `val` → send `{col}_index = hash` to server
- [ ] On `.select()` response: ML-KEM decrypt `_encrypted` columns → return plaintext to developer under original column names
- [ ] Shadow column management is fully transparent — developer code references `email`, SDK translates to `email_encrypted`/`email_index`
- [ ] `encryptionKey` is used to derive ML-KEM keypair deterministically (or stored as keypair)
- [ ] All crypto operations are async (WASM may be async)
- [ ] Error on `.gt()`, `.lt()`, etc. against sensitive columns with clear message: "Range queries not supported on encrypted columns"
- [ ] Unit tests pass (encrypt → decrypt round-trip, blind index determinism, shadow column mapping)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-020: E2E integration tests
**Description:** As the engineering team, we need end-to-end tests proving the full round-trip works: SDK creates a table, inserts encrypted data, queries via blind index, and receives decrypted results.

**Dependencies:** US-012, US-019

**Acceptance Criteria:**
- [ ] Test setup: Docker Compose starts Postgres + Vault, FastAPI backend runs against them
- [ ] **Test 1 — Platform flow:** SDK signs up developer → creates project → receives API keys
- [ ] **Test 2 — Schema flow:** SDK creates a table with searchable, private, and plain columns → verify shadow columns exist via introspection
- [ ] **Test 3 — Insert + Select round-trip:** Insert a row with encrypted fields → SELECT with `.eq()` on searchable column → verify decrypted result matches original plaintext
- [ ] **Test 4 — Zero-knowledge verification:** Directly query the project database (bypassing SDK) → verify sensitive columns contain only ciphertext and HMAC hashes, never plaintext
- [ ] **Test 5 — Update + Delete:** Update a row matched by blind index → verify updated ciphertext differs → Delete row → verify gone
- [ ] **Test 6 — Project isolation:** Two projects created → data inserted in project A is not accessible from project B's API key
- [ ] All 6 tests pass
- [ ] CI passes (tests run in CI with Docker Compose)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-001: Monorepo scaffolding              (Dependencies: None)
US-002: Docker Compose                    (Dependencies: US-001)
US-003: CI pipeline                       (Dependencies: US-001)         ← parallel with US-002, US-004, US-015
US-004: FastAPI skeleton                  (Dependencies: US-001)         ← parallel with US-002, US-003, US-015
US-005: Platform auth                     (Dependencies: US-004, US-002)
US-006: Project CRUD                      (Dependencies: US-005)
US-007: DB-per-project provisioning       (Dependencies: US-006, US-002)
US-008: API key generation                (Dependencies: US-006)         ← parallel with US-007
US-009: Project-scoped routing            (Dependencies: US-008, US-007)
US-010: Schema engine                     (Dependencies: US-009)
US-011: Vault HMAC keys                   (Dependencies: US-009, US-002) ← parallel with US-010
US-012: CRUD endpoints                    (Dependencies: US-010, US-011)
US-013: Schema introspection              (Dependencies: US-010)         ← parallel with US-012, US-014
US-014: Schema migrations                 (Dependencies: US-010)         ← parallel with US-012, US-013
US-015: SDK project setup                 (Dependencies: US-001)         ← parallel with US-002, US-003, US-004
US-016: PQC evaluation spike              (Dependencies: US-015)
US-017: SDK client + auth                 (Dependencies: US-015, US-008) ← waits for backend API keys
US-018: SDK tables + query builder        (Dependencies: US-017)
US-019: SDK encryption + blind indexing   (Dependencies: US-018, US-016)
US-020: E2E integration tests             (Dependencies: US-012, US-019)
```

### Parallel Execution Chains

```
Chain A (Backend):  US-001 → US-002 → US-005 → US-006 → US-007 → US-009 → US-010 → US-011 → US-012
                                  ↗                    ↗
               US-004 ──────────┘          US-008 ───┘

Chain B (Backend ancillary): US-010 → US-013 (parallel)
                             US-010 → US-014 (parallel)

Chain C (SDK):      US-015 → US-016 ────────────────────────────────────────┐
                    US-015 → US-017 (waits for US-008) → US-018 → US-019 ←─┘

Chain D (CI):       US-003 (independent after US-001)

Chain E (E2E):      US-020 (converges Chain A + Chain C)
```

**Critical path:** US-001 → US-002/US-004 → US-005 → US-006 → US-008 → US-009 → US-010 → US-011 → US-012 → US-020

**Parallel work while backend progresses:** US-015 → US-016 (PQC spike) runs while backend builds through US-002–US-008.

## Functional Requirements

- **FR-1:** Multi-tenant platform with developer accounts authenticated via Ed25519 JWT tokens
- **FR-2:** Database-per-project isolation — each project gets a dedicated Postgres database
- **FR-3:** Three column sensitivity levels: `searchable` (encrypted + blind index), `private` (encrypted only), `plain` (no encryption)
- **FR-4:** Shadow columns auto-generated: `{col}_encrypted` (bytea) for ciphertext, `{col}_index` (text) for blind index hash
- **FR-5:** Blind index queries: `.eq()` on searchable columns uses HMAC-SHA3-256 hash comparison — server never sees the search term
- **FR-6:** ML-KEM-768 (FIPS 203) for client-side encryption of sensitive columns
- **FR-7:** HMAC keys generated per-project and stored in HashiCorp Vault
- **FR-8:** SDK computes all encryption and HMAC operations client-side — the server receives only ciphertext and hashes
- **FR-9:** Project API keys (`pqdb_anon_*`, `pqdb_service_*`) for authenticating SDK requests to a specific project
- **FR-10:** Schema introspection API returns column sensitivity, queryability, and valid operations for agent consumption
- **FR-11:** TypeScript SDK with `createClient()`, `defineTable()`, query builder (`.from().select().eq().insert()` etc.)
- **FR-12:** SDK transparently maps developer-facing column names to physical shadow columns
- **FR-13:** Docker Compose development environment with Postgres and Vault

## Non-Goals

- **NG-1:** Dashboard / Studio UI — deferred to Phase 3
- **NG-2:** MCP server for AI agents — deferred to Phase 3
- **NG-3:** PQC TLS (ML-KEM key exchange at transport layer) — deferred to Phase 2; MVP uses standard TLS
- **NG-4:** ML-DSA-65 auth tokens — deferred to Phase 2; MVP uses Ed25519 JWT
- **NG-5:** Vector similarity search (`.similarTo()`) — deferred to Phase 3; pgvector extension enabled but not exposed
- **NG-6:** Realtime subscriptions — deferred to Phase 3
- **NG-7:** Multi-region deployment — deferred to Phase 4
- **NG-8:** Kubernetes deployment — Phase 1 is local Docker Compose only
- **NG-9:** Key rotation — HMAC keys are static in MVP; rotation in Phase 2
- **NG-10:** Range queries on encrypted columns — mathematically not possible with blind indexing; only exact match supported
- **NG-11:** Natural language to SQL — deferred to Phase 3 with MCP server
- **NG-12:** npm package publishing — deferred; SDK used locally via workspace in MVP
- **NG-13:** Auth-as-a-service (end-user authentication for developers' applications) — deferred to Phase 2; includes per-project user tables, signup/login, session management, OAuth providers, row-level security
- **NG-14:** Passkey/WebAuthn developer login — deferred to Phase 3; requires Dashboard UI (NG-1) to provide browser context for `navigator.credentials` API

## Technical Considerations

- **Backend runtime:** Python 3.12+ with FastAPI, managed by `uv`
- **SDK runtime:** TypeScript 5.x, targeting ES2022, bundled with `tsup`
- **Database:** PostgreSQL 16 with `pgvector` extension
- **Key storage:** HashiCorp Vault (dev mode for MVP, AppRole auth in production)
- **Auth:** Ed25519 JWT via PyJWT + cryptography library (upgrade path to ML-DSA-65 in Phase 2)
- **PQC library (SDK):** Determined by US-016 evaluation spike — candidates: CIRCL WASM, liboqs-WASM, pqcrypto-wasm
- **Blind indexing:** HMAC-SHA3-256 computed client-side in SDK; deterministic for same input + key
- **Shadow column naming:** `{original_name}_encrypted` and `{original_name}_index` — physical table never has the original column name for sensitive fields
- **API versioning:** All endpoints prefixed with `/v1/`
- **Error format:** `{"error": {"code": "...", "message": "..."}}`

## Success Metrics

- **SM-1:** E2E round-trip passes: developer signup → project creation → table definition → insert encrypted row → blind index query → decrypted result matches original
- **SM-2:** Zero-knowledge verified: direct database inspection shows only ciphertext and HMAC hashes for sensitive columns — no plaintext
- **SM-3:** Project isolation verified: data in project A is inaccessible via project B's API key
- **SM-4:** Encryption overhead < 50ms per operation (encrypt or decrypt) for typical row sizes (< 4KB)
- **SM-5:** All 20 stories have passing tests in CI
- **SM-6:** TypeScript SDK compiles with strict mode, zero type errors
- **SM-7:** Backend passes mypy strict type checking

## Open Questions

- **OQ-1:** Should the HMAC key be derivable from the developer's `encryptionKey` (avoiding a server round-trip) or managed independently in Vault? Trade-off: convenience vs. key separation.
- **OQ-2:** For ML-KEM keypair management in the SDK — should `encryptionKey` be the raw keypair, or should we derive a keypair from a passphrase via a KDF? Trade-off: simplicity vs. key backup UX.
- **OQ-3:** Should `anon` API keys have write access by default, or should writes require `service_role`? Trade-off: DX simplicity vs. least-privilege security.
- **OQ-4:** For the blind index, should we use a pepper in addition to the per-project HMAC key? Trade-off: additional frequency analysis protection vs. complexity.
