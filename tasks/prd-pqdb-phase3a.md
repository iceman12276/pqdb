# PRD: pqdb Phase 3a — Dashboard + Developer Auth

## Introduction

Phase 3a transforms pqdb from an API-only platform into a visual developer experience with a Dashboard/Studio UI modeled after Supabase. It also adds Developer OAuth (Google/GitHub) and Passkey/WebAuthn login for the platform, plus encryption key management UX to help developers understand and protect their zero-knowledge keys.

Phase 3a builds on the complete Phase 1 (core MVP) and Phase 2 (key rotation + auth-as-a-service) foundation. The Dashboard communicates with the backend exclusively via the existing REST API — it is a visual client, same as the SDK.

### Problem

1. **No visual interface:** Developers manage everything via CLI and SDK. No way to browse schemas, view data, configure auth settings, or manage API keys visually. Every competing platform ships a dashboard.

2. **No Developer OAuth:** Developers can only log in with email/password. No Google/GitHub login despite the Dashboard providing the browser context needed for OAuth consent flows.

3. **No Passkey/WebAuthn:** Passwords are phishable. The Dashboard provides the browser context needed for `navigator.credentials`, but there's no passkey support.

4. **No key management guidance:** The `encryptionKey` is the only way to decrypt sensitive data. If lost, data is permanently unrecoverable. There's no warning, guidance, or UX for key backup.

### Solution

1. A Dashboard/Studio UI built with TanStack Start + React, dark theme, matching Supabase's layout — sidebar navigation, project overview, table editor, schema visualizer, query playground, auth settings, logs.

2. Developer OAuth login (Google/GitHub) reusing the Phase 2b `OAuthProvider` adapter interface with platform-scoped credentials stored in Vault.

3. Passkey/WebAuthn registration and login using `py_webauthn`, with passkey management in developer settings.

4. Encryption key management UX: Dashboard "Unlock" flow with key backup guidance, SDK warning on `createClient()`, Project Settings "Encryption" section.

## Goals

- **G-1:** Developers can manage their pqdb projects through a visual Dashboard UI
- **G-2:** Dashboard displays data with client-side decryption (zero-knowledge preserved — key in browser memory only)
- **G-3:** Schema visualizer shows tables as ERD with sensitivity badges and foreign key relationships
- **G-4:** Developers can log in with Google or GitHub in addition to email/password
- **G-5:** Developers can register and log in with passkeys (WebAuthn)
- **G-6:** Developers receive clear guidance on encryption key management and backup
- **G-7:** E2E round-trip proven: Dashboard login → project management → data viewing → OAuth → Passkey

## User Stories

### US-043: Dashboard scaffolding
**Description:** As a developer, I want a Dashboard application scaffolded so that the team can build pages on a solid foundation.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `/dashboard` directory with TanStack Start + React 19 project
- [ ] TanStack Router with file-based routing configured
- [ ] TanStack Query configured for data fetching/caching
- [ ] shadcn/ui installed with Tailwind CSS
- [ ] Dark theme by default with theme toggle
- [ ] Layout shell: top bar (account selector, project selector, "Connect" button, `Cmd+K` search, settings gear) + left sidebar navigation
- [ ] Sidebar items: Project Overview, Table Editor, Query Playground, Schema, Authentication, Realtime (grayed out), Logs, MCP (grayed out), Project Settings
- [ ] App served on `localhost:3000`
- [ ] `npm run dev` starts the Dashboard with hot reload
- [ ] `npm run build` produces production build
- [ ] `npm run typecheck` passes with zero errors
- [ ] Unit tests pass (layout renders, sidebar items present, theme toggle works)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-044: Dashboard login/signup pages
**Description:** As a developer, I want login and signup pages so that I can authenticate with the pqdb platform via the Dashboard.

**Dependencies:** US-043

**Acceptance Criteria:**
- [ ] `/login` page with email/password form calling existing `POST /v1/auth/login` endpoint
- [ ] `/signup` page with email/password form calling existing `POST /v1/auth/signup` endpoint
- [ ] Login page includes placeholder buttons for "Sign in with Google", "Sign in with GitHub", "Sign in with Passkey" (wired in US-053)
- [ ] Developer JWTs stored in memory (TanStack Query cache) with optional sessionStorage for tab-persistence; cleared on tab close
- [ ] JWT auto-attached to all API requests via `Authorization: Bearer` header
- [ ] Token refresh handled automatically when access token expires (reuse existing refresh endpoint)
- [ ] Unauthenticated users redirected to `/login`
- [ ] Successful login redirects to `/projects`
- [ ] Error handling: 401 shows "Invalid credentials", 409 shows "Email already registered"
- [ ] Unit tests pass (form validation, token storage, redirect logic)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-045: Project list + create project pages
**Description:** As a developer, I want to see my projects and create new ones from the Dashboard so that I can manage my pqdb projects visually.

**Dependencies:** US-044

**Acceptance Criteria:**
- [ ] `/projects` page lists all projects for the authenticated developer (calls `GET /v1/projects`)
- [ ] Each project card shows: name, status badge (active/archived), region, created date
- [ ] "Create Project" button opens a modal/form (name required, region optional)
- [ ] Creating a project calls `POST /v1/projects` and redirects to project overview on success
- [ ] Empty state shown when developer has no projects
- [ ] Project selector dropdown in top bar populated from project list
- [ ] Selecting a project from the dropdown navigates to `/projects/:id`
- [ ] "Connect" button in top bar shows a popup with API keys (masked) + SDK connection snippet
- [ ] Unit tests pass (project list rendering, create form validation, empty state)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-046: Project overview page + logs page
**Description:** As a developer, I want to see my project's status and logs so that I can monitor its health and activity.

**Dependencies:** US-045

**Acceptance Criteria:**
- [ ] `/projects/:id` page shows project overview with status cards: STATUS (active/archived), TABLES (count), ENCRYPTION (ML-KEM-768), HMAC KEY (version number), AUTH USERS (count), RLS POLICIES (count)
- [ ] Overview page shows project URL and connection info
- [ ] Total Requests section with breakdown cards: DATABASE REQUESTS, AUTH REQUESTS, REALTIME REQUESTS (placeholder 0 until Phase 3b), MCP REQUESTS (placeholder 0 until Phase 3b)
- [ ] `/projects/:id/logs` page shows read-only audit log viewer
- [ ] Backend: new `_pqdb_audit_log` table auto-created per project DB by `ensure_audit_table()`: `(id UUID PK, event_type TEXT, method TEXT, path TEXT, status_code INTEGER, project_id UUID, user_id UUID NULL, ip_address TEXT, created_at TIMESTAMPTZ)`
- [ ] Backend: audit logging middleware writes API request logs to `_pqdb_audit_log`
- [ ] Logs page paginates and filters by event type, status code, time range
- [ ] Unit tests pass (status card rendering, log list rendering, filter logic)
- [ ] Integration tests pass (audit log middleware writes entries, log retrieval endpoint works)
- [ ] Service responds to health check
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-047: API key management page
**Description:** As a developer, I want to manage API keys from the Dashboard so that I can view, rotate, and copy connection info.

**Dependencies:** US-045

**Acceptance Criteria:**
- [ ] `/projects/:id/keys` page shows `anon` and `service` API keys in masked format (`pqdb_anon_****...****`)
- [ ] "Rotate Keys" button calls `POST /v1/projects/{id}/keys/rotate`, shows new keys in a one-time display modal
- [ ] Copy-to-clipboard button for each key and for SDK connection snippet
- [ ] SDK connection snippet format: `createClient('http://localhost:8000', 'pqdb_anon_...')`
- [ ] Warning displayed: "Keys are shown only once. Store them securely."
- [ ] Unit tests pass (masked display, copy button, rotation flow)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-048: Schema browser + schema visualizer
**Description:** As a developer, I want to browse my schema and see it as a visual ERD so that I can understand my database structure at a glance.

**Dependencies:** US-045

**Acceptance Criteria:**
- [ ] `/projects/:id/schema` page with two views: list view (table list with columns) and ERD view (React Flow)
- [ ] ERD view: each table rendered as a node with columns listed inside
- [ ] Foreign key relationships shown as connecting lines between table nodes
- [ ] Color-coded sensitivity badges: plain (gray), searchable (blue), private (purple)
- [ ] Owner columns marked with a key icon
- [ ] Logical view (default): shows developer-facing column names (`email`, `name`)
- [ ] Physical view (toggle): shows actual Postgres columns (`email_encrypted`, `email_index`)
- [ ] Interactive: drag, zoom, auto-layout
- [ ] Data source: `GET /v1/db/introspect` endpoint (no new backend work)
- [ ] Column management: "Add Column" form with name, type, sensitivity dropdown
- [ ] Calls `POST /v1/db/tables/{name}/columns` to add columns
- [ ] React Flow dependency: `npm install @xyflow/react`
- [ ] Unit tests pass (ERD renders tables, sensitivity badges correct, toggle switches view)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-049: Table editor with data viewer + client-side decryption
**Description:** As a developer, I want to view and edit table data in the Dashboard with the ability to decrypt sensitive columns so that I can see my actual data.

**Dependencies:** US-048

**Acceptance Criteria:**
- [ ] `/projects/:id/tables` page lists all tables with row counts
- [ ] `/projects/:id/tables/:name` page shows paginated rows with column headers
- [ ] Plain columns display values directly; encrypted columns display `[encrypted]` by default
- [ ] "Unlock" button prompts developer to enter their encryption key
- [ ] Encryption key loaded into `@pqdb/client` SDK running in the browser
- [ ] SDK fetches ciphertext from API, decrypts client-side, displays plaintext
- [ ] Key held in memory only — never sent to server, never persisted to localStorage/sessionStorage/cookies
- [ ] "Lock" button clears the key from memory and reverts to `[encrypted]` display
- [ ] Closing the tab clears the key automatically
- [ ] Row insert form: creates new rows via `POST /v1/db/{table}/insert`
- [ ] Row delete: deletes rows via `POST /v1/db/{table}/delete`
- [ ] Unit tests pass (table renders, encrypted columns show placeholder, unlock/lock flow)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-050: Query playground
**Description:** As a developer, I want a query playground so that I can build and execute queries visually with decrypted results.

**Dependencies:** US-048

**Acceptance Criteria:**
- [ ] `/projects/:id/sql` page with query builder interface
- [ ] Query builder uses SDK query builder syntax: select table, choose columns, add filters (.eq, .gt, .lt, etc.), set limit/offset/order
- [ ] Execute button runs the query via `POST /v1/db/{table}/select`
- [ ] Results displayed in table format below the builder
- [ ] Encrypted columns show `[encrypted]` unless "Unlock" is active (shares key state with Table Editor via context)
- [ ] When unlocked, SDK decrypts results client-side before display
- [ ] Query history (in-memory, lost on tab close)
- [ ] Error display: shows API error messages clearly
- [ ] Unit tests pass (query builder produces correct payloads, results render, error handling)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-051: Auth settings page
**Description:** As a developer, I want to configure auth settings from the Dashboard so that I can manage OAuth providers, roles, RLS policies, and verification settings visually.

**Dependencies:** US-045

**Acceptance Criteria:**
- [ ] `/projects/:id/auth` page with tabs: Providers, Roles, Policies, Settings
- [ ] Providers tab: lists configured OAuth providers (from `GET /v1/projects/{id}/auth/providers`), with "Add Provider" form
- [ ] Roles tab: lists roles (from `GET /v1/projects/{id}/auth/roles`), with "Create Role" form and delete buttons (built-in roles cannot be deleted)
- [ ] Policies tab: per-table policy viewer and editor (from `GET /v1/db/tables/{name}/policies`), with "Add Policy" form (operation, role, condition dropdowns)
- [ ] Settings tab: auth settings form (`require_email_verification`, `password_min_length`, `mfa_enabled`, webhook URL)
- [ ] All forms call existing Phase 2b API endpoints — no new backend work
- [ ] Unit tests pass (tab rendering, form validation, API call payloads)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-052: Developer OAuth backend
**Description:** As a platform operator, I want Developer OAuth login endpoints so that developers can sign in with Google or GitHub.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Alembic migration adds `email_verified BOOLEAN DEFAULT FALSE` to `developers` table
- [ ] Alembic migration creates `developer_oauth_identities` table: `(id UUID PK, developer_id UUID FK, provider TEXT NOT NULL, provider_uid TEXT NOT NULL, email TEXT, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, UNIQUE(provider, provider_uid))`
- [ ] `GET /v1/auth/oauth/{provider}/authorize` — generates state JWT (10-min expiry), redirects to provider consent screen
- [ ] `GET /v1/auth/oauth/{provider}/callback` — validates state JWT, exchanges code, finds-or-creates developer, issues developer JWT
- [ ] Account linking: matches by email only when existing developer has `email_verified = true`
- [ ] New developer created via OAuth gets `email_verified = true` automatically
- [ ] VaultClient gains `store_platform_oauth_credentials()`, `get_platform_oauth_credentials()`, `delete_platform_oauth_credentials()` for path `secret/pqdb/platform/oauth/{provider}`
- [ ] Platform operator configures credentials via env vars or admin endpoint
- [ ] Reuses existing `OAuthProvider` ABC from Phase 2b — `GoogleOAuthProvider` and `GitHubOAuthProvider` work with platform credential source
- [ ] Returns 400 if provider not configured
- [ ] Returns 400 if state JWT invalid or expired
- [ ] Unit tests pass (state JWT generation, callback validation, account linking logic, Vault storage)
- [ ] Integration tests pass (full authorize → callback → developer created/linked → JWT issued)
- [ ] Service responds to health check
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-053: Developer OAuth + Passkey/WebAuthn Dashboard integration
**Description:** As a developer, I want to sign in with Google, GitHub, or a passkey from the Dashboard so that I have multiple secure login options.

**Dependencies:** US-044, US-052

**Acceptance Criteria:**
- [ ] Login page "Sign in with Google" and "Sign in with GitHub" buttons wired to `GET /v1/auth/oauth/{provider}/authorize?redirect_uri=...`
- [ ] OAuth callback handling: Dashboard extracts tokens from redirect, stores in memory
- [ ] Alembic migration creates `developer_credentials` table: `(id UUID PK, developer_id UUID FK, credential_id BYTEA UNIQUE NOT NULL, public_key BYTEA NOT NULL, sign_count INTEGER DEFAULT 0, name TEXT, created_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ)`
- [ ] Backend: `GET /v1/auth/passkeys/challenge` returns registration or authentication options
- [ ] Backend: `POST /v1/auth/passkeys/register` validates attestation via `py_webauthn`, stores credential
- [ ] Backend: `POST /v1/auth/passkeys/authenticate` validates assertion, issues developer JWT
- [ ] Passkey login uses discoverable credentials (empty `allowCredentials` list)
- [ ] Login page "Sign in with Passkey" button triggers `navigator.credentials.get()`
- [ ] `/settings` page: "Security" section with "Add Passkey" button triggering `navigator.credentials.create()`
- [ ] `/settings` page: list registered passkeys with names and "Delete" button
- [ ] `/settings` page: list linked OAuth accounts with "Unlink" button
- [ ] WebAuthn Relying Party ID configurable via `PQDB_WEBAUTHN_RP_ID` env var (default: `localhost`)
- [ ] `py_webauthn` added as backend dependency via `uv add py-webauthn`
- [ ] Unit tests pass (challenge generation, attestation validation mock, assertion validation mock, credential CRUD)
- [ ] Integration tests pass (register passkey → authenticate with passkey → JWT issued; OAuth login flow)
- [ ] Service responds to health check
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-054: Encryption key management UX
**Description:** As a developer, I want clear guidance on encryption key management so that I understand the zero-knowledge model and don't accidentally lose my key.

**Dependencies:** US-049

**Acceptance Criteria:**
- [ ] Dashboard: "Unlock" modal includes a dismissable warning: "Your encryption key is never sent to the server. If you lose this key, your encrypted data is permanently unrecoverable. Store it securely."
- [ ] Dashboard: `/projects/:id/settings` page gains an "Encryption" section explaining the zero-knowledge model and key backup best practices
- [ ] Encryption section shows: key type (ML-KEM-768), what it protects, what happens if lost
- [ ] Encryption section includes backup recommendations: password manager, secure vault, offline backup
- [ ] SDK: `createClient()` with an `encryptionKey` logs a one-time console warning (via `console.warn`) about key backup responsibility
- [ ] SDK warning only logs once per client instance (not on every query)
- [ ] Unit tests pass (warning renders in Dashboard, SDK warning fires once, settings page content)
- [ ] Verify in browser
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### US-055: Phase 3a E2E tests
**Description:** As the engineering team, we need end-to-end tests proving all Phase 3a capabilities work: Dashboard pages, data viewer with decryption, developer OAuth, and passkey login.

**Dependencies:** US-054, US-053, US-051

**Acceptance Criteria:**
- [ ] Test setup: Docker Compose starts Postgres + Vault, FastAPI backend runs, Dashboard dev server runs, Playwright configured for headless browser testing
- [ ] **Test 1 — Dashboard flow:** Login with email/password → create project → view in project list → navigate to project overview → see status cards
- [ ] **Test 2 — Schema visualizer:** Create tables with mixed sensitivity → navigate to schema page → ERD renders with correct sensitivity badges and relationships
- [ ] **Test 3 — Data viewer + decryption:** Insert data via SDK → navigate to table editor → encrypted columns show `[encrypted]` → unlock with encryption key → plaintext visible → lock → reverts to `[encrypted]`
- [ ] **Test 4 — Developer OAuth:** Configure Google OAuth (mock) → click "Sign in with Google" → simulate callback → developer account linked → Dashboard access
- [ ] **Test 5 — Passkey:** Register passkey (WebAuthn mock via Playwright virtual authenticator) → sign out → sign in with passkey → Dashboard access
- [ ] **Test 6 — Key management UX:** Encryption key warning appears in SDK console, Dashboard settings page shows encryption section
- [ ] All 6 tests pass
- [ ] CI passes (Playwright tests run headless in GitHub Actions)
- [ ] Typecheck passes
- [ ] Production build succeeds

---

### Dependency Graph

```
US-043: Dashboard scaffolding               (Dependencies: None)
US-044: Login/signup pages                   (Dependencies: US-043)
US-045: Project list + create                (Dependencies: US-044)
US-046: Project overview + logs              (Dependencies: US-045)
US-047: API key management                   (Dependencies: US-045)         ← parallel with US-046, US-048, US-051
US-048: Schema browser + visualizer          (Dependencies: US-045)         ← parallel with US-046, US-047, US-051
US-049: Table editor + decryption            (Dependencies: US-048)
US-050: Query playground                     (Dependencies: US-048)         ← parallel with US-049
US-051: Auth settings page                   (Dependencies: US-045)         ← parallel with US-046, US-047, US-048
US-052: Developer OAuth backend              (Dependencies: None)           ← independent, parallel with all Dashboard stories
US-053: OAuth + Passkey Dashboard integration (Dependencies: US-044, US-052)
US-054: Encryption key management UX         (Dependencies: US-049)
US-055: Phase 3a E2E tests                   (Dependencies: US-054, US-053, US-051)
```

### Parallel Execution Chains

```
Chain A (Dashboard core):  US-043 → US-044 → US-045 → US-046, US-047, US-048, US-051 (parallel)
                                                         US-048 → US-049, US-050 (parallel)
                                                         US-049 → US-054

Chain B (Dev auth):        US-052 (independent) ──────→ US-053 (needs US-044)

E2E convergence:           US-054 + US-053 + US-051 ──→ US-055 (E2E)
```

**Critical path:** US-043 → US-044 → US-045 → US-048 → US-049 → US-054 → US-055

## Functional Requirements

- **FR-1:** Dashboard served as a TanStack Start application on `localhost:3000`
- **FR-2:** Dashboard communicates with backend exclusively via REST API — no direct DB access
- **FR-3:** Dark theme by default with Supabase-style sidebar layout
- **FR-4:** Client-side decryption via `@pqdb/client` SDK loaded in browser; key in memory only
- **FR-5:** Schema visualizer renders interactive ERD with React Flow
- **FR-6:** Sensitivity badges: plain (gray), searchable (blue), private (purple)
- **FR-7:** Developer OAuth (Google + GitHub) using existing `OAuthProvider` ABC with platform-scoped Vault credentials
- **FR-8:** Passkey/WebAuthn via `py_webauthn` with discoverable credentials
- **FR-9:** All three login methods (email/password, OAuth, passkey) produce the same developer JWT
- **FR-10:** Encryption key warning in SDK and Dashboard
- **FR-11:** Passkey registration requires active session; passkeys manageable from settings
- **FR-12:** Audit log table auto-created per project DB; Dashboard shows read-only log viewer

## Non-Goals (Phase 3a)

- **Realtime page** — grayed out in sidebar, built in Phase 3b
- **MCP page** — grayed out in sidebar, built in Phase 3b
- **Vector index management UI** — built in Phase 3b
- **SSR** — Dashboard is a SPA, no server-side rendering needed
- **File storage** — not in pqdb's scope
- **OAuth providers beyond Google + GitHub** — adapter interface supports adding more later
- **Key recovery mechanism** — would break zero-knowledge; guidance only

## Design Considerations

- **Supabase-style layout:** Top bar with project selector + Connect button, left sidebar with navigation items, main content area
- **"Connect" button:** Popup showing API keys (masked) + SDK connection snippet — included in US-045 as part of top bar
- **Realtime + MCP sidebar items:** Rendered but grayed out with "Coming soon" tooltip, activated in Phase 3b
- **Testing:** Playwright for automated CI E2E; Claude in Chrome for interactive visual QA during development

## Technical Considerations

- **Dashboard:** TanStack Start + React 19, TanStack Router (file-based), TanStack Query, shadcn/ui, Tailwind CSS, React Flow (`@xyflow/react`)
- **Backend:** Python 3.12+ / FastAPI. New routes: `developer_oauth.py`, `passkeys.py`. New middleware: audit logger. Alembic migrations for `developer_oauth_identities`, `developer_credentials`, `email_verified` column.
- **Dependencies:** Dashboard: `@xyflow/react`, `@pqdb/client` (workspace link). Backend: `py-webauthn` via `uv add`.
- **E2E:** Playwright with virtual authenticator for WebAuthn testing. Mock OAuth provider for OAuth testing.

## Success Metrics

- **SM-1:** Dashboard E2E: login → create project → browse schema → view data → decrypt → re-lock
- **SM-2:** OAuth E2E: sign in with Google → developer linked → Dashboard access
- **SM-3:** Passkey E2E: register → sign out → sign in with passkey → Dashboard access
- **SM-4:** Schema visualizer renders correct ERD with sensitivity badges
- **SM-5:** Encryption key never leaves browser memory; never appears in network requests
- **SM-6:** All 13 stories have passing tests in CI
- **SM-7:** TypeScript Dashboard compiles with strict mode, zero type errors
- **SM-8:** Backend passes mypy strict type checking

## Open Questions

- **OQ-1:** Should the Dashboard use the `@pqdb/client` SDK directly (import as workspace dependency) or implement a thin HTTP wrapper? Using the SDK directly gives decryption for free and ensures parity with developer apps.
- **OQ-2:** For the query playground, should we support raw SQL mode in addition to the query builder? Security concern: raw SQL could expose implementation details. Current design: query builder only.
- **OQ-3:** Should the audit log be opt-in (off by default) or always-on? Always-on provides immediate value but adds write overhead to every request. Current design: always-on with minimal fields.
