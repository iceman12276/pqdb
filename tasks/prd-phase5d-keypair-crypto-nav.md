# Phase 5d — Per-Developer ML-KEM Keypair Crypto + Dashboard Navigation Fix

## Context

Three related issues surfaced during the full MCP feature walkthrough in the previous session:

1. **Bug 5 (MCP encryption)**: `pqdb_create_project` via the MCP server returns projects with `wrapped_encryption_key=null`. The MCP cannot wrap an encryption key because the existing wrapping flow (`deriveWrappingKey(password, email)` via PBKDF2) requires the developer's password — which the MCP OAuth flow does not have.
2. **OAuth wrapping latent bug**: The same constraint breaks dashboard users who signed up via Google OAuth (passwordless). They cannot create encrypted projects because there's no password to derive the wrapping key from.
3. **Bug 6 (navigation)**: Once a user is inside a project in the dashboard (`/projects/{id}/*`), there's no visible way to navigate back to the projects list. The sidebar links stay within the current project, the Account popover only has "Log out", the "Select project" dropdown only switches between projects, and the `pqdb` logo in the sidebar is a plain `<span>`, not a link.

This PRD addresses all three in one phase because the first two share the same root cause (password-bound wrapping) and the third is a small, orthogonal dashboard fix that can ride along.

**User decisions** (from AskUserQuestion round + post-approval clarifications):
- Crypto design: **Per-developer ML-KEM keypair (zero-knowledge)** — see diagram in PRD.
- Navigation fix scope: **Comprehensive** — clickable logo + "All Projects" in dropdown + breadcrumb link.
- Migration strategy: **Hard cutover**. `envelope-crypto.ts` is deleted as part of US-006. Any pre-existing PBKDF2-wrapped projects (the demo "TaskFlow App" in local dev) will lose the ability to decrypt searchable/private columns. This is acceptable per pre-production data policy — no paying customers, demo data is disposable.
- US-009 placement: **Standalone in Wave 1**. Free parallelism, small focused PR, no coupling to the crypto stories.
- US-005 sizing: **Split into US-005a (keypair context + happy path) and US-005b (recovery + regenerate modal)**. Keeps each story within agent context window limits and lets US-006/US-007 start earlier (they only need US-005a).

---

# PRD: Phase 5d — Per-Developer ML-KEM Keypair Crypto + Navigation

## Introduction

pqdb is a zero-knowledge database platform that encrypts sensitive columns client-side using ML-KEM-768 before transmission. The server never holds decryption keys. Today, **the wrapping key for project encryption keys is derived from the developer's password via PBKDF2**. This breaks for two personas:

- **MCP server users**: Dev JWT authentication, no password available.
- **OAuth dashboard users**: Signed up via Google, no password available.

This PRD replaces the password-derived wrapping with a per-developer ML-KEM-768 keypair. Each developer gets a keypair at signup: the **public key is stored on the backend**, the **private key stays on the client** (IndexedDB for the dashboard, `PQDB_PRIVATE_KEY` env var for the MCP). Project encryption keys are produced via `encapsulate(dev_public_key)`, which returns `(ciphertext, shared_secret)`. The ciphertext is stored on the backend as `projects.wrapped_encryption_key`. The shared_secret becomes the project encryption key; the client recovers it via `decapsulate(ciphertext, dev_private_key)`.

This preserves the zero-knowledge property (the backend never sees the shared_secret) while supporting any authentication method (password, OAuth, MCP dev JWT).

A secondary concern: the dashboard has no navigation path back to the projects list once a user enters a project. This PRD also addresses that with a comprehensive fix (clickable logo + "All Projects" in the project switcher dropdown + clickable breadcrumb).

## Goals

1. **G-1**: Password-less project encryption works for OAuth dashboard users and MCP server users, with zero-knowledge preserved (backend cannot decrypt even if fully compromised — it would need the client-held private key).
2. **G-2**: Existing password-login users transition cleanly: they get a new ML-KEM keypair on next login, and any projects created before this change continue to work with the old PBKDF2 flow during a deprecation window.
3. **G-3**: The dashboard provides at least three independent paths to navigate from a project view back to the projects list (logo, dropdown, breadcrumb) so users find whichever they look for first.
4. **G-4**: All encryption operations use primitives already exported from `@pqdb/client` — no reinventing crypto in the MCP server or the dashboard.

## User Stories

### US-001: Export ML-KEM primitives from the SDK

**Description**: As a developer consuming `@pqdb/client`, I want `generateKeyPair`, `encapsulate`, and `decapsulate` to be exported from the package root so that the dashboard, MCP server, and any future client can use them without reaching into internal paths.

**Dependencies**: None

**Acceptance Criteria**:
- [ ] Test: write a failing unit test that imports `generateKeyPair`, `encapsulate`, `decapsulate` from `"@pqdb/client"` and verifies a full round-trip (generate → encapsulate → decapsulate) produces matching shared secrets.
- [ ] `sdk/src/index.ts` adds the three named exports and their TypeScript types (`KeyPair`, `EncapsulationResult`).
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.
- [ ] No functional change to existing exports; `sdk/dist/index.d.ts` additions are purely additive.

### US-002: Backend migration — add `ml_kem_public_key` column to developers

**Description**: As the backend, I want to store each developer's ML-KEM-768 public key so that I can return it to clients who need to verify/use it on project-scoped operations.

**Dependencies**: None

**Acceptance Criteria**:
- [ ] New alembic migration `011_add_ml_kem_public_key_to_developers.py` adds `ml_kem_public_key BYTEA NULLABLE` to the `developers` table.
- [ ] `backend/src/pqdb_api/models/developer.py` exposes the column as `ml_kem_public_key: Mapped[bytes | None]`.
- [ ] Integration test: migration applies cleanly, column is nullable (existing developers have `NULL`), migration is reversible.
- [ ] Unit tests pass, CI passes, typecheck (mypy strict) passes, production build succeeds.

### US-003: Backend signup endpoint accepts and stores `ml_kem_public_key`

**Description**: As a developer signing up, I want the signup endpoint to accept my ML-KEM-768 public key (generated client-side) and persist it on my developer record so that future project-creation calls can use it for wrapping.

**Dependencies**: US-002

**Acceptance Criteria**:
- [ ] `POST /v1/auth/signup` accepts an optional `ml_kem_public_key: str` field (base64-encoded) in the request body.
- [ ] On successful signup, the public key is stored in `developers.ml_kem_public_key` (decoded to bytes).
- [ ] The response shape remains `{access_token, refresh_token, token_type}` — no new field (the client already has the key).
- [ ] A new endpoint `GET /v1/auth/me/public-key` returns `{public_key: str}` (base64) for logged-in developers, used when MCP or any client needs to look up the key later.
- [ ] Integration test: sign up with a public key → verify it's stored → fetch via the new endpoint → matches bytes.
- [ ] Integration test: sign up WITHOUT a public key → stored as NULL → fetch returns `{public_key: null}`.
- [ ] Unit tests pass, CI passes, typecheck (mypy strict) passes.

### US-004: Dashboard signup flow generates and persists the keypair

**Description**: As a dashboard user signing up, I want the dashboard to generate my ML-KEM-768 keypair, save the private key to IndexedDB, upload the public key to the server, and offer a recovery file download so that I can restore my key on a different device or in the MCP server.

**Dependencies**: US-001, US-003

**Acceptance Criteria**:
- [ ] `dashboard/src/routes/signup.tsx` calls `generateKeyPair()` before submitting the form.
- [ ] The private key is stored in IndexedDB under a key bound to the developer id (e.g., `pqdb:keypair:{developer_id}`).
- [ ] The public key is sent in the signup POST as `ml_kem_public_key` (base64).
- [ ] On success, a modal appears with a **Download recovery file** button. The file is `pqdb-recovery-{email}.json` containing `{developer_id, email, public_key, private_key}` (all base64).
- [ ] Users cannot dismiss the modal without either downloading the recovery file or explicitly confirming "I understand — I will not be able to decrypt my data if I lose this key."
- [ ] Unit test: component generates a keypair on submit, mocks IndexedDB write, verifies the POST body contains a base64 public key.
- [ ] E2E test (Playwright): signup happy path downloads a parseable recovery file with both keys.
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.
- [ ] Verify in browser.

### US-005a: Dashboard keypair context — load from IndexedDB (happy path only)

**Description**: As a dashboard user logging back in on a device that already has my keypair, I want the dashboard to load my private key from IndexedDB automatically and expose it via a React context so that downstream components (Create Project, project load) can use it without password prompts.

**Dependencies**: US-004

**Acceptance Criteria**:
- [ ] New `dashboard/src/lib/keypair-context.tsx` replaces `envelope-key-context.tsx` and exposes `useKeypair()` → `{publicKey, privateKey, loaded, error}`.
- [ ] Happy path: context loads keypair from IndexedDB on login.
- [ ] Missing path: sets `error='missing'` but does NOT render a modal yet (US-005b handles that). Shows a placeholder banner "Encryption key not loaded. Keypair recovery coming soon."
- [ ] All existing consumers of `envelope-key-context` are migrated to `useKeypair()`.
- [ ] Unit test: context loads from IndexedDB mock — happy path returns `{loaded: true, publicKey, privateKey}`, empty IndexedDB returns `{loaded: true, error: 'missing'}`.
- [ ] E2E test: existing happy path still works end-to-end.
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.
- [ ] Verify in browser.

### US-005b: Dashboard recovery modal — upload recovery file or regenerate keypair

**Description**: As a dashboard user logging back in on a new device (or after clearing storage, or after OAuth signup), I want a modal that lets me either upload my recovery file to restore my keypair, or generate a new keypair (with a warning about old projects becoming unrecoverable).

**Dependencies**: US-005a

**Acceptance Criteria**:
- [ ] New `dashboard/src/components/recover-keypair-modal.tsx` renders when `keypair-context` reports `error='missing'`.
- [ ] Modal shows two options: **Upload recovery file** and **Generate new keypair**.
- [ ] Upload flow: file input → parse JSON → validate `public_key` matches `GET /v1/auth/me/public-key` → store private key in IndexedDB via `keypair-store.ts` → reload `keypair-context`.
- [ ] Upload flow rejects mismatched public key with: "This recovery file does not match your account."
- [ ] Regenerate flow: call `generateKeyPair()` → PUT new public key to new endpoint `PUT /v1/auth/me/public-key` → clear IndexedDB → store new keypair → reload context.
- [ ] Regenerate flow shows red warning: "All projects created before this moment will become unrecoverable. This cannot be undone." with an **I understand** checkbox required before proceeding.
- [ ] Backend: new `PUT /v1/auth/me/public-key` endpoint (auth required) for key rotation.
- [ ] Backend unit test: PUT endpoint requires auth, updates the column, returns 200.
- [ ] Frontend unit test: modal renders on `error='missing'`, upload happy path, upload signature mismatch, regenerate happy path.
- [ ] E2E test: log out → clear IndexedDB → log back in → modal → upload valid recovery file → projects decrypt.
- [ ] E2E test: regenerate → old projects show unrecoverable banner.
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.
- [ ] Verify in browser.

### US-006: Dashboard Create Project uses ML-KEM encapsulate

**Description**: As a dashboard user creating a project, I want the project encryption key to be produced via `encapsulate(my_public_key)` so that I never have to enter a password and the backend never sees the plaintext key.

**Dependencies**: US-001, US-005a

**Acceptance Criteria**:
- [ ] `dashboard/src/components/create-project-dialog.tsx` no longer calls `deriveWrappingKey` or `wrapKey`. It calls `encapsulate(publicKey)` to get `{ciphertext, sharedSecret}`, sends `ciphertext` (base64) as `wrapped_encryption_key` in the POST /v1/projects body, and stores `sharedSecret` as the project encryption key in the new keypair context (or per-session storage).
- [ ] `dashboard/src/lib/projects.ts createProject()` signature unchanged (it still takes a base64 `wrappedEncryptionKey` string).
- [ ] After successful creation, the dialog closes and navigates to the new project's overview. The per-session encryption key (sharedSecret) is available for subsequent row operations.
- [ ] Unit test: dialog generates wrapping via `encapsulate` (mocked), POSTs correct body shape, stores sharedSecret.
- [ ] E2E test: create a project, create a table with a searchable column, insert a row, query it back — verify the row decrypts to the original plaintext.
- [ ] Unit tests pass, CI passes, typecheck passes.
- [ ] Verify in browser.

### US-007: Dashboard project-load flow unwraps via decapsulate

**Description**: As a dashboard user opening a project I created earlier, I want the dashboard to decapsulate the stored ciphertext with my private key to recover the project encryption key, transparently, without prompting me for a password.

**Dependencies**: US-001, US-005a

**Acceptance Criteria**:
- [ ] When navigating to `/projects/{id}`, the dashboard fetches the project detail, reads `wrapped_encryption_key`, calls `decapsulate(ciphertext, privateKey)` to recover the shared secret, and stores it in the keypair context under the project id.
- [ ] Row operations (select, insert, update, delete) on sensitive columns use this recovered shared secret as the project encryption key.
- [ ] If the project has `wrapped_encryption_key=null` (legacy or broken project), the dashboard shows an informational banner: "This project has no encryption key configured. Sensitive columns will be unavailable."
- [ ] If `decapsulate` throws (private key mismatch, corrupted ciphertext), show "Could not decrypt this project. You may need to upload a different recovery file."
- [ ] Unit test: keypair context decrypts a project, stores the recovered secret, retrieval returns the same secret for the same project id.
- [ ] E2E test: create a project, close the tab, reopen it → rows in searchable columns decrypt successfully.
- [ ] Unit tests pass, CI passes, typecheck passes.
- [ ] Verify in browser.

### US-008: MCP server supports PQDB_PRIVATE_KEY + uses encapsulate in create_project

**Description**: As a user running the MCP server, I want to pass my ML-KEM private key via `PQDB_PRIVATE_KEY` so that the MCP can create projects with proper encryption and perform CRUD on searchable/private columns.

**Dependencies**: US-001, US-003 (needs the public-key lookup endpoint)

**Acceptance Criteria**:
- [ ] `mcp/src/config.ts` reads an optional `PQDB_PRIVATE_KEY` env var (base64-encoded).
- [ ] `mcp/src/auth-state.ts` exposes `setCurrentPrivateKey(key: Uint8Array)` and `getCurrentPrivateKey()`.
- [ ] `pqdb_create_project` tool, when a private key is available:
  - Fetches the developer's public key via `GET /v1/auth/me/public-key`
  - Calls `encapsulate(publicKey)` to get `(ciphertext, sharedSecret)`
  - Sends `wrapped_encryption_key: base64(ciphertext)` in the POST body
  - Stores `sharedSecret` as the active project encryption key (same mechanism `PQDB_ENCRYPTION_KEY` uses today)
  - Returns the project in the tool response (no raw key leaked)
- [ ] `pqdb_create_project` tool, when no private key is available: creates a plaintext-only project (same as today) and emits a warning in the tool result: "No PQDB_PRIVATE_KEY set — project created without encryption. Set PQDB_PRIVATE_KEY to enable searchable/private columns."
- [ ] `pqdb_select_project` tool fetches the project, decapsulates its `wrapped_encryption_key` with the configured private key, and makes the recovered shared secret available for subsequent CRUD operations.
- [ ] Unit test: mocked `encapsulate`/`decapsulate`, verify pqdb_create_project sends the correct body and stores the shared secret.
- [ ] Integration test: boot the real MCP server with a private key, create a project, run a round-trip insert/query on a searchable column.
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.

### US-009: Dashboard navigation back to projects list — comprehensive fix

**Description**: As a dashboard user inside a project, I want at least three ways to navigate back to the projects list (clickable logo, "All Projects" in the project switcher dropdown, clickable breadcrumb) so that I can always find my way back regardless of which UI convention I'm used to.

**Dependencies**: None (fully independent of the crypto stories)

**Acceptance Criteria**:
- [ ] `dashboard/src/components/sidebar-nav.tsx` wraps the `pqdb` logo `<span>` in a `<Link to="/projects">`. Hovering shows a cursor pointer; clicking navigates to the projects list.
- [ ] `dashboard/src/components/project-selector.tsx` (or wherever the "Select project" dropdown is rendered) adds "All Projects" as the first item, separated from the project list by a divider. Clicking navigates to `/projects`.
- [ ] The top breadcrumb in `dashboard/src/components/top-bar.tsx` changes from `Account / Select project / main` to `Account / All projects / TaskFlow App / main` when inside a project, where "All projects" is a clickable link.
- [ ] All three navigation paths preserve the current theme, session, and sidebar scroll position.
- [ ] Unit test: each of the three components renders the expected link/element.
- [ ] E2E test: from `/projects/{id}/schema`, click logo → lands on `/projects`; click "All Projects" in dropdown → lands on `/projects`; click breadcrumb "All projects" → lands on `/projects`.
- [ ] Unit tests pass, CI passes, typecheck passes, production build succeeds.
- [ ] Verify in browser.

## Functional Requirements

- **FR-1**: The system must generate a fresh ML-KEM-768 keypair for every developer at signup.
- **FR-2**: The system must store only the public key on the backend; the private key must never leave the client.
- **FR-3**: The system must use `encapsulate(developer_public_key)` to generate project encryption keys. The resulting ciphertext is stored as `projects.wrapped_encryption_key`; the resulting shared secret is used as the project encryption key in memory.
- **FR-4**: The system must use `decapsulate(ciphertext, developer_private_key)` to recover the project encryption key when a client opens a project.
- **FR-5**: The dashboard must offer a recovery file download after signup that contains both keys as base64, so users can port their keypair to the MCP server or a different device.
- **FR-6**: The dashboard must prompt users to upload a recovery file if the private key is not in IndexedDB on login.
- **FR-7**: The MCP server must support `PQDB_PRIVATE_KEY` as an optional env var. If set, `pqdb_create_project` uses ML-KEM encapsulate; if not, it creates plaintext-only projects with a warning.
- **FR-8**: The dashboard must provide at least three independent navigation paths from a project view back to the projects list: clickable logo, "All Projects" in the project switcher dropdown, and a clickable breadcrumb segment.
- **FR-9**: The existing PBKDF2-based wrapping code path is removed from the dashboard. Any projects that previously used PBKDF2 wrapping continue to display but sensitive columns show as `[legacy encryption — re-create this project]` (no automatic re-encryption in this PRD).

## Non-Goals

- **NG-1**: Automatic migration of existing PBKDF2-wrapped projects to the new ML-KEM flow. (A separate migration tool is out of scope.)
- **NG-2**: Multi-device keypair sync across browsers. Users are expected to manually transfer the recovery file.
- **NG-3**: WebAuthn/passkey-based key protection. Out of scope for this phase; considered as a future enhancement on top of the ML-KEM keypair.
- **NG-4**: Server-side key escrow. The user explicitly rejected this in favor of the zero-knowledge approach.
- **NG-5**: Changing how row-level encryption (ML-KEM per-row crypto) works. This PRD only changes how the project encryption key itself is wrapped.

## Design Considerations

### Zero-knowledge property preserved

The shared secret returned by `encapsulate(public_key)` is random per call — the backend computing the encapsulate (or the client computing it itself) never persists the shared secret, only the ciphertext. Recovering the shared secret from the ciphertext requires the private key, which the backend never sees.

**Design choice: who calls `encapsulate`?** Both options are cryptographically equivalent:
- **Option A — Client calls encapsulate**: simpler architecture (backend is a dumb blob store), no Python ML-KEM dependency on the backend.
- **Option B — Backend calls encapsulate**: simpler client flow (client only needs decapsulate), but requires the backend to have liboqs bindings.

**Chosen**: **Option A (client calls encapsulate)**. Rationale: pqdb already uses liboqs on the backend for some operations, but adding a new cryptographic code path on the backend increases its attack surface. A purely blob-store backend for this flow is cleaner and aligns with the zero-knowledge principle.

### Recovery file format

```json
{
  "version": 1,
  "developer_id": "uuid-here",
  "email": "user@example.com",
  "public_key": "base64url...",
  "private_key": "base64url...",
  "created_at": "2026-04-09T21:00:00Z",
  "warning": "Do not share this file. It contains your private key. Losing it means permanent loss of access to your encrypted data."
}
```

### Dashboard navigation (Bug 6)

Three complementary paths:
1. **Logo**: `<Link to="/projects"><span class="text-lg font-semibold">pqdb</span></Link>` — follows Supabase/Linear/GitHub conventions.
2. **Dropdown**: "All Projects" as the first item in the Select project popover, separated by a `<Separator />` from the project list.
3. **Breadcrumb**: Replace `Account / Select project / main` with `Account / All projects / {ProjectName} / {BranchName}`. The `All projects` and `{ProjectName}` segments become clickable links.

## Technical Considerations

### SDK changes (US-001)

The ML-KEM primitives already exist in `sdk/src/crypto/pqc.ts`. Only `sdk/src/index.ts` needs to add:

```typescript
export { generateKeyPair, encapsulate, decapsulate } from "./crypto/pqc.js";
export type { EncapsulationResult } from "./crypto/pqc.js";
```

### Backend migration (US-002, US-003)

Follow the pattern established by migration `007_add_wrapped_encryption_key.py`. Add a new endpoint `GET /v1/auth/me/public-key` to retrieve the public key after signup.

### Dashboard keypair context (US-005a / US-005b)

Replace `envelope-key-context.tsx` with `keypair-context.tsx`. Keep the same React API surface where possible so other components don't need deep refactors — expose `useKeypair()` that returns `{publicKey, privateKey, loaded}`.

### IndexedDB key storage

Use the `idb` package (if not already installed, add it). Store under the database `pqdb` with store `keypairs`, keyed by developer id. On logout, clear only the session (not the IndexedDB) so the keypair survives to the next login.

### MCP `PQDB_PRIVATE_KEY` parsing

Accept base64 or base64url. Decode to `Uint8Array`. Verify the length matches the expected ML-KEM-768 private key size (~2400 bytes). Fail fast on mismatch with a clear error message.

## Success Metrics

- **SM-1**: 100% of new projects created via the dashboard (including OAuth users) have `wrapped_encryption_key != null`.
- **SM-2**: 100% of new projects created via the MCP server with `PQDB_PRIVATE_KEY` set have `wrapped_encryption_key != null`.
- **SM-3**: Round-trip test passes: signup → create project → insert encrypted row → log out → log in (upload recovery file) → query row → decrypted plaintext matches.
- **SM-4**: E2E test passes: from `/projects/{id}/schema`, all three navigation paths (logo, dropdown, breadcrumb) land on `/projects`.
- **SM-5**: Post-merge, manual verification: a test account with both password login and Google OAuth login can create encrypted projects without any "wrapping key not available" errors.

## Open Questions

- **OQ-1**: Should the backend `GET /v1/auth/me/public-key` endpoint return `404` or `{public_key: null}` for developers without a public key? (Recommendation: `{public_key: null}` — avoids client-side branching on error codes.)
- **OQ-2**: What happens if a user's IndexedDB is wiped but they also lost their recovery file? (Recommendation: they can "Generate new keypair" with a red warning that old projects become unrecoverable. Detailed recovery UX is deferred.)
- **OQ-3**: Is the recovery-file download modal blocking enough to prevent users from losing data accidentally? (Recommendation: require an explicit "I understand" checkbox before allowing dismissal without download. Final wording subject to review.)

---

# Dependency Graph (for agentic workflow)

```
US-001 (SDK export) ───┬───→ US-004 (dashboard signup)
                       ├───→ US-006 (dashboard create project)
                       ├───→ US-007 (dashboard project load)
                       └───→ US-008 (MCP server)

US-002 (migration) ───→ US-003 (signup endpoint) ───→ US-004

US-004 (dashboard signup) ───→ US-005a (keypair context) ───┬──→ US-005b (recovery modal)
                                                             ├──→ US-006
                                                             └──→ US-007

US-009 (nav fix) ── fully independent, runs in parallel with everything
```

**Parallel execution groups**:
- **Wave 1** (no dependencies): US-001, US-002, US-009 — three agents in parallel
- **Wave 2** (after wave 1): US-003 (needs US-002)
- **Wave 3** (after wave 2): US-004 (needs US-001 + US-003)
- **Wave 4** (after wave 3): US-005a (needs US-004), US-008 (needs US-001 + US-003, parallel with US-005a)
- **Wave 5** (after wave 4): US-005b, US-006, US-007 (all three need US-005a, run in parallel)

---

# Critical Files to Modify

| User Story | File | Change |
|-----------|------|--------|
| US-001 | `sdk/src/index.ts` | Add named exports for ML-KEM primitives |
| US-001 | `sdk/tests/unit/pqc-export.test.ts` | **NEW** — verify exports work end-to-end |
| US-002 | `backend/alembic/versions/011_add_ml_kem_public_key_to_developers.py` | **NEW** migration |
| US-002 | `backend/src/pqdb_api/models/developer.py` | Add column |
| US-003 | `backend/src/pqdb_api/routes/auth.py` | Accept public_key in signup, add `/v1/auth/me/public-key` |
| US-003 | `backend/tests/integration/test_auth_public_key.py` | **NEW** |
| US-004 | `dashboard/src/routes/signup.tsx` | Generate keypair, upload public key, download recovery file |
| US-004 | `dashboard/src/lib/keypair-store.ts` | **NEW** — IndexedDB wrapper |
| US-004 | `dashboard/src/components/recovery-file-modal.tsx` | **NEW** |
| US-005a | `dashboard/src/lib/keypair-context.tsx` | **NEW** — replaces `envelope-key-context.tsx` (happy path only) |
| US-005b | `dashboard/src/components/recover-keypair-modal.tsx` | **NEW** |
| US-005b | `backend/src/pqdb_api/routes/auth.py` | Add `PUT /v1/auth/me/public-key` endpoint |
| US-006 | `dashboard/src/components/create-project-dialog.tsx` | Use `encapsulate` instead of `wrapKey` |
| US-006 | `dashboard/src/lib/envelope-crypto.ts` | **DELETE** (dead code after this change) |
| US-007 | `dashboard/src/routes/projects.$projectId.tsx` | Call `decapsulate` on project load |
| US-008 | `mcp/src/config.ts` | Read `PQDB_PRIVATE_KEY` |
| US-008 | `mcp/src/auth-state.ts` | Add `setCurrentPrivateKey` |
| US-008 | `mcp/src/project-tools.ts` | `pqdb_create_project` + `pqdb_select_project` use encapsulate/decapsulate |
| US-009 | `dashboard/src/components/sidebar-nav.tsx` | Wrap logo in `<Link>` |
| US-009 | `dashboard/src/components/project-selector.tsx` | Add "All Projects" item |
| US-009 | `dashboard/src/components/top-bar.tsx` | Clickable breadcrumb |

---

# Verification (End-to-End)

## Manual verification after all stories merge

1. **Password signup path**:
   - Create a new account with email + password
   - Verify recovery file downloads on signup
   - Create a project named "Test Password"
   - Create a table with a `searchable` email column
   - Insert a row with email="test@example.com"
   - Query the row by email — verify it decrypts
   - Log out, log in, query the row again — verify it still decrypts

2. **OAuth signup path**:
   - Create a new account with Google OAuth
   - Verify recovery file downloads on signup
   - Repeat the encrypted round-trip above
   - Verify `wrapped_encryption_key` is populated in the project (not null)

3. **Recovery file path**:
   - Clear the browser's IndexedDB for `pqdb`
   - Log in again
   - Verify the "Recover your encryption key" modal appears
   - Upload the recovery file → verify projects still decrypt

4. **MCP path**:
   - Start the MCP server with `PQDB_PRIVATE_KEY=<base64 from recovery file>`
   - Connect via `/mcp` in Claude Code
   - Run `pqdb_create_project name="MCP Test"`
   - Verify the returned project has `wrapped_encryption_key != null`
   - Run `pqdb_select_project project_id=<id>`
   - Run `pqdb_insert_rows` on a table with a searchable column
   - Run `pqdb_query_rows` — verify it decrypts

5. **Navigation (Bug 6)**:
   - Open a project (navigate to `/projects/{id}/schema`)
   - Click the `pqdb` logo in the sidebar → verify you land on `/projects`
   - Navigate back into the project, click the "Select project" dropdown → verify "All Projects" is the first item, clicking it lands on `/projects`
   - Navigate back into the project, click the "All projects" breadcrumb segment → verify you land on `/projects`

## Automated verification

- `cd sdk && npm test` — all tests pass including new US-001 SDK export test
- `cd backend && uv run pytest` — all tests pass including new auth public key integration tests
- `cd dashboard && npm test` — all tests pass including new keypair context and crypto round-trip tests
- `cd mcp && npm test` — all tests pass including new MCP encrypted create_project test
- CI pipeline green (all required checks: backend-tests, sdk-tests, security-gate, E2E Tests, Dashboard E2E Tests)
