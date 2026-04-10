# PRD: Phase 5a+5c — Advisors + Platform Dashboard Pages

## Context

Phase 4b shipped database introspection pages (Functions, Triggers, Enums, Extensions, Indexes, Publications), database branching, and enforcement hardening. Phase 5a adds Security and Performance Advisors that analyze project configuration and surface actionable recommendations. Phase 5c adds Platform pages for database administration (Replication, Backups, Migrations, Wrappers, Webhooks).

## Introduction

Phase 5a+5c delivers two advisor pages and five platform pages, plus their backend endpoints. The advisors apply hardcoded rules to project metadata and Postgres system catalogs to surface security misconfigurations and performance issues. The platform pages provide database administration views. The webhook feature includes a full dispatch service using Postgres LISTEN/NOTIFY.

## Goals

1. Security Advisor surfaces actionable findings (no RLS, plain-text sensitive columns, over-permissioned keys)
2. Performance Advisor surfaces index recommendations, table bloat, unused indexes
3. Platform pages provide visibility into replication, backups, migrations, wrappers, and webhooks
4. Database webhooks dispatch HTTP POST on row changes with retry logic
5. All pages follow existing introspection page patterns (backend endpoint + dashboard page + sidebar nav)

## User Stories

### Phase 5a — Advisors

### US-102: Security Advisor backend endpoint

**Description:** As the system, I need an endpoint that analyzes a project's security posture and returns findings.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/advisor/security` returns `[{rule_id, severity, category, title, message, table, suggestion}]`
- [ ] Rule: tables with no RLS policies → severity "warning", suggests enabling RLS
- [ ] Rule: columns with sensitivity "plain" that have names suggesting PII (email, phone, ssn, password, secret, token, address) → severity "warning", suggests "searchable" or "private"
- [ ] Rule: scoped keys with delete permission → severity "info", flags for review
- [ ] Rule: no owner column on any table → severity "info", suggests adding for row-level ownership
- [ ] Rule: tables with no indexes (beyond primary key) and row count > 1000 → severity "info", suggests adding indexes
- [ ] Queries `_pqdb_columns`, `pg_policies`, `pg_indexes`, API keys via platform session
- [ ] All endpoints use `get_project_session` (API key required)
- [ ] Integration test: create table with plain email column, verify finding returned
- [ ] Integration test: create table with RLS policy, verify no "no RLS" finding
- [ ] Unit tests for rule evaluation logic (pure functions)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-103: Performance Advisor backend endpoint

**Description:** As the system, I need an endpoint that analyzes a project's database performance and returns recommendations.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/advisor/performance` returns `[{rule_id, severity, category, title, message, table, suggestion}]`
- [ ] Rule: tables with > 1000 rows and sequential scans > 100 but no user-defined indexes → severity "warning", suggests creating index
- [ ] Rule: indexes that exist but have never been used (idx_scan = 0) → severity "info", suggests dropping
- [ ] Rule: tables with high dead tuple ratio (n_dead_tup / n_live_tup > 0.1) → severity "warning", suggests VACUUM
- [ ] Rule: tables with no ANALYZE in > 7 days → severity "info", suggests running ANALYZE
- [ ] Queries `pg_stat_user_tables`, `pg_stat_user_indexes`, `pg_indexes`
- [ ] All endpoints use `get_project_session` (API key required)
- [ ] Integration test: verify endpoint returns valid response shape
- [ ] Unit tests for rule evaluation logic (pure functions)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-104: Security Advisor dashboard page

**Description:** As a developer, I want to see security findings for my project so I can fix misconfigurations.

**Dependencies:** US-102

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/security` accessible from sidebar (Shield icon)
- [ ] Fetches from `GET /v1/db/advisor/security` via new `fetchSecurityFindings()` in lib
- [ ] Findings displayed as cards grouped by severity (critical → warning → info)
- [ ] Each finding shows: severity badge (color-coded), title, message, affected table/key, suggested fix
- [ ] Summary bar at top: count of critical/warning/info findings
- [ ] Empty state: "No security issues found. Your project looks good!"
- [ ] Loading skeletons while fetching
- [ ] Added to sidebar `pauseDisabledPaths`
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-105: Performance Advisor dashboard page

**Description:** As a developer, I want to see performance recommendations for my project.

**Dependencies:** US-103

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/performance` accessible from sidebar (Gauge icon)
- [ ] Fetches from `GET /v1/db/advisor/performance` via new `fetchPerformanceFindings()` in lib
- [ ] Findings displayed as cards grouped by severity
- [ ] Each finding shows: severity badge, title, message, affected table/index, suggested action
- [ ] Table stats section: shows pg_stat_user_tables data (row count, seq scans, index scans, dead tuples, last vacuum/analyze)
- [ ] Empty state: "No performance issues found."
- [ ] Loading skeletons while fetching
- [ ] Added to sidebar `pauseDisabledPaths`
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### Phase 5c — Platform Pages

### US-106: Replication dashboard page

**Description:** As a developer, I want to see replication status for my project database.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/catalog/replication` backend endpoint queries `pg_replication_slots` and `pg_stat_replication`
- [ ] Returns `[{slot_name, slot_type, active, restart_lsn, confirmed_flush_lsn}]` for slots and `[{client_addr, state, sent_lsn, write_lsn, replay_lsn, replay_lag}]` for active replication
- [ ] New dashboard page at `/projects/{id}/replication`
- [ ] Shows replication slots table and active replication connections
- [ ] Empty state: "No replication configured."
- [ ] Sidebar nav item (Database icon)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-107: Backups dashboard page

**Description:** As a developer, I want to see backup status for my project database.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/catalog/backups` backend endpoint queries `pg_stat_archiver` for WAL archiving stats
- [ ] Returns `{archived_count, failed_count, last_archived_wal, last_archived_time, last_failed_wal, last_failed_time}`
- [ ] New dashboard page at `/projects/{id}/backups`
- [ ] Shows archiver stats, last successful/failed backup times
- [ ] Info banner: "Backup management is handled by your database provider (RDS, local pg_dump, etc.)"
- [ ] Empty state: "WAL archiving is not configured."
- [ ] Sidebar nav item (HardDrive icon)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-108: Migrations dashboard page

**Description:** As a developer, I want to see the migration history for my platform database.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/projects/{id}/migrations` backend endpoint queries Alembic migration files and `alembic_version` table
- [ ] Returns `{current_head, migrations: [{revision, down_revision, description, applied}]}`
- [ ] Lists all migration files with their revision numbers and descriptions
- [ ] Marks the currently applied migration (from `alembic_version` table)
- [ ] New dashboard page at `/projects/{id}/migrations`
- [ ] Shows migration timeline/list with current head highlighted
- [ ] Sidebar nav item (GitCommitHorizontal icon)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-109: Foreign Data Wrappers dashboard page

**Description:** As a developer, I want to see foreign data wrappers configured in my project database.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `GET /v1/db/catalog/wrappers` backend endpoint queries `pg_foreign_server`, `pg_foreign_data_wrapper`, `information_schema.foreign_tables`
- [ ] Returns `{wrappers: [{name, handler, validator}], servers: [{name, wrapper, options}], tables: [{name, server, schema, columns}]}`
- [ ] New dashboard page at `/projects/{id}/wrappers`
- [ ] Shows wrappers, foreign servers, and foreign tables in organized sections
- [ ] Empty state: "No foreign data wrappers configured."
- [ ] Sidebar nav item (Link icon)
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

### US-110: Database Webhooks schema and service

**Description:** As the system, I need a webhook configuration table and a dispatch service that listens for Postgres NOTIFY and sends HTTP POST requests.

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Alembic migration creates `_pqdb_webhooks` table in project databases with columns: id (bigint PK), table_name (text), events (text[] — insert/update/delete), url (text), secret (text, for HMAC signing), active (boolean default true), created_at (timestamptz)
- [ ] `POST /v1/db/webhooks` creates a webhook config + installs a Postgres trigger on the target table that calls `pg_notify('pqdb_webhook', payload)`
- [ ] `GET /v1/db/webhooks` lists all configured webhooks
- [ ] `DELETE /v1/db/webhooks/{id}` removes webhook config and drops the trigger
- [ ] Trigger payload includes: table_name, event (INSERT/UPDATE/DELETE), row data as JSON
- [ ] Webhook dispatch: background task listens to NOTIFY channel, sends HTTP POST to configured URL with JSON body `{table, event, row, timestamp}`
- [ ] Request signed with HMAC-SHA256 using webhook secret in `X-Webhook-Signature` header
- [ ] Retry logic: 3 attempts with exponential backoff (1s, 5s, 25s)
- [ ] Integration test: create webhook, insert row, verify HTTP POST dispatched (use httpbin or mock server)
- [ ] Unit tests for payload construction and HMAC signing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Service responds to health check

### US-111: Database Webhooks dashboard page

**Description:** As a developer, I want to manage database webhooks from the dashboard.

**Dependencies:** US-110

**Acceptance Criteria:**
- [ ] New page at `/projects/{id}/webhooks` accessible from sidebar (Bell icon)
- [ ] Lists all configured webhooks with: table name, events (badges), URL, active toggle, delete button
- [ ] "Add Webhook" dialog: select table, check events (insert/update/delete), enter URL, optional secret
- [ ] Toggle active/inactive on existing webhooks
- [ ] Delete with confirmation dialog
- [ ] Empty state: "No webhooks configured. Add a webhook to receive HTTP notifications on row changes."
- [ ] Sidebar nav item (Bell icon)
- [ ] Unit tests pass
- [ ] CI passes
- [ ] Typecheck passes
- [ ] Production build succeeds
- [ ] Verify in browser

## Functional Requirements

- **FR-1:** Security Advisor returns findings based on hardcoded rules analyzing project metadata
- **FR-2:** Performance Advisor returns findings based on Postgres statistics catalogs
- **FR-3:** Findings are severity-graded (critical, warning, info) with actionable suggestions
- **FR-4:** Platform pages query Postgres system catalogs for replication, backup, and wrapper data
- **FR-5:** Migrations page shows Alembic history with current head highlighted
- **FR-6:** Webhooks use Postgres LISTEN/NOTIFY for real-time dispatch
- **FR-7:** Webhook requests are HMAC-signed and retried on failure

## Non-Goals

- Configurable advisor rules (hardcoded for now)
- Auto-fix for advisor findings (display only)
- Webhook delivery guarantees beyond 3 retries
- Webhook event filtering by column or condition
- Managed backup/restore UI (read-only status only)
- Replication management (read-only status only)

## Technical Considerations

### Advisor Rule Engine

Rules are pure functions that take table/column/key metadata and return findings. This makes them easy to unit test without database access.

### Webhook Architecture

The webhook dispatch runs as a background asyncio task within the FastAPI app lifespan:
1. On startup: connect to each project DB's NOTIFY channel `pqdb_webhook`
2. On notification: look up webhook config, construct payload, send HTTP POST
3. HMAC signing: `hmac.new(secret, payload, sha256).hexdigest()` in `X-Webhook-Signature`
4. Retry: `asyncio.create_task` with backoff delays

### Sidebar Growth

Adding 7 more nav items. Group under collapsible sections:
- **Advisors**: Security, Performance
- **Platform**: Replication, Backups, Migrations, Wrappers, Webhooks

## Dependency Graph

```
Chain A (Security Advisor):
  US-102 (backend) → US-104 (dashboard)

Chain B (Performance Advisor):
  US-103 (backend) → US-105 (dashboard)

Chain C (Platform - standalone pages):
  US-106 (replication) [standalone]
  US-107 (backups) [standalone]
  US-108 (migrations) [standalone]
  US-109 (wrappers) [standalone]

Chain D (Webhooks):
  US-110 (schema + service) → US-111 (dashboard)
```

Seven independent starting points: US-102, US-103, US-106, US-107, US-108, US-109, US-110

## Success Metrics

- Security Advisor flags at least 3 findings on a typical project with no RLS and plain email columns
- Performance Advisor shows table stats from pg_stat_user_tables
- All 5 platform pages render data or appropriate empty states
- Webhook dispatches HTTP POST within 1 second of row change
