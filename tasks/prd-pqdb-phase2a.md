# PRD: pqdb Phase 2a — Key Rotation + Core Auth

## Introduction

Phase 2a extends the pqdb platform with two foundational capabilities: HMAC key rotation for blind indexes and core end-user authentication (auth-as-a-service). Together, these make pqdb production-ready (key rotation) and feature-complete enough for developers to build real applications without bolting on a separate auth system (end-user auth with RLS).

Phase 2a is the first of two sub-phases. Phase 2b (OAuth, magic links, MFA, custom roles, advanced RLS) builds on the foundation laid here.

### Problem

1. **Key rotation:** HMAC keys are static in Phase 1. A compromised key permanently exposes all blind indexes for that project. Production deployments require key rotation with zero downtime.

2. **End-user auth:** Developers using pqdb must build their own auth system or integrate a third-party service. There is no way to authenticate an application's end-users through pqdb, and no row-level security to restrict data access per user.

### Solution

1. Versioned HMAC keys in Vault with rotation endpoint, version-prefixed blind indexes, multi-version query support, and optional background re-indexing.

2. Per-project user tables, email/password signup/login, JWT sessions with server-side revocation, owner column marking, and automatic RLS enforcement on CRUD queries.

## Goals

- **G-1:** Developers can rotate HMAC keys without downtime — old blind indexes remain queryable
- **G-2:** SDK queries search across all active key versions — no silent data loss during rotation window
- **G-3:** Background re-indexing migrates all blind indexes to the current key version
- **G-4:** End-users of developer applications can sign up and log in via email/password
- **G-5:** End-user sessions use JWT (access + refresh) with server-side refresh token revocation
- **G-6:** Developers can mark an owner column on tables; CRUD queries auto-filter by `owner_id` for non-admin requests
- **G-7:** SDK provides `client.auth.users.*` namespace for end-user auth, cleanly separated from developer auth
- **G-8:** E2E round-trip proven: key rotation + insert/query + user auth + RLS filtering

## User Stories

### US-021: Vault versioned HMAC key storage
**Description:** As a platform operator, I want HMAC keys stored with version metadata in Vault so that key rotation can be supported without breaking existing blind indexes.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Vault storage format at `secret/pqdb/projects/{project_id}/hmac` changes to: `{ current_version: N, keys: { "1": { key: "hex", created_at: "iso8601" }, ... } }`
- [ ] `vault.py` service updated: `store_hmac_key()` writes versioned format, `get_hmac_keys()` returns all active keys with current version indicator
- [ ] Backward-compatible: existing projects with single unversioned key are auto-migrated to `{ current_version: 1, keys: { "1": { key: "...", created_at: "..." } } }` on first read
- [ ] `GET /v1/projects/{id}/hmac-key` response shape changes to `{ current_version, keys: { "1": "hex", "2": "hex" } }` (keys without timestamps for SDK — timestamps are internal)
- [ ] Rate limiting on HMAC key endpoint preserved (10 req/min per project)
- [ ] Unit tests pass (versioned storage, auto-migration from unversioned format, round-trip read/write)
- [ ] Integration tests pass (Vault stores and retrieves versioned keys correctly)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-022: HMAC key rotation endpoint + SDK version-prefixed indexes
**Description:** As a developer, I want to rotate my project's HMAC key so that compromised keys can be retired while existing data remains queryable.

**Dependencies:** US-021

**Acceptance Criteria:**
- [ ] `POST /v1/projects/{id}/hmac-key/rotate` generates new 256-bit key, adds as next version in Vault, updates `current_version`. Returns `{ previous_version, current_version }`
- [ ] Endpoint requires developer JWT authentication (project owner only)
- [ ] Blind index format changes to version-prefixed: `v{N}:{hmac_hex}` (e.g., `v2:aabbcc1122...`)
- [ ] SDK `computeBlindIndex()` updated: accepts key version, prefixes result with `vN:`
- [ ] SDK inserts use current key version only for blind index computation
- [ ] SDK `.eq()` queries compute HMAC with **all active key versions** and send `WHERE col_index IN ('v1:hash1', 'v2:hash2')` to find rows regardless of which version indexed them
- [ ] SDK HMAC key cache updated: stores all active keys, uses current version for writes, all versions for reads
- [ ] SDK invalidates HMAC key cache on version-mismatch or auth errors
- [ ] Server-side CRUD service handles version-prefixed index values transparently (no server-side changes to query routing needed — the SDK sends the correct WHERE clause)
- [ ] Unit tests pass (version-prefixed index format, multi-version query generation, cache invalidation)
- [ ] Integration tests pass (rotate key → insert with new version → query finds both old and new rows)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-023: Background re-indexing service
**Description:** As a developer, I want to re-index all blind indexes with the current HMAC key so that old key versions can be retired after rotation.

**Dependencies:** US-022

**Acceptance Criteria:**
- [ ] `POST /v1/projects/{id}/reindex` starts a background re-indexing job. Returns `{ job_id }`. Requires developer JWT (project owner only)
- [ ] `GET /v1/projects/{id}/reindex/status` returns `{ status: "running"|"complete"|"failed", tables_done, tables_total }`
- [ ] Re-indexing process: for each table with searchable columns, read all rows, re-compute blind indexes using current HMAC key version, update `_index` columns with new version prefix
- [ ] Re-indexing is done server-side — the server retrieves the current HMAC key from Vault, computes HMAC-SHA3-256 hashes, and updates indexes. This requires the server to temporarily hold the HMAC key in memory during re-indexing (acceptable: the key is already stored in Vault, not client-secret)
- [ ] Re-indexing is idempotent — re-running skips rows already on the current version (check version prefix)
- [ ] Progress is tracked in a `_pqdb_reindex_jobs` table in the project database: `(id, status, tables_done, tables_total, started_at, completed_at)`
- [ ] Only one re-index job can run per project at a time (return 409 if already running)
- [ ] After successful re-index, old key versions can be deleted from Vault via `DELETE /v1/projects/{id}/hmac-key/versions/{version}`
- [ ] Unit tests pass (re-index logic, idempotency, version prefix update, conflict detection)
- [ ] Integration tests pass (rotate → insert → re-index → verify all indexes updated → old version deletable)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-024: Per-project user table and auth settings
**Description:** As a developer, I want per-project user tables and auth configuration so that my application's end-users can be managed within my project's isolated database.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `_pqdb_users` table auto-created in project database: `(id UUID PK, email TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'authenticated', email_verified BOOLEAN DEFAULT FALSE, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)`
- [ ] `_pqdb_sessions` table auto-created in project database: `(id UUID PK, user_id UUID FK, refresh_token_hash TEXT, expires_at TIMESTAMPTZ, revoked BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ)`
- [ ] `_pqdb_auth_settings` table auto-created in project database: `(id UUID PK, require_email_verification BOOLEAN DEFAULT FALSE, magic_link_webhook TEXT, password_min_length INTEGER DEFAULT 8, mfa_enabled BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)` — single row per project
- [ ] Tables are created by `ensure_auth_tables()` function in a new `auth_engine.py` service, called on first auth-related request to a project (lazy initialization)
- [ ] `POST /v1/projects/{id}/auth/settings` allows project owner (developer JWT) to update auth settings
- [ ] `GET /v1/projects/{id}/auth/settings` returns current auth settings
- [ ] Auth tables do not conflict with user-created tables (all prefixed with `_pqdb_`)
- [ ] Unit tests pass (table creation DDL, settings CRUD, lazy initialization)
- [ ] Integration tests pass (auth tables created in project database, settings persist)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-025: End-user signup/login/refresh endpoints
**Description:** As a developer's end-user, I want to sign up and log in to applications built on pqdb so that I can access my data securely.

**Dependencies:** US-024

**Acceptance Criteria:**
- [ ] `POST /v1/auth/users/signup` accepts `{ email, password }`, creates user in `_pqdb_users` with argon2id password hash, returns `{ user: { id, email, role }, access_token, refresh_token }`
- [ ] `POST /v1/auth/users/login` validates credentials against `_pqdb_users`, returns tokens
- [ ] `POST /v1/auth/users/logout` accepts `{ refresh_token }`, sets `revoked = true` on matching session in `_pqdb_sessions`
- [ ] `POST /v1/auth/users/refresh` validates refresh token against `_pqdb_sessions` (hash match + not revoked + not expired), issues new access token
- [ ] `GET /v1/auth/users/me` returns current user profile (requires user JWT)
- [ ] `PUT /v1/auth/users/me` updates user metadata (requires user JWT)
- [ ] All `/v1/auth/users/*` endpoints use `apikey` header for project resolution (same middleware as `/v1/db/*`), NOT developer JWT
- [ ] FastAPI router registers `/v1/auth/users` prefix BEFORE `/v1/auth` to prevent path conflicts
- [ ] End-user JWT structure: `{ sub: user_id, project_id, role: "authenticated", type: "user_access", email_verified, exp }`
- [ ] JWT signed with same Ed25519 key as developer tokens; `type: "user_access"` distinguishes from `type: "access"`
- [ ] Access token: 15-min expiry. Refresh token: 7-day expiry, stored as argon2id hash in `_pqdb_sessions`
- [ ] Password validation: minimum length from `_pqdb_auth_settings.password_min_length` (default 8)
- [ ] Returns 409 for duplicate email on signup, 401 for invalid credentials on login, 401 for expired/revoked refresh token
- [ ] Rate limiting: 10 signup/min per IP, 20 login/min per IP
- [ ] Unit tests pass (signup, login, logout, refresh, token validation, rate limiting, error cases)
- [ ] Integration tests pass (full signup → login → refresh → logout → refresh-rejected flow)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-026: End-user auth middleware (user JWT validation + context)
**Description:** As a platform operator, I want middleware that validates end-user JWTs and provides user context to downstream handlers so that CRUD operations can enforce per-user access control.

**Dependencies:** US-025

**Acceptance Criteria:**
- [ ] New FastAPI dependency `get_current_user` extracts and validates user JWT from `Authorization: Bearer` header on project-scoped requests
- [ ] Validates: Ed25519 signature, expiry, `type == "user_access"`, `project_id` matches the project resolved from API key
- [ ] Returns `UserContext` dataclass: `(user_id, project_id, role, email_verified)`
- [ ] Dependency is optional — CRUD endpoints work without user JWT (for `service` role API keys or unauthenticated access patterns)
- [ ] When user JWT is present, `UserContext` is injected into request state alongside existing `ProjectContext`
- [ ] Rejects user JWT with mismatched `project_id` (user from project A cannot access project B)
- [ ] Returns 401 for invalid/expired user JWT with clear error: `{ error: { code: "user_token_invalid", message: "..." } }`
- [ ] Unit tests pass (JWT validation, project_id mismatch detection, optional dependency behavior)
- [ ] Integration tests pass (valid user JWT → context injected; invalid JWT → 401; no JWT → no user context)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-027: SDK `client.auth.users.*` methods
**Description:** As a developer using the SDK, I want `client.auth.users.*` methods so that I can integrate end-user authentication into my application.

**Dependencies:** US-025

**Acceptance Criteria:**
- [ ] `client.auth.users.signUp({ email, password })` calls `POST /v1/auth/users/signup`, stores tokens, returns `{ data: { user, access_token, refresh_token }, error }`
- [ ] `client.auth.users.signIn({ email, password })` calls `POST /v1/auth/users/login`, stores tokens
- [ ] `client.auth.users.signOut()` calls `POST /v1/auth/users/logout` with refresh token, clears stored tokens
- [ ] `client.auth.users.getUser()` calls `GET /v1/auth/users/me`, returns user profile
- [ ] `client.auth.users.updateUser(data)` calls `PUT /v1/auth/users/me`
- [ ] User JWT auto-attached to project-scoped requests via `Authorization: Bearer` header (alongside `apikey` header)
- [ ] Token refresh handled automatically: when access token expires, SDK uses refresh token to get new access token before retrying the request
- [ ] User auth state is separate from developer auth state — both can coexist in the same client instance
- [ ] All methods return `{ data, error }` pattern — never throw
- [ ] Full TypeScript types for all request/response shapes
- [ ] `client.auth.users` namespace clearly separated from existing `client.auth` (developer auth)
- [ ] Unit tests pass (method calls, header attachment, token storage, auto-refresh, error handling)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-028: Owner column marker + basic RLS enforcement
**Description:** As a developer, I want to mark an owner column on tables so that CRUD queries automatically filter rows by the current user, enforcing basic row-level security.

**Dependencies:** US-026

**Acceptance Criteria:**
- [ ] `_pqdb_columns` metadata table gains `is_owner BOOLEAN DEFAULT FALSE` column
- [ ] Migration for existing projects: `ensure_metadata_table()` in `schema_engine.py` runs `ALTER TABLE _pqdb_columns ADD COLUMN IF NOT EXISTS is_owner BOOLEAN DEFAULT FALSE` on first access
- [ ] `POST /v1/db/tables` accepts `owner: true` flag on column definitions (column must be `uuid` type, `plain` sensitivity)
- [ ] At most one column per table can be marked `is_owner = true` — return 400 if multiple specified
- [ ] `POST /v1/db/tables/{name}/columns` also supports `owner: true` for adding an owner column to existing tables
- [ ] Schema introspection endpoints (`GET /v1/db/introspect`, `GET /v1/db/introspect/{table}`) include `is_owner` in column metadata
- [ ] RLS enforcement in CRUD service: when `UserContext` is present (user JWT) and API key role is `anon`:
  - SELECT: inject `WHERE {owner_column} = :user_id` automatically
  - INSERT: validate that `{owner_column}` value matches `user_id` (reject if mismatched)
  - UPDATE/DELETE: inject `WHERE {owner_column} = :user_id` in filter
- [ ] When API key role is `service`: no RLS filtering (admin access)
- [ ] When no `UserContext` (no user JWT) and API key role is `anon`: deny CRUD operations on tables with an owner column (return 403)
- [ ] When table has no owner column: no RLS applied regardless of user context
- [ ] Unit tests pass (column marker, RLS filter injection, role-based bypass, error cases)
- [ ] Integration tests pass (user sees only own rows, service role sees all, cross-user isolation)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-029: SDK owner column + RLS-aware queries
**Description:** As a developer using the SDK, I want to mark owner columns in table definitions so that the SDK correctly handles RLS-filtered queries.

**Dependencies:** US-028, US-027

**Acceptance Criteria:**
- [ ] New `.owner()` chain on column definitions: `column.uuid().owner()` marks the column as the owner column
- [ ] `column.owner()` can only be chained on `uuid()` columns — TypeScript type error otherwise
- [ ] On `.insert()`: SDK auto-sets `owner_id` to the current user's ID from the stored user JWT (if present)
- [ ] On table creation via `POST /v1/db/tables`: SDK includes `owner: true` in column definition for owner-marked columns
- [ ] TypeScript types correctly reflect that owner column is always UUID type
- [ ] SDK does NOT do client-side RLS filtering — the server handles it. SDK just sends the user JWT and lets the server enforce.
- [ ] `defineTable` schema serialization includes owner column metadata when sent to server
- [ ] Unit tests pass (owner chain, auto-set owner_id on insert, schema serialization with owner flag)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-030: Phase 2a E2E tests
**Description:** As the engineering team, we need end-to-end tests proving key rotation and end-user auth with RLS work across the full stack: SDK → API → database → SDK.

**Dependencies:** US-023, US-029

**Acceptance Criteria:**
- [ ] Test setup: Docker Compose starts Postgres + Vault, FastAPI backend runs against them, SDK connects to backend
- [ ] **Test 1 — Key rotation round-trip:** SDK inserts data with searchable column → rotate HMAC key → SDK inserts more data with new key → SDK queries with `.eq()` → both old and new rows returned → verify version prefixes differ in raw database
- [ ] **Test 2 — Re-indexing:** After rotation, trigger re-index → wait for completion → verify all `_index` values updated to current version prefix → delete old key version → queries still work
- [ ] **Test 3 — User signup + login + RLS:** SDK signs up end-user A → creates table with owner column → inserts rows as user A → signs up user B → user B queries → sees zero rows → user A queries → sees own rows
- [ ] **Test 4 — Service role bypass:** Same table as Test 3 → service role API key queries → sees all rows from all users
- [ ] **Test 5 — Cross-project user isolation:** Create two projects → sign up user in project A → user A's JWT rejected on project B with 401
- [ ] **Test 6 — Session revocation:** User logs in → gets tokens → logs out → refresh token rejected on next refresh attempt
- [ ] All 6 tests pass
- [ ] CI passes (tests run in CI with Docker Compose)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-021: Vault versioned HMAC key storage   (Dependencies: None)
US-022: HMAC key rotation + SDK indexes    (Dependencies: US-021)
US-023: Background re-indexing service      (Dependencies: US-022)
US-024: Per-project user table + settings   (Dependencies: None)          ← parallel with US-021
US-025: End-user signup/login/refresh       (Dependencies: US-024)
US-026: End-user auth middleware            (Dependencies: US-025)
US-027: SDK client.auth.users.* methods     (Dependencies: US-025)        ← parallel with US-026
US-028: Owner column + basic RLS            (Dependencies: US-026)
US-029: SDK owner column + RLS queries      (Dependencies: US-028, US-027)
US-030: Phase 2a E2E tests                  (Dependencies: US-023, US-029)
```

### Parallel Execution Chains

```
Chain A (Key rotation):  US-021 → US-022 → US-023 ──────────────────────────┐
Chain B (Auth core):     US-024 → US-025 → US-026 → US-028 ────────────────┤
Chain C (SDK auth):               US-025 → US-027 → US-029 ────────────────┤
                                                                            └→ US-030 (E2E)
```

**Chain A and Chain B are fully independent** — key rotation and auth can be built in parallel by separate agents.

**Chain C branches from Chain B at US-025** — once the backend auth endpoints exist, the SDK work can proceed in parallel with the middleware/RLS work.

**Critical path:** US-024 → US-025 → US-026 → US-028 → US-029 → US-030

## Functional Requirements

- **FR-1:** HMAC keys in Vault are versioned with `current_version` and per-version `created_at` timestamps
- **FR-2:** Key rotation creates a new version without invalidating existing versions
- **FR-3:** Blind index values are prefixed with version number: `v{N}:{hmac_hex}`
- **FR-4:** SDK queries across all active key versions to prevent silent data loss during rotation
- **FR-5:** Background re-indexing updates all blind indexes to the current key version
- **FR-6:** Each project database has `_pqdb_users`, `_pqdb_sessions`, and `_pqdb_auth_settings` tables
- **FR-7:** End-user signup/login uses argon2id password hashing and Ed25519 JWT tokens
- **FR-8:** End-user JWT tokens have `type: "user_access"` to distinguish from developer tokens (`type: "access"`)
- **FR-9:** Refresh tokens are stored as argon2id hashes in `_pqdb_sessions` with revocation support
- **FR-10:** `/v1/auth/users/*` endpoints use `apikey` header for project resolution (not developer JWT)
- **FR-11:** Owner column (`is_owner = true` in `_pqdb_columns`) enables automatic RLS filtering on CRUD
- **FR-12:** RLS: `anon` API key + user JWT → filter by owner column; `service` API key → no filter
- **FR-13:** SDK `client.auth.users.*` namespace is cleanly separated from `client.auth` (developer auth)

## Non-Goals (Phase 2a)

- OAuth provider integration (Phase 2b)
- Magic link authentication (Phase 2b)
- MFA/TOTP (Phase 2b)
- Custom roles beyond `authenticated`/`anon` (Phase 2b)
- Advanced RLS policies with `owner`/`all`/`none` conditions (Phase 2b — Phase 2a only implements basic owner-column RLS)
- Auth webhooks / email delivery (Phase 2b)
- Email verification enforcement (Phase 2b — `email_verified` field exists but is not enforced)
- Password reset (Phase 2b)
- Developer OAuth login (Phase 3)
- ML-DSA-65 auth tokens (Phase 3)
- PQC TLS (Phase 3)
- Dashboard / Studio UI (Phase 3)

## Technical Considerations

- **Backend:** Python 3.12+ / FastAPI, same architecture as Phase 1. New services: `auth_engine.py` (user table management), `user_auth.py` (signup/login/session logic), `reindex.py` (background re-indexing). New routes: `user_auth.py` for `/v1/auth/users/*`.
- **SDK:** TypeScript 5.x. New module: `src/client/user-auth.ts` for `client.auth.users.*`. Updated: `src/crypto/blind-index.ts` for version-prefixed indexes, `src/query/crypto-transform.ts` for multi-version query generation.
- **Database:** No Alembic migrations needed — all new tables are in project databases (created dynamically). `_pqdb_columns` gains `is_owner` column via `ALTER TABLE IF NOT EXISTS`.
- **Vault:** Storage format changes from flat key to versioned JSON. Backward-compatible auto-migration on first read.
- **Auth:** Same Ed25519 JWT signing infrastructure. `type` field distinguishes developer vs. end-user tokens. Argon2id for password hashing (same as developer auth).
- **Testing:** Integration tests require real Postgres + Vault (same as Phase 1). E2E tests use Docker Compose.

## Success Metrics

- **SM-1:** Key rotation E2E: rotate key → insert → query → both old and new rows found → re-index → old key deletable
- **SM-2:** Auth E2E: end-user signup → login → insert data → query with RLS → sees only own rows
- **SM-3:** Service role bypass: admin queries see all rows regardless of owner
- **SM-4:** Cross-project isolation: user JWT from project A rejected on project B
- **SM-5:** Session revocation: logout invalidates refresh token within one request
- **SM-6:** All 10 stories have passing tests in CI
- **SM-7:** TypeScript SDK compiles with strict mode, zero type errors
- **SM-8:** Backend passes mypy strict type checking

## Open Questions

- **OQ-1:** Should re-indexing be a synchronous operation for small projects (< 10k rows) to avoid the complexity of background job tracking? Trade-off: simplicity vs. consistency.
- **OQ-2:** Should the `_pqdb_sessions` table have automatic cleanup of expired sessions, or rely on manual cleanup? Trade-off: operational simplicity vs. table bloat.
- **OQ-3:** When a table has an owner column and a user JWT is present, should INSERT automatically set the owner column to the current user, or require the client to explicitly provide it? Trade-off: magic vs. explicitness. (Current design: SDK auto-sets, server validates.)
