# Phase 2 Design: Key Rotation + Auth-as-a-Service

## Overview

Phase 2 adds two capabilities to pqdb:

1. **HMAC key rotation** — versioned blind index keys with zero-downtime rotation and optional re-indexing
2. **Auth-as-a-service** — full end-user authentication for developers' applications: email/password, OAuth (Google + GitHub), magic links, MFA/TOTP, custom roles, and row-level security

Phase 2 is split into two sub-phases, each independently shippable:

- **Phase 2a** (~10 stories): Key rotation + core auth (user tables, email/password, sessions, basic RLS)
- **Phase 2b** (~12 stories): OAuth adapters, magic links, MFA/TOTP, custom roles, advanced RLS, email verification, password reset

### Deferred to Phase 3

- **Developer OAuth login** — requires Dashboard UI (NG-1) for browser-based consent flow
- **ML-DSA-65 auth tokens** — Ed25519 JWTs are short-lived; PQC signatures are defense-in-depth, not a gap
- **PQC TLS** — data in transit is already ML-KEM encrypted client-side; standard TLS is sufficient

---

## Section 1: Key Rotation

### Problem

HMAC keys are static in Phase 1. A compromised key permanently exposes all blind indexes for that project. Key rotation lets developers cycle keys while keeping old data queryable.

### Vault storage — versioned keys

Vault stores versioned HMAC keys at `secret/pqdb/projects/{project_id}/hmac`:

```json
{
  "current_version": 2,
  "keys": {
    "1": "aabbcc...",
    "2": "ddeeff..."
  }
}
```

### Rotation flow

1. Developer calls `POST /v1/projects/{id}/hmac-key/rotate`
2. Server generates new 256-bit key, adds it as next version in Vault, updates `current_version`
3. Returns `{ previous_version: 1, current_version: 2 }`
4. New inserts use version 2 for blind indexes
5. Old blind indexes (version 1) still work for reads

### Blind index versioning

`_index` columns gain a version prefix: `v2:aabbcc1122...` (version number + colon + hash).

- On SELECT with `.eq()`: server extracts version from stored index, uses matching HMAC key to verify
- On INSERT: SDK computes index with current key version, prefixes with version number

### Re-indexing (developer-triggered)

`POST /v1/projects/{id}/reindex` — background job reads all rows, re-computes blind indexes with current key. After completion, old key versions can be retired. Not required — old indexes remain functional indefinitely.

### SDK changes

- `GET /v1/projects/{id}/hmac-key` returns `{ key, version }` instead of just the key
- SDK caches current version, prefixes blind indexes with version number
- SDK invalidates cache on 401/version-mismatch errors

### Encryption layer — unchanged

Key rotation affects only blind indexes (HMAC-SHA3-256). The ML-KEM-768 + AES-256-GCM encryption layer is untouched — same keypair, same ciphertext. The zero-knowledge guarantee is preserved.

---

## Section 2: End-User Auth — Core (Phase 2a)

### Problem

Developers have no way to authenticate their app's end-users through pqdb. They must build their own auth system or bolt on a third-party service.

### User table (per project database)

When auth is enabled, `_pqdb_users` is auto-created in the project database:

```sql
_pqdb_users (
  id              UUID PRIMARY KEY,
  email           TEXT UNIQUE NOT NULL,
  password_hash   TEXT,                   -- argon2id (null if OAuth-only)
  role            TEXT DEFAULT 'authenticated',
  email_verified  BOOLEAN DEFAULT FALSE,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
)
```

This lives in the project database, not the platform database. Each project has its own isolated user pool.

### Auth endpoints (project-scoped, require API key)

```
POST /v1/auth/users/signup    — { email, password } -> { user, access_token, refresh_token }
POST /v1/auth/users/login     — { email, password } -> { user, access_token, refresh_token }
POST /v1/auth/users/logout    — invalidates refresh token
POST /v1/auth/users/refresh   — { refresh_token } -> { access_token }
GET  /v1/auth/users/me        — returns current user profile
PUT  /v1/auth/users/me        — update profile/metadata
```

These are under `/v1/auth/users/*` to distinguish from developer auth at `/v1/auth/*`.

### JWT structure for end-users

```json
{
  "sub": "user-uuid",
  "project_id": "project-uuid",
  "role": "authenticated",
  "type": "user_access",
  "email_verified": true,
  "exp": 1234567890
}
```

The `type: "user_access"` distinguishes end-user tokens from developer tokens (`type: "access"`). Same Ed25519 signing, same 15-min access + 7-day refresh pattern.

### SDK interface

```typescript
// End-user auth
client.auth.users.signUp({ email, password })
client.auth.users.signIn({ email, password })
client.auth.users.signOut()
client.auth.users.getUser()
client.auth.users.updateUser({ metadata: { name: "Alice" } })

// Developer auth (unchanged)
client.auth.signUp({ email, password })
client.auth.signIn({ email, password })
```

### RLS integration

When a user JWT is present, CRUD queries automatically inject a filter:

- `anon` API key + user JWT: `WHERE owner_id = :current_user_id`
- `service_role` API key: no filter (admin access)

Developers mark the owner column when defining tables:

```typescript
const posts = client.defineTable('posts', {
  id: column.uuid().primaryKey(),
  owner_id: column.uuid().owner(),       // new .owner() chain
  title: column.text().sensitive('searchable'),
  body: column.text().sensitive('private'),
  published: column.boolean(),
})
```

The `.owner()` marker tells the server which column to filter on. The `_pqdb_columns` metadata table gets a new `is_owner` boolean field.

---

## Section 3: OAuth Provider System (Phase 2b)

### Pluggable adapter interface

Each OAuth provider implements a common backend interface:

```python
class OAuthProvider(ABC):
    provider_name: str

    def get_authorization_url(state, redirect_uri) -> str
    def exchange_code(code, redirect_uri) -> OAuthTokens
    def get_user_info(tokens) -> OAuthUserInfo  # { email, name, avatar_url, provider_uid }
```

### Provider configuration

Developers configure OAuth credentials per-project:

```
POST /v1/projects/{id}/auth/providers     — { provider: "google", client_id, client_secret }
GET  /v1/projects/{id}/auth/providers     — list configured providers
DELETE /v1/projects/{id}/auth/providers/{name}
```

Provider credentials stored in Vault at `secret/pqdb/projects/{project_id}/oauth/{provider}`.

### OAuth flow

```
1. SDK calls client.auth.users.signInWithOAuth('google')
2. SDK opens browser to: /v1/auth/users/oauth/google/authorize?redirect_uri=...
3. Server generates state token, redirects to Google's consent screen
4. User consents, Google redirects back with code
5. Server exchanges code -> gets user info from Google
6. Server finds-or-creates user in _pqdb_users (linked via _pqdb_oauth_identities)
7. Server issues JWT, redirects to SDK's redirect_uri with tokens
```

### OAuth identity linking

New table in project database:

```sql
_pqdb_oauth_identities (
  id            UUID PRIMARY KEY,
  user_id       UUID REFERENCES _pqdb_users(id),
  provider      TEXT NOT NULL,
  provider_uid  TEXT NOT NULL,
  email         TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ,
  UNIQUE(provider, provider_uid)
)
```

One user can have multiple OAuth identities. Linking happens by email match — if a user signed up with email/password and later signs in with Google using the same email, the accounts merge.

### SDK interface

```typescript
client.auth.users.signInWithOAuth('google', { redirectTo: 'https://myapp.com/callback' })
client.auth.users.linkOAuth('github')
client.auth.users.unlinkOAuth('github')
client.auth.users.getLinkedProviders()
```

### Shipped providers

Google and GitHub. The adapter interface supports adding more (Apple, Discord, Microsoft) without core changes.

---

## Section 4: Magic Links (Phase 2b)

### Flow

```
1. SDK calls client.auth.users.signInWithMagicLink({ email })
2. Server generates one-time token (32 bytes, cryptographically random)
3. Server stores token hash + expiry (15 min) in _pqdb_magic_links table
4. Server fires auth webhook with type: "magic_link"
5. Developer's app sends email with link containing token
6. User clicks link -> app calls client.auth.users.verifyMagicLink(token)
7. Server validates token (not expired, not used) -> issues JWT
8. Token marked as used (single-use)
```

### Email delivery — webhook-based

pqdb does not send emails directly. Developer registers a webhook URL. pqdb POSTs auth event payloads to it:

```
POST /v1/projects/{id}/auth/settings — { magic_link_webhook: "https://myapp.com/hooks/email" }
```

Payload:

```json
{ "type": "magic_link", "to": "alice@example.com", "token": "abc123...", "expires_in": 900 }
```

The webhook is reused for email verification, password reset, and any future notification.

### Storage

```sql
_pqdb_magic_links (
  id          UUID PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ
)
```

### SDK interface

```typescript
await client.auth.users.signInWithMagicLink({ email: 'alice@example.com' })
await client.auth.users.verifyMagicLink(token)
```

---

## Section 5: MFA/TOTP (Phase 2b)

### Enrollment flow

```
1. User calls client.auth.users.mfa.enroll()
2. Server generates TOTP secret (20 bytes, RFC 6238)
3. Server stores secret in _pqdb_mfa_factors table (unverified)
4. Returns { secret, qr_uri, recovery_codes }
5. User scans QR with authenticator app
6. User calls client.auth.users.mfa.verify({ code: '123456' })
7. Server validates TOTP code -> marks factor as verified
```

### Login flow with MFA

```
1. User signs in with email/password
2. Server detects MFA is enabled
3. Returns { mfa_required: true, mfa_ticket: "temp-token" } instead of JWT
4. User provides TOTP code
5. client.auth.users.mfa.challenge({ ticket, code: '123456' })
6. Server validates code -> issues full JWT
```

The `mfa_ticket` is a 5-minute token proving "password was correct, waiting for second factor."

### TOTP validation

Server-side only. TOTP secrets are stored in the project database, not end-to-end encrypted. This is necessary because the server must validate the code — client-side validation would defeat the purpose (a malicious client could skip it).

### Storage

```sql
_pqdb_mfa_factors (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES _pqdb_users(id),
  type        TEXT DEFAULT 'totp',
  secret      TEXT NOT NULL,
  verified    BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ
)

_pqdb_recovery_codes (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES _pqdb_users(id),
  code_hash   TEXT NOT NULL,
  used        BOOLEAN DEFAULT FALSE
)
```

### Recovery codes

On MFA enrollment, 10 one-time recovery codes (8 chars each) are generated. Stored as argon2id hashes. Each works once as a TOTP substitute.

### SDK interface

```typescript
const { data } = await client.auth.users.mfa.enroll()
// data = { secret, qr_uri, recovery_codes }

await client.auth.users.mfa.verify({ code: '123456' })

// Login with MFA
const { data } = await client.auth.users.signIn({ email, password })
if (data.mfa_required) {
  await client.auth.users.mfa.challenge({ ticket: data.mfa_ticket, code: '123456' })
}

await client.auth.users.mfa.unenroll()
```

---

## Section 6: Custom Roles & Advanced RLS (Phase 2b)

### Role system

Roles are defined per-project:

```
POST /v1/projects/{id}/auth/roles      — { name: "moderator", description: "..." }
GET  /v1/projects/{id}/auth/roles      — list roles
DELETE /v1/projects/{id}/auth/roles/{name}
```

Storage:

```sql
_pqdb_roles (
  id          UUID PRIMARY KEY,
  name        TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ
)
```

Built-in roles (always present):
- `authenticated` — default for logged-in users
- `anon` — unauthenticated requests (anon API key, no user JWT)

Role assignment (service_role API key required):

```typescript
await client.auth.users.setRole(userId, 'moderator')
```

The user's JWT includes their role, so the server knows access level without a DB lookup per request.

### RLS policies

Developers define per-table policies:

```
POST /v1/db/tables/{name}/policies     — define access policy
GET  /v1/db/tables/{name}/policies     — list policies
DELETE /v1/db/tables/{name}/policies/{id}
```

Policy structure:

```json
{
  "name": "users_see_own_posts",
  "operation": "select",
  "role": "authenticated",
  "condition": "owner"
}
```

Three condition types:
- **`owner`** — `WHERE owner_id = current_user_id`
- **`all`** — no row filter
- **`none`** — operation denied (403)

Example for a blog app:

| Role | select | insert | update | delete |
|------|--------|--------|--------|--------|
| `anon` | all | none | none | none |
| `authenticated` | all | owner | owner | owner |
| `moderator` | all | owner | all | all |
| `admin` | all | all | all | all |

Storage:

```sql
_pqdb_policies (
  id          UUID PRIMARY KEY,
  table_name  TEXT NOT NULL,
  name        TEXT NOT NULL,
  operation   TEXT NOT NULL,
  role        TEXT NOT NULL,
  condition   TEXT NOT NULL,
  created_at  TIMESTAMPTZ,
  UNIQUE(table_name, operation, role)
)
```

### Enforcement

1. Extract `role` from user JWT (or `anon` if no JWT)
2. Look up policy for `(table, operation, role)` in `_pqdb_policies`
3. No policy = deny (default `none`)
4. `owner` = inject `WHERE owner_id = :user_id`
5. `all` = no filter
6. `none` = return 403

### Why this fits zero-knowledge

RLS conditions operate on plain metadata columns (`owner_id`, `role`). The server enforces "which rows does this user get" without inspecting encrypted content. Three simple conditions (`owner`, `all`, `none`) avoid the complexity of arbitrary SQL expressions while covering the vast majority of access patterns.

### SDK interface

```typescript
await client.auth.policies.create('posts', {
  name: 'public_read',
  operation: 'select',
  role: 'anon',
  condition: 'all'
})

const { data } = await client.auth.policies.list('posts')
```

---

## Section 7: Email Verification & Password Reset (Phase 2b)

### Email verification

On signup, users are unverified (`email_verified: false`). Developers configure whether unverified users can access data.

Flow:
1. User signs up -> server fires webhook with `type: "email_verification"`
2. Developer's app sends verification email
3. User clicks link -> `client.auth.users.verifyEmail(token)`
4. Server validates -> sets `email_verified = true`

### Password reset

Flow:
1. `client.auth.users.resetPassword({ email })`
2. Server fires webhook with `type: "password_reset"`
3. Developer's app sends reset email
4. `client.auth.users.updatePassword({ token, newPassword })`
5. Server validates -> updates password hash -> invalidates all refresh tokens

### Auth settings

```sql
_pqdb_auth_settings (
  id                          UUID PRIMARY KEY,
  require_email_verification  BOOLEAN DEFAULT FALSE,
  magic_link_webhook          TEXT,
  password_min_length         INTEGER DEFAULT 8,
  mfa_enabled                 BOOLEAN DEFAULT FALSE,
  created_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ
)
```

Single row per project, created when auth is first enabled.

### Webhook payload types

All auth events go through the same webhook URL:

```json
{ "type": "magic_link",         "to": "...", "token": "...", "expires_in": 900 }
{ "type": "email_verification", "to": "...", "token": "...", "expires_in": 86400 }
{ "type": "password_reset",     "to": "...", "token": "...", "expires_in": 3600 }
```

### SDK interface

```typescript
await client.auth.users.verifyEmail(token)
await client.auth.users.resendVerification()
await client.auth.users.resetPassword({ email: 'alice@example.com' })
await client.auth.users.updatePassword({ token, newPassword: '...' })
```

---

## Section 8: Story Breakdown

### Phase 2a (~10 stories): Key Rotation + Core Auth

| Story | Title | Depends on |
|-------|-------|-----------|
| US-021 | Vault versioned HMAC key storage | — |
| US-022 | HMAC key rotation endpoint + SDK version-prefixed indexes | US-021 |
| US-023 | Background re-indexing service | US-022 |
| US-024 | Per-project user table + auth settings | — |
| US-025 | End-user signup/login/refresh endpoints | US-024 |
| US-026 | End-user auth middleware (user JWT validation + context) | US-025 |
| US-027 | SDK `client.auth.users.*` methods | US-025 |
| US-028 | Owner column marker + basic RLS enforcement | US-026 |
| US-029 | SDK owner column + RLS-aware queries | US-028, US-027 |
| US-030 | Phase 2a E2E tests | US-023, US-029 |

Dependency chains:
```
Chain A (Key rotation):  US-021 -> US-022 -> US-023 -----------------+
Chain B (Auth core):     US-024 -> US-025 -> US-026 -> US-028 ------+
Chain C (SDK auth):      US-025 -> US-027 -> US-029 ----------------+
                                                                     +-> US-030 (E2E)
```

### Phase 2b (~12 stories): Advanced Auth

| Story | Title | Depends on |
|-------|-------|-----------|
| US-031 | Auth webhook dispatch system | US-024 |
| US-032 | Email verification (webhook + verify endpoint) | US-031 |
| US-033 | Password reset (webhook + update endpoint) | US-031 |
| US-034 | Magic link authentication | US-031 |
| US-035 | OAuth provider adapter interface + provider CRUD | US-024 |
| US-036 | Google OAuth adapter | US-035 |
| US-037 | GitHub OAuth adapter | US-035 |
| US-038 | SDK OAuth + magic link + verification methods | US-034, US-036 |
| US-039 | MFA/TOTP enrollment, challenge, recovery codes | US-026 |
| US-040 | Custom roles + RLS policies | US-028 |
| US-041 | SDK roles + policies + MFA methods | US-039, US-040 |
| US-042 | Phase 2b E2E tests | US-041, US-038 |

Dependency chains:
```
Chain D (Webhooks):    US-031 -> US-032, US-033, US-034 (parallel) --+
Chain E (OAuth):       US-035 -> US-036, US-037 (parallel) ---------+
Chain F (MFA + Roles): US-039, US-040 (parallel) -------------------+
Chain G (SDK):         US-038, US-041 (parallel) -------------------+
                                                                     +-> US-042 (E2E)
```

### E2E test coverage

**Phase 2a:**
1. Key rotation -> insert with new key -> old data still queryable -> re-index -> verify
2. User signup -> login -> JWT issued -> query with RLS -> only sees own rows
3. Service role bypasses RLS -> sees all rows
4. User JWT on wrong project -> rejected

**Phase 2b:**
5. OAuth flow -> configure Google provider -> initiate -> callback -> user created -> JWT
6. Magic link -> request -> webhook fires -> verify token -> authenticated
7. MFA enrollment -> login requires TOTP -> correct code -> authenticated -> recovery code works
8. Custom roles -> admin sees all rows -> regular user sees own rows only
9. Password reset -> webhook fires -> update password -> old sessions invalidated
10. Email verification -> unverified blocked (when configured) -> verify -> access granted

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| RLS model | Server-side on plain/index columns | Zero-knowledge: server can't inspect encrypted data; access control uses plain metadata |
| Session model | JWT (access + refresh) | Proven in Phase 1, stateless, consistent with developer auth |
| OAuth model | Pluggable adapter, ship Google + GitHub | Extensible without core changes; covers 90%+ of apps |
| Email delivery | Webhook-based | pqdb shouldn't manage SMTP; developers already have email providers |
| MFA validation | Server-side TOTP | Server must validate second factor; client-side defeats the purpose |
| RLS conditions | owner / all / none | Simple, zero-knowledge compatible; covers vast majority of access patterns |
| Developer OAuth | Deferred to Phase 3 | Requires Dashboard UI for browser consent flow |

## Non-Goals (Phase 2)

- Dashboard / Studio UI (Phase 3)
- Developer OAuth login (Phase 3 — needs Dashboard UI)
- ML-DSA-65 auth tokens (Phase 3 — Ed25519 JWTs are short-lived, low quantum risk)
- PQC TLS (Phase 3 — data already ML-KEM encrypted client-side)
- Passkey/WebAuthn (Phase 3 — needs Dashboard UI)
- Built-in SMTP / email rendering
- Arbitrary SQL RLS policies (complexity vs. zero-knowledge tradeoff)
- OAuth providers beyond Google + GitHub (adapter interface supports adding more)
