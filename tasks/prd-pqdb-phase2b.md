# PRD: pqdb Phase 2b — Advanced Auth & RLS

## Introduction

Phase 2b extends the pqdb auth-as-a-service foundation (Phase 2a) with production-grade auth capabilities: OAuth provider integration (Google + GitHub), magic link passwordless authentication, MFA/TOTP, custom roles with advanced RLS policies, email verification enforcement, password reset, and a webhook-based email delivery system. Together, these make pqdb's auth system feature-complete for real-world applications.

Phase 2b builds directly on Phase 2a's foundation: per-project user tables (`_pqdb_users`, `_pqdb_sessions`, `_pqdb_auth_settings`), email/password signup/login, end-user JWTs, and basic owner-column RLS.

### Problem

1. **No passwordless auth:** Developers can only offer email/password login. Many modern apps require OAuth (Google/GitHub) or magic link authentication.

2. **No MFA:** There is no second-factor authentication. Applications handling sensitive data cannot meet security compliance requirements.

3. **No email verification or password reset:** The `email_verified` field exists but is never enforced. Users who forget passwords have no recovery path.

4. **No custom roles:** All authenticated users have the same `authenticated` role. Developers cannot differentiate access levels (admin, moderator, viewer).

5. **Basic RLS only:** The owner-column RLS from Phase 2a only supports one pattern: "users see their own rows." There is no way to define role-based policies like "admins see all, moderators can edit, anonymous can read."

6. **No webhook system:** pqdb has no way to notify developer applications about auth events (verification emails, password resets, magic links). The `magic_link_webhook` field exists in settings but is not wired to anything.

### Solution

1. A webhook dispatch system that delivers auth events (magic links, email verification, password reset) to developer-configured HTTPS endpoints.

2. OAuth provider system with a pluggable adapter interface, shipping Google and GitHub adapters. OAuth identity linking by verified email.

3. Magic link passwordless authentication via webhook-delivered one-time tokens.

4. TOTP-based MFA with recovery codes, integrated into the login flow.

5. Custom roles defined per-project with role-based RLS policies (`owner`, `all`, `none` conditions per operation per role).

6. Email verification enforcement and password reset with session invalidation.

## Goals

- **G-1:** Developers can configure webhook URLs to receive auth event notifications (magic links, verification, password reset)
- **G-2:** End-users can verify their email address; developers can enforce verification before data access
- **G-3:** End-users can reset their password; all existing sessions are invalidated on password change
- **G-4:** End-users can sign in via magic link (passwordless) through the webhook system
- **G-5:** Developers can configure OAuth providers (Google, GitHub) per project with credentials stored in Vault
- **G-6:** End-users can sign in with Google or GitHub, with automatic account linking by verified email
- **G-7:** End-users can enroll in TOTP-based MFA; login requires second factor when enabled
- **G-8:** Developers can define custom roles and assign them to users
- **G-9:** Developers can define per-table RLS policies with `owner`/`all`/`none` conditions per role per operation
- **G-10:** SDK provides methods for all new auth capabilities: OAuth, magic links, MFA, email verification, password reset, roles, and policies
- **G-11:** E2E round-trip proven: OAuth flow, magic link, MFA enrollment + challenge, custom roles + RLS policies, email verification, password reset

## User Stories

### US-031: Auth webhook dispatch system
**Description:** As a platform operator, I want a webhook dispatch system so that auth events (magic links, email verification, password reset) can be delivered to developer applications.

**Dependencies:** None (US-024 from Phase 2a is complete — `_pqdb_auth_settings.magic_link_webhook` field exists)

**Acceptance Criteria:**
- [ ] New `webhook.py` service with `WebhookDispatcher` class that POSTs JSON payloads to configured webhook URLs
- [ ] Webhook URL read from `_pqdb_auth_settings.magic_link_webhook` for the project
- [ ] Webhook URL validation: MUST be HTTPS — reject `http://` URLs on save (update `auth_engine.py` settings validation)
- [ ] Payload format: `{ "type": "magic_link"|"email_verification"|"password_reset", "to": "email", "token": "plaintext_token", "expires_in": seconds }`
- [ ] Token generation: 32 bytes cryptographically random (`secrets.token_urlsafe(32)`), stored as argon2id hash
- [ ] Webhook dispatch is fire-and-forget with timeout (5s) — auth operations do not fail if webhook delivery fails
- [ ] Webhook dispatch logs success/failure via structlog (no retry in Phase 2b — keep it simple)
- [ ] Returns 400 if webhook URL not configured when an auth event requires it
- [ ] `_pqdb_verification_tokens` table auto-created in project database: `(id UUID PK, user_id UUID FK NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL, type TEXT NOT NULL, expires_at TIMESTAMPTZ, used BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ)`
- [ ] `ensure_auth_tables()` updated to create `_pqdb_verification_tokens` table
- [ ] Unit tests pass (URL validation, token generation, payload format, hash round-trip)
- [ ] Integration tests pass (webhook dispatch with mock server, token storage and retrieval)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-032: Email verification (webhook + verify endpoint)
**Description:** As a developer, I want email verification so that I can ensure end-users own the email addresses they register with, and optionally require verification before data access.

**Dependencies:** US-031

**Acceptance Criteria:**
- [ ] On signup, if `magic_link_webhook` is configured, server fires webhook with `type: "email_verification"`, token (24-hour expiry), and user email
- [ ] `POST /v1/auth/users/verify-email` accepts `{ token }`, validates against `_pqdb_verification_tokens` (type = email_verification, not expired, not used), sets `email_verified = true` on user, marks token as used
- [ ] `POST /v1/auth/users/resend-verification` accepts `{ email }`, requires apikey header, generates new token, fires webhook. Rate limited: 3/min per email
- [ ] When `require_email_verification = true` in `_pqdb_auth_settings`: CRUD operations via anon API key return 403 with `{ error: { code: "email_not_verified", message: "..." } }` for unverified users
- [ ] Enforcement check added to CRUD middleware: if table has owner column, user context present, `require_email_verification` enabled, and `email_verified = false` → 403
- [ ] Verification tokens are single-use — reusing a consumed token returns 400
- [ ] Expired tokens return 400 with clear message
- [ ] Unit tests pass (verification flow, enforcement logic, token expiry, single-use)
- [ ] Integration tests pass (signup → webhook fires → verify token → email_verified = true → CRUD access granted)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-033: Password reset (webhook + update endpoint)
**Description:** As a developer's end-user, I want to reset my password so that I can regain access to my account when I forget my credentials.

**Dependencies:** US-031

**Acceptance Criteria:**
- [ ] `POST /v1/auth/users/reset-password` accepts `{ email }`, requires apikey header, generates token (1-hour expiry), fires webhook with `type: "password_reset"`. Returns 200 regardless of whether email exists (prevent email enumeration)
- [ ] `POST /v1/auth/users/update-password` accepts `{ token, new_password }`, validates token against `_pqdb_verification_tokens` (type = password_reset, not expired, not used)
- [ ] On valid token: updates `password_hash` in `_pqdb_users`, marks token as used, sets `revoked = true` on ALL sessions for that user in `_pqdb_sessions` (invalidates all refresh tokens)
- [ ] Password validation: minimum length from `_pqdb_auth_settings.password_min_length`
- [ ] Rate limiting: 5 reset requests/min per email
- [ ] Unit tests pass (token generation, password update, session invalidation, rate limiting)
- [ ] Integration tests pass (reset-password → webhook fires → update-password → old sessions revoked → new login works)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-034: Magic link authentication
**Description:** As a developer's end-user, I want to sign in via magic link so that I can authenticate without a password.

**Dependencies:** US-031

**Acceptance Criteria:**
- [ ] `POST /v1/auth/users/magic-link` accepts `{ email }`, requires apikey header
- [ ] If user exists: generates token (15-min expiry), stores hash in `_pqdb_verification_tokens` (type = magic_link), fires webhook
- [ ] If user does not exist: creates new user in `_pqdb_users` with `password_hash = NULL`, then generates token and fires webhook
- [ ] `POST /v1/auth/users/verify-magic-link` accepts `{ token }`, validates against `_pqdb_verification_tokens`, sets `email_verified = true`, creates session, returns `{ user, access_token, refresh_token }`
- [ ] Magic link tokens are single-use — reusing returns 400
- [ ] Returns 400 if `magic_link_webhook` is not configured
- [ ] Rate limiting: 5 magic link requests/min per email
- [ ] Unit tests pass (token generation, user creation, verification, single-use, rate limiting)
- [ ] Integration tests pass (magic-link → webhook fires → verify → authenticated with JWT)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-035: OAuth provider adapter interface + provider CRUD
**Description:** As a developer, I want to configure OAuth providers for my project so that end-users can sign in with their existing accounts (Google, GitHub).

**Dependencies:** None (US-024 from Phase 2a is complete)

**Acceptance Criteria:**
- [ ] Abstract `OAuthProvider` base class in new `oauth.py` service: `get_authorization_url(state, redirect_uri) -> str`, `exchange_code(code, redirect_uri) -> OAuthTokens`, `get_user_info(tokens) -> OAuthUserInfo`
- [ ] `OAuthUserInfo` dataclass: `email`, `name`, `avatar_url`, `provider_uid`
- [ ] `POST /v1/projects/{id}/auth/providers` accepts `{ provider: "google"|"github", client_id, client_secret }`, stores credentials in Vault at `secret/pqdb/projects/{project_id}/oauth/{provider}`. Requires developer JWT
- [ ] `GET /v1/projects/{id}/auth/providers` lists configured providers (names only, no secrets). Requires developer JWT
- [ ] `DELETE /v1/projects/{id}/auth/providers/{name}` removes provider config from Vault. Requires developer JWT
- [ ] `_pqdb_oauth_identities` table auto-created in project database: `(id UUID PK, user_id UUID FK, provider TEXT NOT NULL, provider_uid TEXT NOT NULL, email TEXT, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ, UNIQUE(provider, provider_uid))`
- [ ] `ensure_auth_tables()` updated to create `_pqdb_oauth_identities` table
- [ ] VaultClient gains `store_oauth_credentials(project_id, provider, credentials)`, `get_oauth_credentials(project_id, provider)`, `delete_oauth_credentials(project_id, provider)` methods
- [ ] Unit tests pass (adapter interface, provider CRUD, Vault credential storage)
- [ ] Integration tests pass (configure provider → credentials stored in Vault → list shows provider → delete removes)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-036: Google OAuth adapter
**Description:** As a developer's end-user, I want to sign in with my Google account so that I don't need to create a separate password.

**Dependencies:** US-035

**Acceptance Criteria:**
- [ ] `GoogleOAuthProvider` implements `OAuthProvider` interface
- [ ] `GET /v1/auth/users/oauth/google/authorize` accepts `redirect_uri` query param, generates state token (signed JWT, 10-min expiry, contains redirect_uri + nonce), redirects to Google's consent screen (`https://accounts.google.com/o/oauth2/v2/auth`) with `response_type=code`, `scope=openid email profile`, `state=jwt`
- [ ] `GET /v1/auth/users/oauth/google/callback` receives `code` + `state` from Google, validates state JWT (signature + expiry), exchanges code for tokens via `https://oauth2.googleapis.com/token`, fetches user info from `https://www.googleapis.com/oauth2/v2/userinfo`
- [ ] Account linking: if user with matching email exists AND `email_verified = true`, links Google identity to existing user via `_pqdb_oauth_identities`. If no existing user, creates new user with `email_verified = true`, `password_hash = NULL`
- [ ] After authentication, redirects to `redirect_uri` from state JWT with access token and refresh token as URL fragment parameters
- [ ] Endpoint requires apikey header for project resolution
- [ ] Returns 400 if Google OAuth not configured for the project
- [ ] Returns 400 if state JWT is invalid or expired (CSRF protection)
- [ ] Unit tests pass (authorization URL generation, state JWT validation, code exchange mock, account linking logic)
- [ ] Integration tests pass (full authorize → callback → user created/linked → JWT issued)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-037: GitHub OAuth adapter
**Description:** As a developer's end-user, I want to sign in with my GitHub account so that I don't need to create a separate password.

**Dependencies:** US-035

**Acceptance Criteria:**
- [ ] `GitHubOAuthProvider` implements `OAuthProvider` interface
- [ ] `GET /v1/auth/users/oauth/github/authorize` generates state JWT, redirects to `https://github.com/login/oauth/authorize` with `scope=user:email`
- [ ] `GET /v1/auth/users/oauth/github/callback` validates state JWT, exchanges code via `https://github.com/login/oauth/access_token`, fetches user info from `https://api.github.com/user` + `https://api.github.com/user/emails` (for verified primary email)
- [ ] Same account linking logic as Google (match by verified email)
- [ ] Same redirect behavior with tokens as URL fragment parameters
- [ ] Endpoint requires apikey header for project resolution
- [ ] Returns 400 if GitHub OAuth not configured for the project
- [ ] Unit tests pass (authorization URL, code exchange mock, email extraction from GitHub API)
- [ ] Integration tests pass (full authorize → callback → user created/linked → JWT issued)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-038: SDK OAuth + magic link + verification methods
**Description:** As a developer using the SDK, I want methods for OAuth, magic links, email verification, and password reset so that I can integrate these auth flows into my application.

**Dependencies:** US-034, US-036

**Acceptance Criteria:**
- [ ] `client.auth.users.signInWithOAuth(provider, { redirectTo })` opens browser/returns URL for `GET /v1/auth/users/oauth/{provider}/authorize?redirect_uri=...`
- [ ] `client.auth.users.handleOAuthCallback(params)` extracts tokens from URL fragment, stores them, returns `{ data: { user, access_token, refresh_token }, error }`
- [ ] `client.auth.users.linkOAuth(provider, { redirectTo })` initiates OAuth linking for existing authenticated user
- [ ] `client.auth.users.unlinkOAuth(provider)` calls `DELETE /v1/auth/users/oauth/{provider}` to remove linked identity
- [ ] `client.auth.users.getLinkedProviders()` calls `GET /v1/auth/users/oauth/providers` to list linked OAuth providers
- [ ] `client.auth.users.signInWithMagicLink({ email })` calls `POST /v1/auth/users/magic-link`
- [ ] `client.auth.users.verifyMagicLink(token)` calls `POST /v1/auth/users/verify-magic-link`, stores tokens
- [ ] `client.auth.users.verifyEmail(token)` calls `POST /v1/auth/users/verify-email`
- [ ] `client.auth.users.resendVerification()` calls `POST /v1/auth/users/resend-verification`
- [ ] `client.auth.users.resetPassword({ email })` calls `POST /v1/auth/users/reset-password`
- [ ] `client.auth.users.updatePassword({ token, newPassword })` calls `POST /v1/auth/users/update-password`
- [ ] All methods return `{ data, error }` pattern — never throw
- [ ] Full TypeScript types for all request/response shapes
- [ ] Unit tests pass (method calls, token handling, error handling)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-039: MFA/TOTP enrollment, challenge, recovery codes
**Description:** As a developer's end-user, I want to enable TOTP-based two-factor authentication so that my account is protected by a second factor beyond my password.

**Dependencies:** None (US-026 from Phase 2a is complete)

**Acceptance Criteria:**
- [ ] `_pqdb_mfa_factors` table auto-created: `(id UUID PK, user_id UUID FK, type TEXT DEFAULT 'totp', secret TEXT NOT NULL, verified BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ)`
- [ ] `_pqdb_recovery_codes` table auto-created: `(id UUID PK, user_id UUID FK, code_hash TEXT NOT NULL, used BOOLEAN DEFAULT FALSE)`
- [ ] `ensure_auth_tables()` updated to create both MFA tables
- [ ] `POST /v1/auth/users/mfa/enroll` requires user JWT, generates TOTP secret (20 bytes, RFC 6238), stores unverified factor, generates 10 recovery codes (8 chars each, stored as argon2id hashes), returns `{ secret, qr_uri, recovery_codes }`
- [ ] `POST /v1/auth/users/mfa/verify` accepts `{ code }`, validates TOTP code against stored secret (30-second window, ±1 step tolerance), marks factor as `verified = true`
- [ ] Modified login flow: when user has verified MFA factor, `POST /v1/auth/users/login` returns `{ mfa_required: true, mfa_ticket }` instead of JWT. `mfa_ticket` is a signed JWT with 5-min expiry containing `{ sub: user_id, type: "mfa_challenge" }`
- [ ] `POST /v1/auth/users/mfa/challenge` accepts `{ ticket, code }`, validates mfa_ticket JWT + TOTP code, issues full user JWT (access + refresh tokens)
- [ ] Recovery codes work as TOTP substitutes: `POST /v1/auth/users/mfa/challenge` also accepts `{ ticket, recovery_code }`, validates against `_pqdb_recovery_codes` (argon2id verify, mark as used)
- [ ] `POST /v1/auth/users/mfa/unenroll` requires user JWT + valid TOTP code (must prove possession to disable), deletes MFA factor and recovery codes
- [ ] TOTP implementation: use `pyotp` library for RFC 6238 TOTP generation and validation
- [ ] Only one TOTP factor per user (return 409 if already enrolled)
- [ ] Unit tests pass (TOTP generation, validation with time drift, recovery code hashing, mfa_ticket JWT, enrollment/unenrollment)
- [ ] Integration tests pass (enroll → verify → login requires MFA → challenge with TOTP → authenticated; recovery code works as substitute)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-040: Custom roles + RLS policies
**Description:** As a developer, I want to define custom roles and per-table RLS policies so that I can implement fine-grained access control beyond the basic owner-column filtering.

**Dependencies:** None (US-028 from Phase 2a is complete)

**Acceptance Criteria:**
- [ ] `_pqdb_roles` table auto-created: `(id UUID PK, name TEXT UNIQUE NOT NULL, description TEXT, created_at TIMESTAMPTZ)`. Built-in roles `authenticated` and `anon` auto-inserted as seed data
- [ ] `_pqdb_policies` table auto-created: `(id UUID PK, table_name TEXT NOT NULL, name TEXT NOT NULL, operation TEXT NOT NULL CHECK (operation IN ('select', 'insert', 'update', 'delete')), role TEXT NOT NULL, condition TEXT NOT NULL CHECK (condition IN ('owner', 'all', 'none')), created_at TIMESTAMPTZ, UNIQUE(table_name, operation, role))`
- [ ] `ensure_auth_tables()` updated to create both tables and seed built-in roles
- [ ] `POST /v1/projects/{id}/auth/roles` accepts `{ name, description }`, creates custom role. Requires developer JWT. Returns 409 if role name exists. Cannot create role named `anon` or `authenticated` (reserved)
- [ ] `GET /v1/projects/{id}/auth/roles` lists all roles (built-in + custom). Requires developer JWT
- [ ] `DELETE /v1/projects/{id}/auth/roles/{name}` deletes custom role and all associated policies. Requires developer JWT. Cannot delete built-in roles (400)
- [ ] `PUT /v1/auth/users/{user_id}/role` accepts `{ role }`, validates role exists in `_pqdb_roles`, updates user's `role` field. Requires service API key (admin-only operation)
- [ ] `POST /v1/db/tables/{name}/policies` accepts `{ name, operation, role, condition }`, creates RLS policy. Requires developer JWT. Returns 409 if policy for (table, operation, role) already exists
- [ ] `GET /v1/db/tables/{name}/policies` lists policies for a table. Requires apikey header
- [ ] `DELETE /v1/db/tables/{name}/policies/{id}` deletes a specific policy. Requires developer JWT
- [ ] CRUD service RLS enforcement updated: when `_pqdb_policies` table has entries for the target table, use policy lookup instead of basic owner-column logic:
  1. Extract `role` from user JWT (or `anon` if no JWT)
  2. Look up policy for `(table, operation, role)`
  3. No policy found → deny (default `none`) with 403
  4. `owner` condition → inject `WHERE {owner_column} = :user_id`
  5. `all` condition → no filter
  6. `none` condition → return 403
- [ ] When no policies exist for a table, fall back to Phase 2a basic owner-column RLS behavior (backward compatible)
- [ ] Service role API key always bypasses RLS policies (admin access)
- [ ] Unit tests pass (role CRUD, policy CRUD, policy enforcement, fallback to basic RLS, service role bypass)
- [ ] Integration tests pass (create roles → assign user → create policies → verify role-based access: admin sees all, moderator can edit, user sees own, anon reads public)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-041: SDK roles + policies + MFA methods
**Description:** As a developer using the SDK, I want methods for managing roles, RLS policies, and MFA so that I can integrate these capabilities into my application.

**Dependencies:** US-039, US-040

**Acceptance Criteria:**
- [ ] `client.auth.roles.create({ name, description })` calls `POST /v1/projects/{id}/auth/roles`
- [ ] `client.auth.roles.list()` calls `GET /v1/projects/{id}/auth/roles`
- [ ] `client.auth.roles.delete(name)` calls `DELETE /v1/projects/{id}/auth/roles/{name}`
- [ ] `client.auth.users.setRole(userId, role)` calls `PUT /v1/auth/users/{userId}/role` (requires service API key)
- [ ] `client.auth.policies.create(tableName, { name, operation, role, condition })` calls `POST /v1/db/tables/{name}/policies`
- [ ] `client.auth.policies.list(tableName)` calls `GET /v1/db/tables/{name}/policies`
- [ ] `client.auth.policies.delete(tableName, policyId)` calls `DELETE /v1/db/tables/{name}/policies/{id}`
- [ ] `client.auth.users.mfa.enroll()` calls `POST /v1/auth/users/mfa/enroll`, returns `{ data: { secret, qr_uri, recovery_codes }, error }`
- [ ] `client.auth.users.mfa.verify({ code })` calls `POST /v1/auth/users/mfa/verify`
- [ ] `client.auth.users.mfa.challenge({ ticket, code })` calls `POST /v1/auth/users/mfa/challenge`, stores resulting tokens
- [ ] `client.auth.users.mfa.unenroll({ code })` calls `POST /v1/auth/users/mfa/unenroll`
- [ ] Modified `signIn` flow: when response contains `mfa_required: true`, return `{ data: { mfa_required: true, mfa_ticket }, error: null }` — caller must call `mfa.challenge()` to complete login
- [ ] All methods return `{ data, error }` pattern — never throw
- [ ] Full TypeScript types for all request/response shapes
- [ ] `client.auth.roles` and `client.auth.policies` namespaces added to AuthClient
- [ ] Unit tests pass (method calls, MFA flow, role/policy management, error handling)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-042: Phase 2b E2E tests
**Description:** As the engineering team, we need end-to-end tests proving all Phase 2b auth capabilities work across the full stack: SDK → API → database → SDK.

**Dependencies:** US-041, US-038

**Acceptance Criteria:**
- [ ] Test setup: Docker Compose starts Postgres + Vault, FastAPI backend runs against them, SDK connects to backend, mock webhook server captures auth events
- [ ] **Test 1 — OAuth flow:** Configure Google OAuth provider (mock) → SDK initiates OAuth → simulate callback with code → user created → JWT issued → user can query data
- [ ] **Test 2 — Magic link:** Configure webhook URL → SDK requests magic link → webhook receives token → SDK verifies token → user authenticated → can query data
- [ ] **Test 3 — MFA enrollment + challenge:** User signs up → enrolls MFA → login returns mfa_required → challenge with TOTP code → authenticated. Also test recovery code as TOTP substitute
- [ ] **Test 4 — Custom roles + advanced RLS:** Create `admin`, `moderator` roles → create policies (admin: all, moderator: owner for update, authenticated: owner, anon: all for select) → assign user role → verify access matches policies
- [ ] **Test 5 — Password reset:** User signs up → requests password reset → webhook receives token → update password → old sessions invalidated → new login with new password works
- [ ] **Test 6 — Email verification:** Configure `require_email_verification = true` → user signs up → CRUD denied (unverified) → verify email → CRUD allowed
- [ ] All 6 tests pass
- [ ] CI passes (tests run in CI with Docker Compose)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-031: Auth webhook dispatch system          (Dependencies: None)
US-032: Email verification                    (Dependencies: US-031)
US-033: Password reset                        (Dependencies: US-031)
US-034: Magic link authentication             (Dependencies: US-031)
US-035: OAuth provider adapter + CRUD         (Dependencies: None)           ← parallel with US-031
US-036: Google OAuth adapter                  (Dependencies: US-035)
US-037: GitHub OAuth adapter                  (Dependencies: US-035)         ← parallel with US-036
US-038: SDK OAuth + magic link + verification (Dependencies: US-034, US-036)
US-039: MFA/TOTP enrollment + challenge       (Dependencies: None)           ← parallel with US-031, US-035
US-040: Custom roles + RLS policies           (Dependencies: None)           ← parallel with US-031, US-035, US-039
US-041: SDK roles + policies + MFA            (Dependencies: US-039, US-040)
US-042: Phase 2b E2E tests                    (Dependencies: US-041, US-038)
```

### Parallel Execution Chains

```
Chain D (Webhooks):    US-031 → US-032, US-033, US-034 (parallel after US-031) ──┐
Chain E (OAuth):       US-035 → US-036, US-037 (parallel) ──────────────────────┤
Chain F (MFA):         US-039 (independent) ────────────────────────────────────┤
Chain G (Roles/RLS):   US-040 (independent) ────────────────────────────────────┤
                                                                                 │
Chain H (SDK):         US-038 (waits for US-034, US-036) ───────────────────────┤
                       US-041 (waits for US-039, US-040) ───────────────────────┤
                                                                                 └→ US-042 (E2E)
```

**Four independent starting chains** — US-031, US-035, US-039, and US-040 can all begin in parallel.

**Critical path:** US-031 → US-034 → US-038 → US-042 (webhook → magic link → SDK → E2E)

## Functional Requirements

- **FR-1:** Webhook dispatch system delivers auth events as JSON to developer-configured HTTPS URLs
- **FR-2:** Webhook URL validation rejects non-HTTPS URLs
- **FR-3:** Email verification uses one-time tokens with 24-hour expiry, delivered via webhook
- **FR-4:** Email verification can be enforced via `require_email_verification` setting, blocking CRUD for unverified users
- **FR-5:** Password reset uses one-time tokens with 1-hour expiry, invalidates all existing sessions on success
- **FR-6:** Magic link authentication creates passwordless users and issues JWTs via one-time tokens with 15-min expiry
- **FR-7:** OAuth providers use a pluggable adapter interface with Google and GitHub implementations
- **FR-8:** OAuth credentials are stored in Vault, not in the database
- **FR-9:** OAuth state tokens are signed JWTs (CSRF protection), not stored in DB
- **FR-10:** OAuth account linking merges identities by email only when existing account's email is verified
- **FR-11:** TOTP-based MFA follows RFC 6238 with 30-second windows and ±1 step tolerance
- **FR-12:** MFA login flow returns `mfa_required` + `mfa_ticket` (5-min JWT) instead of full tokens
- **FR-13:** 10 recovery codes generated on MFA enrollment, stored as argon2id hashes, each single-use
- **FR-14:** Custom roles defined per-project with built-in `authenticated` and `anon` roles
- **FR-15:** RLS policies define per-table, per-operation, per-role access with `owner`/`all`/`none` conditions
- **FR-16:** No policy = deny (default `none`); tables without policies fall back to Phase 2a basic RLS
- **FR-17:** Service role API key always bypasses RLS policies
- **FR-18:** SDK provides `client.auth.users.mfa.*`, `client.auth.roles.*`, `client.auth.policies.*` namespaces
- **FR-19:** All new SDK methods return `{ data, error }` — never throw

## Non-Goals (Phase 2b)

- Built-in SMTP or email rendering — developers use their own email infrastructure via webhooks
- OAuth providers beyond Google and GitHub — the adapter interface supports adding more later
- Arbitrary SQL RLS policies — only `owner`/`all`/`none` conditions (zero-knowledge compatible)
- Passkey/WebAuthn — requires Dashboard UI (Phase 3)
- Developer OAuth login — requires Dashboard UI (Phase 3)
- ML-DSA-65 auth tokens — Ed25519 JWTs are short-lived, low quantum risk (Phase 3)
- PQC TLS — data already ML-KEM encrypted client-side (Phase 3)
- Webhook retry/dead-letter queue — keep it simple for now; fire-and-forget with logging
- MFA types beyond TOTP — no push notifications, no SMS, no hardware keys

## Technical Considerations

- **Backend:** Python 3.12+ / FastAPI, same architecture. New services: `webhook.py` (dispatch), `oauth.py` (adapter interface + providers), `mfa.py` (TOTP). New routes: `oauth.py`, `mfa.py`, `verification.py`. Modified: `user_auth.py` (MFA login flow), `crud.py` (policy-based RLS), `auth_engine.py` (new tables).
- **SDK:** TypeScript 5.x. New modules: `src/client/mfa.ts`, `src/client/roles.ts`, `src/client/policies.ts`. Updated: `src/client/user-auth.ts` (OAuth, magic link, verification, password reset methods), `src/client/auth.ts` (roles and policies namespaces).
- **Database:** No Alembic migrations — all new tables are in project databases (created dynamically via `ensure_auth_tables()`). New tables: `_pqdb_verification_tokens`, `_pqdb_oauth_identities`, `_pqdb_mfa_factors`, `_pqdb_recovery_codes`, `_pqdb_roles`, `_pqdb_policies`.
- **Vault:** New path for OAuth credentials: `secret/pqdb/projects/{project_id}/oauth/{provider}`.
- **Dependencies:** `pyotp` for TOTP, `httpx` for webhook dispatch and OAuth code exchange (already available via FastAPI).
- **Testing:** Integration tests require real Postgres + Vault. E2E tests need mock webhook server and mock OAuth provider. OAuth E2E can mock Google/GitHub APIs since real OAuth requires browser interaction.

## Success Metrics

- **SM-1:** OAuth E2E: configure provider → authorize → callback → user created/linked → JWT works
- **SM-2:** Magic link E2E: request → webhook fires → verify token → authenticated
- **SM-3:** MFA E2E: enroll → login requires TOTP → challenge → authenticated; recovery code works
- **SM-4:** Custom roles E2E: create roles → assign → policies enforce role-based access
- **SM-5:** Password reset E2E: request → webhook → update password → old sessions invalidated
- **SM-6:** Email verification E2E: enforcement blocks unverified → verify → access granted
- **SM-7:** All 12 stories have passing tests in CI
- **SM-8:** TypeScript SDK compiles with strict mode, zero type errors
- **SM-9:** Backend passes mypy strict type checking

## Open Questions

- **OQ-1:** Should webhook dispatch be async (background task via FastAPI's BackgroundTasks) or synchronous? Sync is simpler but adds latency to signup. Background is better UX but harder to report errors. Current design: fire-and-forget with BackgroundTasks.
- **OQ-2:** For OAuth callback, should tokens be returned as URL fragment (`#access_token=...`) or as query parameters (`?access_token=...`)? Fragment is more secure (not sent to server on redirect) but harder to extract server-side. Current design: URL fragment.
- **OQ-3:** Should the recovery codes endpoint be separate from MFA enrollment (`POST /v1/auth/users/mfa/recovery-codes/regenerate`) or only generated during enrollment? Current design: only on enrollment — if all codes are used, user must unenroll and re-enroll.
