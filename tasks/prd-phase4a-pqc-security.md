# PRD: Phase 4a — PQC Security Hardening

## Context

pqdb already uses ML-KEM-768 for client-side data encryption, but the auth layer still uses classical Ed25519 signatures and there's no TLS infrastructure. Phase 4a makes the entire platform quantum-resistant: PQC signatures for auth tokens, PQC TLS for transport, and scoped API keys for defense-in-depth.

## Introduction

Phase 4a hardens pqdb's security posture with three pillars:
1. **ML-DSA-65 auth tokens** — Replace Ed25519 JWT signatures with NIST FIPS 204 post-quantum signatures via liboqs-python
2. **PQC TLS** — Add Caddy reverse proxy with hybrid X25519MLKEM768 key exchange (same approach as Chrome/Cloudflare)
3. **Scoped API keys** — Table-level permissions beyond the current binary anon/service roles

## Goals

1. All auth tokens signed with ML-DSA-65 (post-quantum digital signatures)
2. All external traffic protected by hybrid PQC TLS (X25519MLKEM768)
3. API keys can be scoped to specific tables and operations
4. Zero breaking changes to existing SDK/dashboard functionality
5. Development workflow remains simple (Caddy handles TLS transparently)

## User Stories

### US-078: Install liboqs-python and ML-DSA-65 key generation

**Description:** As the system, I need ML-DSA-65 keypair generation so auth tokens can be signed with post-quantum signatures.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `liboqs-python` added to backend dependencies via `uv add liboqs-python`
- [ ] New function `generate_mldsa65_keypair()` in `services/auth.py` returns (private_key, public_key) bytes
- [ ] Keypair is generated on app startup and stored in `app.state`
- [ ] Existing Ed25519 keypair generation preserved for backward compatibility during migration
- [ ] Unit test: keypair generation produces valid ML-DSA-65 keys (verify signature round-trip)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-079: ML-DSA-65 token signing and verification

**Description:** As a developer, I want auth tokens signed with ML-DSA-65 so they're quantum-resistant.

**Dependencies:** US-078

**Acceptance Criteria:**
- [ ] `create_access_token` and `create_refresh_token` sign with ML-DSA-65 instead of Ed25519
- [ ] Token format: custom JWT-like structure (header.payload.signature) since PyJWT doesn't support ML-DSA
- [ ] Header includes `{"alg":"ML-DSA-65","typ":"JWT"}` (base64url encoded)
- [ ] Payload is standard JWT claims (sub, type, iat, exp) — base64url encoded
- [ ] Signature is ML-DSA-65 over `header.payload` — base64url encoded
- [ ] `decode_token` verifies ML-DSA-65 signature and validates claims
- [ ] Tokens are larger (~3.3KB signature vs 64B Ed25519) — verify this works with HTTP headers
- [ ] Developer auth middleware updated to verify ML-DSA-65 tokens
- [ ] User auth middleware updated to verify ML-DSA-65 tokens
- [ ] Integration tests: login returns valid ML-DSA-65 token, token accepted by protected endpoints
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-080: Dashboard and SDK token compatibility

**Description:** As a developer using the dashboard or SDK, I want the larger ML-DSA-65 tokens to work seamlessly.

**Dependencies:** US-079

**Acceptance Criteria:**
- [ ] Dashboard auth-store handles larger tokens in sessionStorage (no size limits hit)
- [ ] Dashboard api-client sends larger Authorization headers without issues
- [ ] SDK HttpClient sends larger Authorization headers without issues
- [ ] MCP server OAuth flow passes ML-DSA-65 tokens in query params (URL length check)
- [ ] If URL length is an issue for MCP OAuth, switch to POST-based token exchange
- [ ] Envelope encryption flow still works (PBKDF2 + token refresh unchanged)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser: login → navigate → auto-decrypt still works

### US-081: Add Caddy reverse proxy with PQC TLS to Docker Compose

**Description:** As a developer, I want all external traffic encrypted with hybrid PQC TLS so the transport layer is quantum-resistant.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] New `infra/Caddyfile` with reverse proxy routes: `/v1/*` → backend:8000, `/*` → dashboard:3000
- [ ] Caddy service added to `infra/compose.yaml` with `tls internal` for dev certificates
- [ ] Caddy uses Go 1.24+ which negotiates X25519MLKEM768 by default — no explicit PQC config needed
- [ ] Volume for Caddy data (certificate persistence across restarts)
- [ ] Ports: Caddy exposes 443 (HTTPS) and 80 (HTTP redirect)
- [ ] Backend/dashboard/MCP stay on HTTP internally (Caddy terminates TLS)
- [ ] WebSocket connections for realtime proxied correctly through Caddy
- [ ] Health check endpoint accessible through Caddy
- [ ] Unit tests pass
- [ ] CI passes

### US-082: Update dev environment for HTTPS

**Description:** As a developer, I want the local dev environment to work over HTTPS through Caddy.

**Dependencies:** US-081

**Acceptance Criteria:**
- [ ] Helper script `infra/init-scripts/trust-caddy-ca.sh` extracts and installs Caddy's dev CA certificate
- [ ] Dashboard Vite config updated — remove `/v1` proxy (Caddy handles routing)
- [ ] `.env.example` updated with `PQDB_BASE_URL=https://localhost`
- [ ] Backend `config.py` CORS origins updated to include `https://localhost`
- [ ] Backend WebAuthn origin updated to `https://localhost`
- [ ] MCP server accepts `https://` project URLs
- [ ] Dashboard MCP callback validation allows `https://localhost`
- [ ] `NODE_EXTRA_CA_CERTS` documented for Node.js processes to trust Caddy CA
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Verify in browser: full app works over https://localhost

### US-083: PQC TLS verification

**Description:** As the system, I need to verify that TLS connections actually negotiate PQC key exchange.

**Dependencies:** US-082

**Acceptance Criteria:**
- [ ] Test script verifies X25519MLKEM768 key exchange via `openssl s_client`
- [ ] Integration test: connect to Caddy endpoint, verify non-404 response over HTTPS
- [ ] Documentation: which clients negotiate PQC (Chrome 131+, Firefox 132+, Safari 18.4+, Node 23+)
- [ ] Documentation: Node 22 falls back to X25519 (still secure, data is ML-KEM encrypted at app layer)
- [ ] Unit tests pass
- [ ] CI passes

### US-084: Scoped API keys — database schema

**Description:** As the system, I need a permissions schema on API keys so keys can be scoped to specific tables and operations.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Alembic migration adds `permissions` JSONB column to `api_keys` table (nullable, default null = full access)
- [ ] ApiKey model updated with `permissions: Mapped[dict | None]`
- [ ] Permissions format: `{"tables": {"users": ["select"], "posts": ["select", "insert", "update", "delete"]}}` or `null` for full access
- [ ] Null permissions = backward compatible (existing anon/service keys work unchanged)
- [ ] Unit test: model accepts permissions dict and defaults to None
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-085: Scoped API key creation and management endpoints

**Description:** As a developer, I want to create API keys with table-level permissions.

**Dependencies:** US-084

**Acceptance Criteria:**
- [ ] New endpoint `POST /v1/projects/{id}/keys/scoped` accepts `{name, permissions}` and returns the new key
- [ ] Permissions schema validated: tables must be valid table names, operations must be select/insert/update/delete
- [ ] Endpoint `GET /v1/projects/{id}/keys` returns permissions for each key
- [ ] Endpoint `DELETE /v1/projects/{id}/keys/{key_id}` deletes a scoped key
- [ ] Scoped keys use format `pqdb_scoped_{random}` to distinguish from anon/service
- [ ] Integration tests: create scoped key, verify permissions returned in list
- [ ] Integration tests: scoped key validates against the permissions schema
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-086: Enforce scoped key permissions in middleware

**Description:** As the system, I want scoped API key permissions enforced so keys can only access the tables/operations they're scoped to.

**Dependencies:** US-085

**Acceptance Criteria:**
- [ ] `get_project_context` middleware updated: parse permissions from matched key
- [ ] `ProjectContext` extended with `permissions: dict | None` field
- [ ] CRUD endpoints (select, insert, update, delete) check permissions before executing
- [ ] If key has permissions and table/operation not allowed → 403 with clear error message
- [ ] If key has null permissions (legacy anon/service) → full access (backward compatible)
- [ ] Service keys always have full access regardless of permissions field
- [ ] Integration tests: scoped key can access allowed table, rejected for disallowed table
- [ ] Integration tests: scoped key with select-only rejected for insert/update/delete
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-087: Dashboard UI for scoped API keys

**Description:** As a developer, I want to create and manage scoped API keys from the dashboard.

**Dependencies:** US-086

**Acceptance Criteria:**
- [ ] API Keys page shows all keys with their permissions (or "Full access" for null)
- [ ] "Create Scoped Key" dialog: select tables, check operations per table, name the key
- [ ] Key displayed once on creation (same pattern as existing keys — show once, copy)
- [ ] Delete button for scoped keys
- [ ] Existing anon/service keys shown as "Full access" (not editable)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

## Functional Requirements

- **FR-1:** All auth tokens must be signed with ML-DSA-65 (FIPS 204)
- **FR-2:** All external HTTPS connections must use hybrid X25519MLKEM768 key exchange
- **FR-3:** API keys can be scoped to specific tables and operations (select/insert/update/delete)
- **FR-4:** Null permissions on API keys = full access (backward compatible)
- **FR-5:** Existing Ed25519 tokens rejected after migration (clean cutover, not dual-support)

## Non-Goals

- **PQC certificate signatures** — Let's Encrypt doesn't issue ML-DSA certs yet. Classical cert + PQC key exchange is sufficient (same as Chrome)
- **Column-level API key permissions** — Table-level is sufficient for Phase 4a
- **Process-level isolation** — Deferred to Phase 5 (K8s)
- **Key rotation for ML-DSA-65** — Single keypair per deployment for now

## Technical Considerations

### ML-DSA-65 Token Size
- ML-DSA-65 signatures are ~3,309 bytes (vs 64 bytes for Ed25519)
- Base64url encoded: ~4,412 chars for the signature alone
- Total token size: ~4,600 chars (header + payload + signature)
- HTTP Authorization header can handle this (typical limit is 8KB-16KB)
- sessionStorage can handle this (5MB limit)
- URL query parameters for MCP OAuth may hit limits — may need POST-based token exchange

### Caddy PQC TLS
- Go 1.24+ enables X25519MLKEM768 by default in TLS 1.3
- Caddy 2.11+ (Docker `caddy:latest`) ships with Go 1.26
- No configuration needed — PQC is the default
- Clients that don't support PQC (Node 22) fall back to X25519 automatically

### Scoped Key Permissions Format
```json
{
  "tables": {
    "users": ["select"],
    "posts": ["select", "insert", "update", "delete"],
    "comments": ["select", "insert"]
  }
}
```
- `null` = full access (backward compatible)
- Missing table = no access to that table
- Operations: select, insert, update, delete

### Dependency Graph
```
US-078 (ML-DSA keygen) → US-079 (token signing) → US-080 (dashboard/SDK compat)
US-081 (Caddy setup) → US-082 (dev HTTPS) → US-083 (PQC TLS verification)
US-084 (scoped key schema) → US-085 (key management API) → US-086 (middleware enforcement) → US-087 (dashboard UI)
```

Three independent chains — can run in parallel:
- Chain A: US-078 → US-079 → US-080
- Chain B: US-081 → US-082 → US-083
- Chain C: US-084 → US-085 → US-086 → US-087

## Success Metrics

- `openssl s_client` shows X25519MLKEM768 negotiated on `https://localhost`
- Auth tokens are ~4.6KB (ML-DSA-65 signature size)
- Scoped API key with select-only permission rejected for insert operations
- All existing functionality works unchanged (dashboard, MCP, SDK)

## Resolved Decisions

1. **liboqs-python CI** — Use pre-built PyPI wheels (`uv add liboqs-python`). If CI fails, add `cmake` to GitHub Actions setup step as fallback.
2. **MCP OAuth token delivery** — POST-based exchange. Dashboard POSTs the token to `/mcp-auth-complete` instead of passing it in the URL redirect (ML-DSA-65 tokens are ~4.6KB, too large for URL query params).
3. **Token migration** — Clean cutover. No grace period. App starts generating ML-DSA-65 tokens on deploy. Old Ed25519 tokens fail validation (401 → re-login). Not in production, tokens are 15-min lived — no impact.
