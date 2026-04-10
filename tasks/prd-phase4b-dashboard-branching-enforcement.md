# PRD: Phase 4b — Dashboard Improvements, Database Branching & Enforcement

## Context

Phase 4a hardened pqdb with PQC auth tokens, PQC TLS, and scoped API keys. However, two enforcement gaps remain: paused projects still accept API requests (pause is metadata-only), and scoped keys can perform DDL operations (create/drop tables) without permission checks. Phase 4b closes these gaps, adds database branching for development workflows, and expands the dashboard with database introspection pages and ERD improvements.

## Introduction

Phase 4b delivers three pillars:
1. **Enforcement hardening** — Pause enforcement in API middleware + block DDL for scoped keys
2. **Database branching** — Clone project databases for staging/testing, promote branches to main
3. **Dashboard introspection** — Browse functions, triggers, enums, extensions, indexes, publications + ERD improvements

## Goals

1. API key middleware rejects requests to paused projects with 403
2. Scoped API keys cannot perform DDL operations (create/drop tables, add/drop columns)
3. Developers can create, list, delete, promote, rebase, and reset database branches
4. Dashboard shows paused state and branch management UI
5. Dashboard displays database objects (functions, triggers, enums, extensions, indexes, publications)
6. ERD visualization improved with auto-layout, FK relationship lines, SQL copy, and schema selector
7. Zero breaking changes to existing SDK/MCP/dashboard functionality

## User Stories

### US-088: Pause enforcement in API key middleware

**Description:** As the system, I want to reject API requests to paused projects so that pausing a project actually blocks data access.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `get_project_context()` in `middleware/api_key.py` loads `project.status` and rejects with 403 if status is `"paused"`
- [ ] Error response: `{"error": {"code": "PROJECT_PAUSED", "message": "Project is paused. Restore it to resume access."}}`
- [ ] Developer JWT + `x-project-id` path also checks project status (not just API key path)
- [ ] Pause/restore management endpoints (`POST /v1/projects/{id}/pause` and `/restore`) still work when project is paused (they use developer JWT, not API key middleware)
- [ ] Integration test: create project, pause it, verify CRUD request returns 403
- [ ] Integration test: restore project, verify CRUD request succeeds again
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-089: Block DDL for scoped API keys

**Description:** As the system, I want scoped API keys to be blocked from DDL operations so they can only perform CRUD on allowed tables.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] DDL endpoints check `ProjectContext.key_role` — if `"scoped"`, return 403 with clear error
- [ ] Blocked endpoints: `POST /v1/db/tables` (create table), `POST /v1/db/tables/{name}/columns` (add column), `DELETE /v1/db/tables/{name}/columns/{name}` (drop column)
- [ ] Read-only introspection still allowed for scoped keys: `GET /v1/db/tables`, `GET /v1/db/tables/{name}`, `GET /v1/db/introspect`, `GET /v1/db/introspect/{name}`
- [ ] Anon and service keys unaffected (full DDL access)
- [ ] Error response: `{"error": {"code": "SCOPED_KEY_DDL_DENIED", "message": "Scoped API keys cannot perform schema operations. Use an anon or service key."}}`
- [ ] Integration test: scoped key create table → 403
- [ ] Integration test: scoped key add column → 403
- [ ] Integration test: scoped key drop column → 403
- [ ] Integration test: scoped key list tables → 200 (allowed)
- [ ] Integration test: service key create table → 200 (allowed)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-090: Dashboard pause state UI

**Description:** As a developer using the dashboard, I want to see when a project is paused and be able to pause/restore it from the UI.

**Dependencies:** US-088

**Acceptance Criteria:**
- [ ] Project Overview page shows a prominent warning banner when project is paused
- [ ] Paused banner text: "This project is paused. Data operations are blocked. Restore to resume."
- [ ] "Restore" button in the banner calls `POST /v1/projects/{id}/restore`
- [ ] Project Settings page has Pause/Restore toggle or buttons
- [ ] Pause button shows confirmation dialog: "Pausing will block all API requests. Continue?"
- [ ] Navigation items (Table Editor, SQL, Schema) show disabled state when project is paused
- [ ] Project card in project list shows "Paused" badge (already partially implemented via status variants)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser: pause project → see banner → restore → banner disappears

### US-091: Branch metadata schema and model

**Description:** As the system, I need a database table to track branch metadata so branches can be managed.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Alembic migration creates `database_branches` table in platform DB with columns: `id` (UUID PK), `project_id` (UUID FK → projects), `name` (varchar(63)), `database_name` (varchar(255) UNIQUE), `parent_database` (varchar(255)), `status` (varchar(50) default 'active'), `created_at` (timestamptz)
- [ ] Unique constraint on `(project_id, name)` — one branch name per project
- [ ] Index on `project_id` for fast listing
- [ ] SQLAlchemy model `DatabaseBranch` in `models/branch.py` with Mapped columns
- [ ] Model registered in `models/__init__.py`
- [ ] Branch name validation: `^[a-z][a-z0-9_-]{0,62}$`
- [ ] Reserved names blocked: `main`, `master`, `prod`, `production`
- [ ] Unit test: model accepts valid branch data
- [ ] Unit test: branch name validation rejects invalid names and reserved words
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes

### US-092: Branch create, list, and delete API

**Description:** As a developer, I want to create database branches for testing and staging so I can experiment without affecting production data.

**Dependencies:** US-091

**Acceptance Criteria:**
- [ ] `POST /v1/projects/{id}/branches` — creates branch via `CREATE DATABASE branch_db TEMPLATE main_db`
- [ ] Request body: `{"name": "staging"}`
- [ ] Response 201: `{"id": "...", "name": "staging", "database_name": "pqdb_branch_...", "status": "active", "created_at": "..."}`
- [ ] Branch database name format: `pqdb_branch_{branch_uuid_hex[:12]}`
- [ ] Maximum 5 branches per project (409 if exceeded)
- [ ] Branch creation terminates active connections to main DB (required by `TEMPLATE`) — documented in response
- [ ] Branch reuses the project's existing Postgres user (same `GRANT CONNECT`)
- [ ] Branch shares the project's HMAC key from Vault (no separate key needed)
- [ ] `GET /v1/projects/{id}/branches` — lists all non-deleted branches
- [ ] `DELETE /v1/projects/{id}/branches/{name}` — drops branch database, evicts engine from cache, deletes metadata row
- [ ] `x-branch` header support in `get_project_context`: when present, resolves branch's `database_name` instead of main
- [ ] All endpoints require developer JWT + project ownership
- [ ] Integration test: create branch, list shows it, access data via `x-branch` header, delete it
- [ ] Integration test: max 5 branches enforcement
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-093: Branch merge, rebase, and reset API

**Description:** As a developer, I want to promote a branch to main, or re-clone it from current main, so I can manage my development workflow.

**Dependencies:** US-092

**Acceptance Criteria:**
- [ ] `POST /v1/projects/{id}/branches/{name}/promote` — promotes branch to main
- [ ] Promote flow: terminate connections to old main + branch → evict both engines → update `Project.database_name` to branch DB → drop old main DB → delete branch metadata row
- [ ] Promote accepts optional `{"force": true}` to proceed despite active connections (default: reject with 409 + connection count)
- [ ] Promote response includes `stale_branches` array listing other branches that are now diverged from new main
- [ ] `POST /v1/projects/{id}/branches/{name}/rebase` — drops branch DB, re-clones from current main
- [ ] `POST /v1/projects/{id}/branches/{name}/reset` — alias for rebase (same handler)
- [ ] Status guards: operations rejected if branch status is not `active` (409 if `creating`, `merging`, `deleting`)
- [ ] Race condition protection: status set to `merging`/`creating` before operations begin
- [ ] Engine cache eviction via `dispose()` + deletion from `app.state.project_engines`
- [ ] Integration test: create branch, insert data, promote → main now has branch data
- [ ] Integration test: create branch, rebase → branch data reset to current main
- [ ] Integration test: promote with active connections and `force=false` → 409
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-094: MCP branching tools

**Description:** As an AI agent using the MCP server, I want branching tools so I can create staging environments and promote tested changes.

**Dependencies:** US-093

**Acceptance Criteria:**
- [ ] `pqdb_create_branch` — wraps `POST /v1/projects/{id}/branches`
- [ ] `pqdb_list_branches` — wraps `GET /v1/projects/{id}/branches`
- [ ] `pqdb_delete_branch` — wraps `DELETE /v1/projects/{id}/branches/{name}`
- [ ] `pqdb_merge_branch` — wraps `POST /v1/projects/{id}/branches/{name}/promote`
- [ ] `pqdb_rebase_branch` — wraps `POST /v1/projects/{id}/branches/{name}/rebase`
- [ ] `pqdb_reset_branch` — wraps `POST /v1/projects/{id}/branches/{name}/reset`
- [ ] All tools use developer JWT authentication (same as existing `pqdb_pause_project`)
- [ ] Tool definitions include clear descriptions and input schemas
- [ ] Existing `pqdb_query_rows`, `pqdb_insert_rows`, etc. support optional `branch` parameter (adds `x-branch` header)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds

### US-095: Dashboard branch management UI

**Description:** As a developer using the dashboard, I want to manage database branches visually.

**Dependencies:** US-093

**Acceptance Criteria:**
- [ ] Branch selector dropdown in the project layout header (between project name and nav)
- [ ] Dropdown shows "main" (default) plus all branches with status badges
- [ ] Selecting a branch adds `x-branch` header to all subsequent API requests
- [ ] "Create Branch" button opens dialog: name input + create button
- [ ] Branch management page at `/projects/{id}/branches` (new sidebar nav item)
- [ ] Management page lists all branches with: name, status, created date, actions (delete, promote, rebase)
- [ ] Promote button shows confirmation: "This will replace the main database with this branch. Other branches will become stale."
- [ ] Delete button shows confirmation: "This will permanently delete the branch database."
- [ ] Active branch indicator in sidebar when viewing a branch (not main)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser: create branch → select it → see data → promote → verify main updated

### US-096: Backend introspection endpoints for database objects

**Description:** As the system, I need endpoints that query Postgres system catalogs so the dashboard can display functions, triggers, enums, extensions, indexes, and publications.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/functions` — queries `pg_proc` + `pg_namespace`, returns `[{name, schema, args, return_type, language, source}]`
- [ ] `GET /v1/db/triggers` — queries `pg_trigger` + `pg_class`, returns `[{name, table, timing, events, function_name}]`
- [ ] `GET /v1/db/enums` — queries `pg_type` + `pg_enum`, returns `[{name, schema, values}]`
- [ ] `GET /v1/db/extensions` — queries `pg_extension`, returns `[{name, version, schema, comment}]`
- [ ] `GET /v1/db/indexes` — queries `pg_indexes` view, returns `[{name, table, columns, definition, unique, size_bytes}]`
- [ ] `GET /v1/db/publications` — queries `pg_publication` + `pg_publication_tables`, returns `[{name, tables, all_tables, insert, update, delete}]`
- [ ] All endpoints filter to non-system schemas (exclude `pg_catalog`, `information_schema`)
- [ ] All endpoints use `get_project_session` (API key required)
- [ ] Integration test: create extension, verify it appears in `/v1/db/extensions`
- [ ] Integration test: create function via SQL, verify it appears in `/v1/db/functions`
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-097: ERD improvements — auto-layout, FK lines, SQL copy, schema selector

**Description:** As a developer using the dashboard, I want an improved ERD with better layout, FK relationship visualization, and utility features.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] "Auto Layout" button arranges tables using a layered/dagre algorithm (minimize FK edge crossings)
- [ ] FK relationships rendered as animated edge lines between table nodes (source column → target column)
- [ ] FK edges show relationship label on hover (e.g., `posts.author_id → users.id`)
- [ ] "Copy as SQL" button generates `CREATE TABLE` DDL for all visible tables and copies to clipboard
- [ ] SQL includes column types, constraints, and foreign keys
- [ ] Schema selector dropdown (defaults to `public`) — queries `information_schema.schemata`, filters tables by selected schema
- [ ] Existing logical/physical view toggle preserved
- [ ] FK detection: query `information_schema.table_constraints` + `information_schema.key_column_usage` + `information_schema.constraint_column_usage`
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser: see FK lines, click auto-layout, switch schema, copy SQL

### US-098: Dashboard — Functions and Triggers browser pages

**Description:** As a developer using the dashboard, I want to browse database functions and triggers.

**Dependencies:** US-096

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/functions` — lists all user-defined functions from `GET /v1/db/functions`
- [ ] Function detail: name, arguments, return type, language (plpgsql/sql), source code viewer
- [ ] Source code displayed in a read-only code block with syntax highlighting
- [ ] New page at `/projects/{id}/triggers` — lists all triggers from `GET /v1/db/triggers`
- [ ] Trigger detail: name, associated table, timing (BEFORE/AFTER), events (INSERT/UPDATE/DELETE), trigger function
- [ ] Both pages accessible from sidebar navigation (new nav items with appropriate icons)
- [ ] Loading skeletons while data fetches
- [ ] Empty state when no functions/triggers exist
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-099: Dashboard — Enums and Extensions browser pages

**Description:** As a developer using the dashboard, I want to browse database enum types and installed extensions.

**Dependencies:** US-096

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/enums` — lists all enum types from `GET /v1/db/enums`
- [ ] Enum detail: name, schema, list of values displayed as badges
- [ ] New page at `/projects/{id}/extensions` — lists all extensions from `GET /v1/db/extensions`
- [ ] Extension detail: name, version, schema, description
- [ ] Both pages accessible from sidebar navigation
- [ ] Loading skeletons and empty states
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-100: Dashboard — Indexes and Publications browser pages

**Description:** As a developer using the dashboard, I want to browse database indexes and publications.

**Dependencies:** US-096

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/indexes` — lists all indexes from `GET /v1/db/indexes`
- [ ] Index detail: name, table, columns, type (btree/hash/gin/gist/hnsw/ivfflat), unique flag, size, full definition
- [ ] New page at `/projects/{id}/publications` — lists all publications from `GET /v1/db/publications`
- [ ] Publication detail: name, tables included, operations enabled (insert/update/delete)
- [ ] Both pages accessible from sidebar navigation
- [ ] Loading skeletons and empty states
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

## Functional Requirements

- **FR-1:** API requests to paused projects return 403 `PROJECT_PAUSED`
- **FR-2:** Scoped API keys cannot perform DDL operations (create/drop tables/columns)
- **FR-3:** Database branches are created via Postgres `CREATE DATABASE ... TEMPLATE`
- **FR-4:** Branch promote swaps the branch database to become the new main
- **FR-5:** Branch rebase/reset re-clones from current main
- **FR-6:** Maximum 5 branches per project
- **FR-7:** Branches share the project's HMAC key and Postgres user
- **FR-8:** `x-branch` header routes API requests to branch databases
- **FR-9:** Introspection endpoints query Postgres system catalogs for database objects
- **FR-10:** ERD auto-layout uses a graph layout algorithm to minimize edge crossings

## Non-Goals

- **Schema-diff merge** — No DDL diffing or conflict resolution for branches. Merge = promote (replace).
- **Security Advisor / Performance Advisor** — Deferred to Phase 5
- **Platform section** (Replication, Backups, Migrations, Wrappers, Webhooks) — Deferred to Phase 5
- **Branch-specific HMAC keys** — Branches share the project key. Separate keys would break blind index compatibility.
- **Automatic branch cleanup** — No TTL or auto-delete for stale branches
- **Write operations on introspection pages** — Functions, triggers, enums, extensions, indexes, publications pages are read-only. Developers use the SQL playground for DDL.

## Technical Considerations

### Branch Creation Requires Connection Termination

`CREATE DATABASE ... TEMPLATE` requires that no other sessions are connected to the template database. Branch creation will briefly terminate active connections to the main database. This is an inherent Postgres limitation.

**Mitigations:**
- `pool_pre_ping=True` on all engines ensures automatic reconnection on next request
- Branch creation response includes a warning about interrupted connections
- Document that branch creation is a brief disruptive operation

### Branch Promote Is Destructive

Promoting a branch drops the old main database. This is irreversible.

**Mitigations:**
- `force` parameter (default false) rejects promote if active connections exist
- Response includes `stale_branches` listing branches that now diverge from new main
- Dashboard shows confirmation dialog

### Engine Cache Management

Each database gets a pooled `AsyncEngine` cached in `app.state.project_engines`. Branch operations (delete, promote, rebase) must evict engines via `dispose()` + dict deletion to prevent connections to dropped databases.

### Sidebar Navigation Growth

Phase 4b adds up to 8 new nav items (branches, functions, triggers, enums, extensions, indexes, publications + improved schema). To manage this, group introspection items under a "Database" collapsible section in the sidebar.

### ERD Auto-Layout

Use `dagre` (MIT, ~15KB) for directed graph layout. It's the standard library for ReactFlow auto-layout and handles FK relationship edge routing well. Install via `npm install @dagrejs/dagre`.

### Introspection SQL Queries

All introspection endpoints execute raw SQL against project databases via the existing `AsyncSession`. Queries filter to user schemas (`NOT IN ('pg_catalog', 'information_schema', 'pg_toast')`) and exclude pqdb internal tables (prefix `_pqdb_`).

## Dependency Graph

```
Chain A (Enforcement):
  US-088 (pause middleware) → US-090 (dashboard pause UI)
  US-089 (DDL blocked for scoped) [standalone]

Chain B (Branching):
  US-091 (branch schema) → US-092 (create/list/delete) → US-093 (merge/rebase/reset) → US-094 (MCP tools)
                                                                                       → US-095 (dashboard branch UI)

Chain C (Dashboard Introspection):
  US-096 (introspection endpoints) → US-098 (functions + triggers pages)
                                   → US-099 (enums + extensions pages)
                                   → US-100 (indexes + publications pages)
  US-097 (ERD improvements) [standalone]
```

Five independent starting points: US-088, US-089, US-091, US-096, US-097

## Success Metrics

- Paused project returns 403 on CRUD request; 200 after restore
- Scoped key returns 403 on `POST /v1/db/tables`; service key returns 200
- Branch created via `CREATE DATABASE ... TEMPLATE` in under 5 seconds for typical project sizes
- Branch promote updates `Project.database_name` and subsequent requests route to new main
- All 6 introspection endpoints return structured data from Postgres system catalogs
- ERD shows FK relationship lines and supports auto-layout
- All existing functionality works unchanged

## Critical Files

### Backend — Modify
- `backend/src/pqdb_api/middleware/api_key.py` — pause check in `get_project_context`, `x-branch` resolution, `evict_engine` helper
- `backend/src/pqdb_api/routes/db.py` — DDL scoped key checks in create table, add/drop column endpoints
- `backend/src/pqdb_api/services/provisioner.py` — `make_branch_database_name()`, TEMPLATE/DROP/TERMINATE SQL helpers
- `backend/src/pqdb_api/app.py` — register branches router and introspection router
- `backend/src/pqdb_api/models/__init__.py` — add DatabaseBranch import

### Backend — Create
- `backend/alembic/versions/010_create_database_branches_table.py` — migration
- `backend/src/pqdb_api/models/branch.py` — DatabaseBranch model
- `backend/src/pqdb_api/services/branching.py` — branch operations service
- `backend/src/pqdb_api/routes/branches.py` — branch API endpoints
- `backend/src/pqdb_api/routes/introspection.py` — database object introspection endpoints

### Dashboard — Modify
- `dashboard/src/components/sidebar-nav.tsx` — add new nav items with collapsible Database section
- `dashboard/src/components/schema-page.tsx` — auto-layout, FK edges, SQL copy, schema selector
- `dashboard/src/components/erd-table-node.tsx` — FK indicator on columns
- `dashboard/src/components/project-card.tsx` — pause/restore action buttons

### Dashboard — Create
- `dashboard/src/routes/projects/$projectId/branches.tsx` — branch management page
- `dashboard/src/routes/projects/$projectId/functions.tsx` — functions browser
- `dashboard/src/routes/projects/$projectId/triggers.tsx` — triggers browser
- `dashboard/src/routes/projects/$projectId/enums.tsx` — enums browser
- `dashboard/src/routes/projects/$projectId/extensions.tsx` — extensions browser
- `dashboard/src/routes/projects/$projectId/indexes.tsx` — indexes browser
- `dashboard/src/routes/projects/$projectId/publications.tsx` — publications browser
- `dashboard/src/components/branch-selector.tsx` — branch dropdown component
- `dashboard/src/lib/branches.ts` — branch API client functions
- `dashboard/src/lib/introspection.ts` — introspection API client functions

### MCP — Modify
- `mcp/src/project-tools.ts` — add 6 branch tools
- `mcp/src/crud-tools.ts` — add optional `branch` parameter to existing CRUD tools
- `mcp/src/schema-tools.ts` — add optional `branch` parameter to schema tools
