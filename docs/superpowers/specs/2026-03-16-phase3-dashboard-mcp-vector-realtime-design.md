# Phase 3 Design: Dashboard + MCP + Vector Search + Realtime

## Overview

Phase 3 transforms pqdb from an API-only platform into a fully featured developer experience with a visual Dashboard, AI agent integration via MCP, vector similarity search, and realtime subscriptions. Every feature preserves the zero-knowledge guarantee — the server never holds decryption keys.

Phase 3 is split into two sub-phases, each independently shippable:

- **Phase 3a** (12 stories): Dashboard/Studio UI, Developer OAuth login, Passkey/WebAuthn developer login
- **Phase 3b** (14 stories): MCP server for AI agents, NL-to-query translation, vector similarity search, realtime subscriptions, Dashboard Realtime + MCP pages

### Deferred to Phase 4

- **ML-DSA-65 auth tokens** — Ed25519 JWTs are 15-min lived; attacker must break signature within token lifetime. Defense-in-depth, not a gap.
- **PQC TLS** — Data in transit is already ML-KEM encrypted client-side. Standard TLS is sufficient.
- **Multi-region deployment** — Local Docker Compose for now.
- **Kubernetes deployment** — Deferred alongside multi-region.

---

## Section 1: Dashboard/Studio UI (Phase 3a)

### Problem

Developers interact with pqdb exclusively through the CLI and SDK. There is no visual interface for managing projects, browsing schemas, viewing data, or configuring auth settings. Every competing platform (Supabase, Firebase, PlanetScale) ships a Dashboard — developers expect one.

### Technology

- **TanStack Start** + React 19 in `/dashboard` directory
- **TanStack Router** (file-based routing) + **TanStack Query** (data fetching/caching)
- **shadcn/ui** + **Tailwind CSS** for components
- **React Flow** for schema visualizer (ERD)
- **Dark theme** by default (matches Supabase aesthetic, developer preference)
- Served as a separate app on its own port (e.g., `localhost:3000`), proxied in production
- Communicates with the backend via the existing REST API using developer JWT auth
- Developer JWTs stored in memory (TanStack Query cache) — never in localStorage or cookies. Optional sessionStorage for tab-persistence across page reloads; cleared on tab close

### Layout (modeled after Supabase Dashboard)

**Top bar:**
- Account selector
- Project selector dropdown
- "Connect" button (shows API keys + connection snippets)
- Search (`Cmd+K`)
- Settings gear

**Left sidebar navigation:**

| Sidebar Item | Description |
|---|---|
| **Project Overview** | Status cards, API request stats, encryption info, HMAC key version |
| **Table Editor** | Data viewer with client-side decryption, row CRUD |
| **Query Playground** | SDK query builder syntax, encrypted results decrypted client-side |
| **Schema** | Schema visualizer (ERD with React Flow), column management, sensitivity badges |
| **Authentication** | End-user auth: OAuth providers, roles, policies, MFA settings, verification |
| **Realtime** | Subscription config + event inspector (grayed out until Phase 3b) |
| **Logs** | API request logs, auth events, webhook delivery history. Data source: structlog writes to `_pqdb_audit_log` table per project DB (auto-created by `ensure_audit_table()`). Phase 3a ships a read-only log viewer; log ingestion detail decided during implementation |
| **MCP** | MCP server config + connection info (grayed out until Phase 3b) |
| **Project Settings** | API keys, HMAC key rotation, general settings |

**Account settings** (`/settings`): Developer profile, linked OAuth accounts, passkey management.

### Page routes

| Route | Purpose |
|---|---|
| `/login` | Email/password form + OAuth buttons + Passkey login |
| `/signup` | Developer registration |
| `/projects` | Project list with create button |
| `/projects/:id` | Project overview — status, request stats, encryption info |
| `/projects/:id/tables` | Table list with data viewer |
| `/projects/:id/tables/:name` | Table detail — paginated rows, column metadata |
| `/projects/:id/schema` | Schema visualizer (ERD) + column management |
| `/projects/:id/sql` | Query playground |
| `/projects/:id/auth` | Auth settings — providers, roles, policies, verification |
| `/projects/:id/keys` | API key management — masked view, rotate, copy |
| `/projects/:id/logs` | Request logs |
| `/projects/:id/settings` | Project settings |
| `/settings` | Developer account settings, OAuth accounts, passkeys |

### Client-side decryption ("Unlock" flow)

The Dashboard cannot decrypt sensitive columns by default — it doesn't have the developer's encryption key. This reinforces zero-knowledge: even the developer's own Dashboard can't see plaintext without the key.

Flow:
1. Developer opens Table Editor or Query Playground
2. Plain columns load immediately (visible, no decryption needed)
3. Encrypted columns display `[encrypted]`
4. Developer clicks "Unlock" and enters their encryption key into a client-side-only input
5. The Dashboard loads the `@pqdb/client` SDK in the browser, passes the key to it
6. SDK fetches ciphertext from the API, decrypts it in the browser, displays plaintext
7. Key is held in memory only — never sent to the server, never persisted to disk/localStorage
8. When they close the tab, navigate away, or click "Lock", the key is cleared

This is the same security model as Signal Desktop or Proton Mail — the client has the key, decryption is local.

### Schema visualizer

Visual ERD displayed on the Schema page:
- Each table rendered as a node/box with columns listed inside
- Foreign key relationships as connecting lines between tables
- Color-coded sensitivity badges per column:
  - **Plain** — gray (default)
  - **Searchable** — blue (encrypted + blind index queryable)
  - **Private** — purple (encrypted, no server-side filtering)
- Owner columns marked with a key icon (RLS marker)
- **Logical view** (default): shows developer-facing column names (`email`, `name`)
- **Physical view** (toggle): shows actual Postgres columns (`email_encrypted`, `email_index`)
- Interactive: drag, zoom, auto-layout via React Flow

Data source: existing `GET /v1/db/introspect` endpoint — no new backend work needed.

### Key design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Framework | TanStack Start + React | File-based routing, server functions for auth flows, TanStack Query for caching |
| UI library | shadcn/ui + Tailwind | Composable, dark-mode native, matches developer tool aesthetic |
| Data access | Via REST API only | Dashboard is just a visual client — no direct DB access, same as SDK |
| Encrypted data | Client-side decryption with SDK | Zero-knowledge preserved; key never leaves browser memory |
| Schema viz | React Flow | Industry standard for node-based diagrams in React |
| Theme | Dark by default | Developer preference, matches Supabase |

---

## Section 2: Developer OAuth Login (Phase 3a)

### Problem

Developers currently log in with email/password only. Now that a Dashboard exists (browser context for consent flows), we can offer OAuth as an additional login method. Email/password remains the primary method — OAuth is opt-in.

### Flow

```
1. Developer clicks "Sign in with Google" on Dashboard login page
2. Dashboard redirects to: GET /v1/auth/oauth/google/authorize (developer-level endpoint)
3. Server generates state JWT (10-min expiry, contains redirect_uri + nonce)
4. Server redirects to Google's consent screen
5. Developer consents, Google redirects back to /v1/auth/oauth/google/callback
6. Server validates state JWT, exchanges code for user info
7. Server finds-or-creates developer in developers table (linked via developer_oauth_identities)
8. Server issues developer JWT, redirects to Dashboard with tokens
9. Dashboard stores tokens, developer is logged in
```

### Differences from end-user OAuth (Phase 2b)

| | End-user OAuth (Phase 2b) | Developer OAuth (Phase 3a) |
|---|---|---|
| **Identity table** | `_pqdb_oauth_identities` in project DB | `developer_oauth_identities` in platform DB |
| **Who configures credentials** | Developer configures per-project | Platform operator configures once |
| **Scope** | Per-project user pool | Global developer accounts |
| **OAuth credentials stored** | Vault at `secret/pqdb/projects/{id}/oauth/{provider}` | Vault at `secret/pqdb/platform/oauth/{provider}` |
| **Endpoints** | `/v1/auth/users/oauth/*` (project-scoped) | `/v1/auth/oauth/*` (platform-scoped) |

### Account linking

Same pattern as Phase 2b: link by email only when existing developer account has a verified email. New field needed: `email_verified` on the `developers` table (default `false`, set to `true` on first successful OAuth login or via email verification).

### Platform DB changes (Alembic migration)

```sql
-- Add email_verified to developers
ALTER TABLE developers ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;

-- New table
developer_oauth_identities (
  id            UUID PRIMARY KEY,
  developer_id  UUID REFERENCES developers(id),
  provider      TEXT NOT NULL,
  provider_uid  TEXT NOT NULL,
  email         TEXT,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  UNIQUE(provider, provider_uid)
)
```

### Vault storage

Platform OAuth credentials stored at `secret/pqdb/platform/oauth/{provider}`:
```json
{
  "client_id": "...",
  "client_secret": "..."
}
```

VaultClient gains `store_platform_oauth_credentials()`, `get_platform_oauth_credentials()`, `delete_platform_oauth_credentials()` methods.

### Login page options

All three methods produce the same developer JWT:
1. Email + password form (existing, always available)
2. "Sign in with Google" / "Sign in with GitHub" buttons (new)
3. "Sign in with Passkey" button (new, Section 3)

### Shipped providers

Google and GitHub — same as end-user OAuth. The adapter interface is already built (Phase 2b); developer OAuth reuses the same `OAuthProvider` ABC with different credential sources.

---

## Section 3: Passkey/WebAuthn Developer Login (Phase 3a)

### Problem

Passwords are phishable. Passkeys (WebAuthn) provide hardware-backed, phishing-resistant authentication. The Dashboard provides the browser context needed for `navigator.credentials`.

### Registration flow

```
1. Developer logs in (must be authenticated first — via email/password or OAuth)
2. Developer navigates to /settings → "Security" → "Add Passkey"
3. Dashboard calls GET /v1/auth/passkeys/challenge → server returns registration options
4. Dashboard calls navigator.credentials.create() with server-generated challenge
5. Browser prompts biometric/PIN (Touch ID, Windows Hello, security key)
6. Browser returns attestation → Dashboard sends to POST /v1/auth/passkeys/register
7. Server validates attestation via py_webauthn, stores credential
8. Developer can now log in with this passkey
```

### Login flow

```
1. Developer clicks "Sign in with Passkey" on login page
2. Dashboard calls GET /v1/auth/passkeys/challenge?type=authentication
3. Server returns challenge with empty allowCredentials list (discoverable credential flow — browser finds the right passkey)
4. Dashboard calls navigator.credentials.get() with challenge (empty allowCredentials)
5. Browser prompts biometric/PIN
6. Browser returns assertion → Dashboard sends to POST /v1/auth/passkeys/authenticate
7. Server validates assertion (signature verification, counter increment check) via py_webauthn
8. Server issues developer JWT
9. Dashboard stores tokens, developer is logged in
```

### Platform DB changes (Alembic migration)

```sql
developer_credentials (
  id               UUID PRIMARY KEY,
  developer_id     UUID REFERENCES developers(id),
  credential_id    BYTEA UNIQUE NOT NULL,   -- WebAuthn credential ID
  public_key       BYTEA NOT NULL,          -- COSE public key
  sign_count       INTEGER DEFAULT 0,       -- replay protection counter
  name             TEXT,                     -- user-chosen label: "MacBook Touch ID", "YubiKey"
  created_at       TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ
)
```

One developer can have multiple passkeys (laptop + phone + security key).

### Backend library

`py_webauthn` — well-maintained Python WebAuthn library. Handles attestation validation, assertion verification, CBOR/COSE parsing.

### Important constraints

- Passkeys are an **additional** login method — email/password and OAuth always remain available
- Registration requires an active session (must already be logged in)
- Developers can delete passkeys from `/settings`
- WebAuthn Relying Party ID configured per deployment (e.g., `localhost` for dev, `pqdb.io` for prod)

---

## Section 4: MCP Server for AI Agents (Phase 3b)

### Problem

AI agents (Claude, GPT, Cursor, etc.) cannot interact with pqdb programmatically. Developers building AI-powered applications need their agents to query schemas, read/write data, and understand column sensitivity. The Model Context Protocol (MCP) is the emerging standard for AI-tool integration.

### Architecture

Standalone TypeScript service in `/mcp` directory. Uses the official `@modelcontextprotocol/sdk` package. Imports `@pqdb/client` directly for both API calls and optional client-side decryption — no crypto reimplementation needed.

```
AI Agent → MCP Server (TypeScript) → pqdb REST API → Project Database
              ↓                ↓
        API key auth     @pqdb/client SDK
                         (optional decrypt)
```

The MCP server is architecturally a **client**, not a backend service. TypeScript is the natural choice: it shares the SDK's language, reuses its crypto layer, and `@modelcontextprotocol/sdk` is the best-maintained MCP SDK.

### Transports

| Transport | Use case | Configuration |
|---|---|---|
| **stdio** | Local development, Claude Code, Cursor | `pqdb-mcp --project-url http://localhost:8000` |
| **SSE** | Hosted/remote access, cloud deployments | `pqdb-mcp --transport sse --port 3001` |

### Configuration

```json
{
  "pqdb": {
    "command": "pqdb-mcp",
    "args": ["--project-url", "http://localhost:8000"],
    "env": {
      "PQDB_API_KEY": "${PQDB_API_KEY}",
      "PQDB_ENCRYPTION_KEY": "${PQDB_ENCRYPTION_KEY}"
    }
  }
}
```

The `PQDB_ENCRYPTION_KEY` is optional. Without it, sensitive columns return `[encrypted]`. With it, the MCP server passes the key to the imported `@pqdb/client` SDK which decrypts locally — same crypto path as the Dashboard "Unlock" flow. Explicit opt-in by the developer.

### Tools

**Schema tools:**

| Tool | Description |
|---|---|
| `pqdb_list_tables` | List all tables with column count and sensitivity summary |
| `pqdb_describe_table` | Full schema — columns, types, sensitivity levels, valid operations |
| `pqdb_describe_schema` | ERD-style overview of all tables + foreign key relationships |

**CRUD tools:**

| Tool | Description |
|---|---|
| `pqdb_insert_rows` | Insert one or more rows into a table |
| `pqdb_query_rows` | Select with filters, ordering, pagination |
| `pqdb_update_rows` | Update rows matching filters |
| `pqdb_delete_rows` | Delete rows matching filters |

**Auth tools:**

| Tool | Description |
|---|---|
| `pqdb_list_users` | List end-users (requires service API key) |
| `pqdb_list_roles` | List configured roles |
| `pqdb_list_policies` | List RLS policies for a table |

**Intelligence tool:**

| Tool | Description |
|---|---|
| `pqdb_natural_language_query` | Accepts natural language question, translates to pqdb query, executes, returns results |

### Resources

MCP resources provide schema metadata without tool calls:

```
pqdb://tables              → list of tables
pqdb://tables/{name}       → column schema for a specific table
pqdb://tables/{name}/stats → row count, sensitivity summary
```

### Natural language to query translation

The `pqdb_natural_language_query` tool uses schema introspection to understand table structure, then builds the appropriate SDK query. It respects sensitivity levels — it won't attempt range queries on encrypted columns, only `.eq()` on searchable columns.

Implementation: rule-based translation using schema metadata. No LLM needed for V1 — the query builder syntax is simple enough that pattern matching covers common queries:
- "find users where email is alice@example.com" → `.from(users).select().eq('email', 'alice@example.com')`
- "show all posts" → `.from(posts).select()`
- "get orders after 2026-01-01" → `.from(orders).select().gt('created_at', '2026-01-01')`
- "show me the schema" → calls `pqdb_describe_schema`

Queries that can't be translated return a clear error explaining what's supported.

### Zero-knowledge constraint

The MCP server cannot decrypt sensitive columns unless the developer explicitly provides `PQDB_ENCRYPTION_KEY`. This matches the Dashboard's "Unlock" model — decryption is always opt-in, always client-side (or in this case, in the MCP server process the developer controls).

---

## Section 5: Vector Similarity Search (Phase 3b)

### Problem

pgvector is enabled in every project database (since Phase 1), and developers can create `vector(N)` columns as `plain` type. But there's no way to perform similarity search — no `.similarTo()` in the SDK, no vector search endpoint in the API.

### Constraint: vectors are always plain

Vector columns **cannot** be encrypted. ML-KEM encryption destroys the mathematical structure that makes similarity search work. This is a fundamental limitation, not a bug. The vector embeddings are stored in plaintext while the rest of the row can still be encrypted.

Validation: the schema engine rejects `column.vector(N).sensitive('searchable')` or `.sensitive('private')` with a clear error.

### Backend: new query operator

The existing `POST /v1/db/{table}/select` endpoint gains a new `similar_to` field:

```json
{
  "columns": ["id", "title", "content"],
  "similar_to": {
    "column": "embedding",
    "vector": [0.1, 0.2, 0.3],
    "limit": 10,
    "distance": "cosine"
  },
  "filters": [
    {"column": "category", "op": "eq", "value": "science"}
  ]
}
```

Note: table name is in the URL path (`POST /v1/db/{table}/select`), not in the request body. The `similar_to` field is `Optional` — requests without it work identically to Phase 1/2 (backward compatible).

Generated SQL:
```sql
SELECT id, title_encrypted, content_encrypted
FROM documents
WHERE category = 'science'
ORDER BY embedding <=> '[0.1, 0.2, 0.3]'
LIMIT 10
```

### Supported distance metrics

| Metric | pgvector Operator | Use case |
|---|---|---|
| `cosine` | `<=>` | Default — normalized embeddings (OpenAI, Cohere) |
| `l2` | `<->` | Spatial data, unnormalized embeddings |
| `inner_product` | `<#>` | Max inner product search |

### Validation rules

- `similar_to.column` must be a `plain` column of type `vector(N)` — reject if sensitive or wrong type
- Vector dimension must match the column's declared dimension — reject with clear error on mismatch
- `similar_to` cannot be combined with `order_by` (ordering is by distance)
- `similar_to.limit` is required (no unbounded vector scans)

### Vector index management

New endpoint for creating vector indexes:

```
POST /v1/db/tables/{name}/indexes
{
  "column": "embedding",
  "type": "hnsw",
  "distance": "cosine"
}
```

| Index type | Trade-off |
|---|---|
| `hnsw` | Fast approximate search, higher memory, better for real-time queries |
| `ivfflat` | Memory-efficient, requires training step, better for large datasets |

`GET /v1/db/tables/{name}/indexes` lists existing indexes (returns index name, column, type, distance). `DELETE /v1/db/tables/{name}/indexes/{index_name}` drops an index by its PostgreSQL name. Index names are auto-generated: `idx_{table}_{column}_{type}` (e.g., `idx_documents_embedding_hnsw`).

### SDK interface

```typescript
const { data } = await client
  .from(documents)
  .select('id', 'title', 'content')
  .similarTo('embedding', queryVector, { limit: 10, distance: 'cosine' })
  .eq('category', 'science')
```

Returns results ordered by similarity. The SDK decrypts `title` and `content` (sensitive columns) as usual — the vector search determines which rows come back, then encryption/decryption handles the rest transparently.

### MCP integration

The `pqdb_query_rows` MCP tool gains support for `similar_to` parameter, allowing AI agents to perform vector search:

```json
{
  "tool": "pqdb_query_rows",
  "arguments": {
    "table": "documents",
    "similar_to": { "column": "embedding", "vector": [...], "limit": 5 }
  }
}
```

---

## Section 6: Realtime Subscriptions (Phase 3b)

### Problem

Developers must poll the API to detect data changes. For chat apps, collaborative tools, and live dashboards, polling is wasteful and adds latency. Supabase ships realtime — developers building on pqdb expect it.

### Architecture

```
┌─────────┐    INSERT     ┌──────────┐   NOTIFY    ┌──────────────┐   WebSocket   ┌─────┐
│ SDK     │──────────────→│ Postgres │────────────→│ Realtime     │──────────────→│ SDK │
│ (write) │               │ triggers │             │ Server       │               │(sub)│
└─────────┘               └──────────┘             └──────────────┘               └─────┘
```

Three components:

1. **PostgreSQL triggers** — `AFTER INSERT/UPDATE/DELETE` triggers on subscribed tables call `pg_notify('pqdb_realtime', payload)`
2. **Realtime server** — Embedded in the FastAPI app via Starlette WebSocket support. LISTENs on `pqdb_realtime` channel per project database connection.
3. **SDK client** — Opens WebSocket, authenticates, subscribes to tables/events, receives and decrypts payloads.

### Trigger installation

Triggers are installed when a subscription is first created for a table.

**Important: pg_notify has a hard 8KB payload limit.** Rows with large ciphertext blobs can easily exceed this. To handle this, the trigger sends only the row ID, table name, and event type — not the full row:

```sql
CREATE OR REPLACE FUNCTION pqdb_notify_changes() RETURNS TRIGGER AS $$
DECLARE
  pk_col TEXT;
  pk_val TEXT;
BEGIN
  -- Get primary key column name from _pqdb_columns
  SELECT column_name INTO pk_col FROM _pqdb_columns
    WHERE table_name = TG_TABLE_NAME AND is_primary_key = true LIMIT 1;
  -- Get primary key value
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('SELECT ($1).%I::text', pk_col) INTO pk_val USING OLD;
  ELSE
    EXECUTE format('SELECT ($1).%I::text', pk_col) INTO pk_val USING NEW;
  END IF;
  PERFORM pg_notify('pqdb_realtime', json_build_object(
    'table', TG_TABLE_NAME,
    'event', TG_OP,
    'pk', pk_val
  )::text);
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
```

The realtime server receives the notification, fetches the full row via SQL (`SELECT * FROM {table} WHERE {pk} = {pk_val}`), applies RLS filtering, then delivers the full row to eligible subscribers. For DELETE events, the server delivers only the primary key (the row no longer exists to fetch).

**Trigger lifecycle:** Triggers are installed permanently on first subscription and remain in place. The overhead of an unused trigger is negligible (function only fires on DML). No cleanup on unsubscribe.

**Project isolation:** Each project database has its own `pqdb_realtime` NOTIFY channel. Cross-project leakage is impossible — isolation is guaranteed by database-level separation.

### Notification payload (via pg_notify)

```json
{
  "table": "messages",
  "event": "INSERT",
  "pk": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Delivered payload (to subscriber, after server fetches full row)

```json
{
  "table": "messages",
  "event": "INSERT",
  "row": {
    "id": "550e8400-...",
    "content_encrypted": "base64...",
    "sender_index": "v2:aabb...",
    "created_at": "2026-03-16T..."
  }
}
```

### RLS enforcement

Not every subscriber should see every event. The realtime server filters per-event, per-subscriber:

1. Extract user role from JWT (or `anon` if no JWT with anon API key)
2. Look up RLS policies for `(table, select, role)` in `_pqdb_policies`
3. **`none`** → don't deliver event to this subscriber
4. **`all`** → deliver event
5. **`owner`** → deliver only if `row[owner_column] == subscriber.user_id`

When no policies exist for a table, fall back to Phase 2a basic owner-column RLS behavior (backward compatible). Tables with no policies and no owner column: service role receives all events; anon/authenticated receive all events (no filtering — same as Phase 1 open access). Service role API key always receives all events regardless of policies.

### WebSocket protocol

```json
// Client → Server: authenticate + subscribe
{ "type": "subscribe", "table": "messages", "events": ["insert", "update"] }

// Server → Client: subscription confirmed
{ "type": "ack", "subscription_id": "sub_123" }

// Server → Client: event received
{ "type": "event", "subscription_id": "sub_123", "event": "insert", "row": {...} }

// Client → Server: unsubscribe
{ "type": "unsubscribe", "subscription_id": "sub_123" }

// Server → Client: heartbeat (every 30s)
{ "type": "heartbeat" }
```

Authentication: API key + optional user JWT sent as query parameters on WebSocket connection handshake (WebSocket in browsers doesn't support custom headers).

```
ws://localhost:8000/v1/realtime?apikey=pqdb_anon_...&token=eyJ...
```

### SDK interface

```typescript
// Subscribe to events
const subscription = client
  .from(messages)
  .on('insert', (payload) => {
    // payload.row is already decrypted by the SDK
    console.log('New message:', payload.row.content)
  })
  .on('update', (payload) => {
    console.log('Updated:', payload.row)
  })
  .subscribe()

// Unsubscribe
subscription.unsubscribe()
```

The SDK handles:
- WebSocket connection lifecycle (connect, reconnect with exponential backoff)
- Decryption of sensitive columns in event payloads before invoking callbacks
- Subscription management (subscribe, unsubscribe, resubscribe on reconnect)
- Heartbeat monitoring (reconnect if no heartbeat received within 60s)

### Why LISTEN/NOTIFY over logical replication

| | LISTEN/NOTIFY | Logical replication |
|---|---|---|
| **Setup** | One trigger per table | Replication slot per DB, publication config |
| **Overhead** | Minimal — fires on DML only | Continuous WAL streaming |
| **Payload control** | We choose what to send | Full row image, harder to filter |
| **Scale ceiling** | ~10k concurrent listeners | Higher, but overkill for Phase 3 |
| **Complexity** | Low | High |

If we hit the ceiling, we swap to logical replication behind the same SDK interface in Phase 4. The SDK API doesn't change.

### Dashboard integration

The Realtime sidebar item (grayed out in Phase 3a) lights up in Phase 3b with:
- List of active subscriptions per table
- Live event inspector (shows events in real-time as they flow)
- Subscription count and connection stats

---

## Section 7: Story Breakdown

### Phase 3a: Dashboard + Developer Auth (~12 stories)

| Story | Title | Depends on |
|-------|-------|-----------|
| US-043 | Dashboard scaffolding (TanStack Start + React + shadcn/ui + Tailwind, dark theme) | — |
| US-044 | Dashboard login/signup pages (email/password via existing API) | US-043 |
| US-045 | Project list + create project pages | US-044 |
| US-046 | Project overview page (status cards, request stats, encryption info) + Logs page (read-only audit log viewer) | US-045 |
| US-047 | API key management page (masked view, rotate, copy connection snippets) | US-045 |
| US-048 | Schema browser + schema visualizer (React Flow ERD, sensitivity badges, logical/physical toggle) | US-045 |
| US-049 | Table editor with data viewer + client-side decryption ("Unlock" with @pqdb/client SDK in browser) | US-048 |
| US-050 | Query playground (SDK query builder, client-side decryption of results) | US-048 |
| US-051 | Auth settings page (providers, roles, policies, verification settings, MFA config) | US-045 |
| US-052 | Developer OAuth backend (Google + GitHub — platform DB, Vault, Alembic migration) | — |
| US-053 | Developer OAuth + Passkey/WebAuthn (Dashboard integration, py_webauthn, Alembic migration) | US-044, US-052 |
| US-054 | Phase 3a E2E tests (Playwright for CI + Claude in Chrome for visual QA) | US-053, US-051 |

Dependency chains:
```
Chain A (Dashboard):  US-043 → US-044 → US-045 → US-046, US-047, US-048, US-051 (parallel)
                                                    US-048 → US-049, US-050 (parallel)
Chain B (Dev auth):   US-052 (independent) ──────→ US-053 (needs US-044)
                                                           ↓
All chains ──────────────────────────────────────→ US-054 (E2E)
```

### Phase 3b: MCP + Vector + Realtime (~12 stories)

| Story | Title | Depends on |
|-------|-------|-----------|
| US-055 | MCP server scaffolding (TypeScript, @modelcontextprotocol/sdk, @pqdb/client, stdio + SSE transport, API key auth) | — |
| US-056 | MCP schema tools + resources (list_tables, describe_table, describe_schema, pqdb:// resources) | US-055 |
| US-057 | MCP CRUD tools (query_rows, insert_rows, update_rows, delete_rows) | US-056 |
| US-058 | MCP auth tools + natural language query tool (rule-based NL-to-query translation) | US-057 |
| US-059 | Vector similarity search backend (similarTo operator, distance metrics, validation) | — |
| US-060 | Vector index management (HNSW + IVFFlat creation/deletion endpoints) + Dashboard Schema page vector index UI | US-059 |
| US-061 | SDK vector search (`.similarTo()` method, distance metric option) | US-059 |
| US-062 | Realtime PostgreSQL triggers + NOTIFY infrastructure (trigger function, installation on subscribe) | — |
| US-063 | Realtime WebSocket server (Starlette WebSocket, connection management, auth, LISTEN) | US-062 |
| US-064 | Realtime RLS enforcement (per-event per-subscriber filtering, policy lookup, owner check) | US-063 |
| US-065 | SDK realtime client (`.on().subscribe()`, auto-reconnect, client-side decryption of event payloads) | US-064 |
| US-066 | Dashboard MCP page (connection config, tool list, test tool UI) | US-058 |
| US-067 | Dashboard Realtime page (active subscriptions, live event inspector, connection stats) | US-065 |
| US-068 | Phase 3b E2E tests (MCP agent round-trip, vector search, realtime subscription + RLS) | US-058, US-061, US-065, US-066, US-067 |

Dependency chains:
```
Chain C (MCP):      US-055 → US-056 → US-057 → US-058 → US-066 (Dashboard MCP page) ──┐
Chain D (Vector):   US-059 → US-060, US-061 (parallel) ──────────────────────────────┤
Chain E (Realtime): US-062 → US-063 → US-064 → US-065 → US-067 (Dashboard RT page) ─┤
                                                                                       └→ US-068 (E2E)
```

**Three independent starting chains** — MCP, Vector, and Realtime can all begin in parallel.

**Critical path:** US-062 → US-063 → US-064 → US-065 → US-067 → US-068 (Realtime is the longest chain)

### E2E test coverage

**Phase 3a (Playwright + Claude in Chrome):**
1. Dashboard login → create project → view in project list → see overview stats
2. Schema visualizer renders tables with sensitivity badges + foreign key relationships
3. Table editor: unlock with encryption key → see decrypted data → re-lock
4. Developer OAuth: sign in with Google → developer account linked → Dashboard access
5. Passkey: register passkey → sign out → sign in with passkey → Dashboard access

**Phase 3b (pytest + SDK):**
6. MCP: connect agent → list_tables → query_rows → results returned (ciphertext without key, plaintext with key)
7. NL-to-SQL: "find users where email is alice@example.com" → correct blind index query → correct result
8. Vector search: insert rows with embeddings → `.similarTo()` → top-K results ordered by distance
9. Vector + encryption: `.similarTo()` returns rows with encrypted columns → SDK decrypts transparently
10. Realtime: subscribe to table → insert row from another client → subscriber receives decrypted event
11. Realtime + RLS: subscriber with `owner` policy only receives events for their own rows; service role receives all

---

## Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dashboard framework | TanStack Start + React | File-based routing, server functions, TanStack Query caching; team already uses TypeScript |
| Dashboard data access | Via REST API only | Dashboard is a visual client, same as SDK; no special DB access |
| Encrypted data in Dashboard | Client-side decryption with SDK | Zero-knowledge preserved; key in browser memory only |
| Schema visualizer | React Flow | Industry standard, interactive, supports auto-layout |
| Developer OAuth | Reuse Phase 2b adapter interface | Same OAuthProvider ABC, different credential source (platform vs project) |
| Passkey library | py_webauthn | Well-maintained, handles CBOR/COSE complexity |
| MCP server | Standalone TypeScript process in /mcp | Imports @pqdb/client directly for API calls + decryption; no crypto reimplementation. AI agents connect via MCP protocol, server calls pqdb REST API |
| MCP transport | stdio + SSE | stdio for local (Claude Code, Cursor); SSE for remote/cloud |
| MCP language | TypeScript (not Python) | MCP server is a client, not a backend service. TypeScript lets it import @pqdb/client SDK directly for decryption |
| NL-to-query | Rule-based V1 | Query builder syntax is simple enough; avoid LLM dependency for now |
| Vector search | pgvector (existing) | Already deployed, zero additional infrastructure, preserves isolation model |
| Realtime transport | LISTEN/NOTIFY + WebSocket | Simplest path; swap to logical replication in Phase 4 if needed |
| Realtime server | Embedded in FastAPI (Starlette WebSocket) | Shares auth middleware and DB connection pool; no extra process |
| Dashboard E2E | Playwright (CI) + Claude in Chrome (visual QA) | Playwright for automated CI; Claude in Chrome for interactive visual validation during development |
| Non-browser E2E | pytest + SDK | Same proven pattern as Phase 1/2 |

## Non-Goals (Phase 3)

- **ML-DSA-65 auth tokens** — Deferred to Phase 4. Ed25519 JWTs are short-lived, low quantum risk.
- **PQC TLS** — Deferred to Phase 4. Data already ML-KEM encrypted client-side.
- **Multi-region deployment** — Deferred to Phase 4.
- **Kubernetes deployment** — Deferred to Phase 4.
- **File storage** — Not in pqdb's scope (it's a database platform, not an object store).
- **Edge functions** — Not in scope.
- **Built-in SMTP / email rendering** — Developers use webhooks (Phase 2b pattern).
- **OAuth providers beyond Google + GitHub** — Adapter interface supports adding more later.
- **LLM-powered NL-to-query** — Rule-based V1 is sufficient; LLM integration can be added later.
- **Logical replication for realtime** — LISTEN/NOTIFY is sufficient for Phase 3 scale.
- **SSR for Dashboard** — Developer tools don't need SEO; SPA is fine.

## Security Notes

- **Client-side decryption key handling:** Dashboard holds encryption key in memory only. Never stored in localStorage, sessionStorage, cookies, or sent to the server. Cleared on tab close or explicit "Lock".
- **WebAuthn Relying Party ID:** Configurable per deployment. Must match the domain serving the Dashboard.
- **WebSocket auth:** API key + JWT as query parameters (not headers — browser WebSocket limitation). TLS encrypts the URL in transit.
- **MCP encryption key:** Optional env var. Developers explicitly opt-in to giving their MCP server decryption access.
- **Realtime RLS:** Events filtered server-side before delivery. A subscriber never receives an event for a row they couldn't read via the REST API.
- **Vector columns:** Always `plain` — cannot be encrypted. Developers understand this tradeoff when using vector search.
- **OAuth state tokens:** Same signed JWT pattern as Phase 2b. CSRF protection via signature + expiry.
- **Dashboard CORS:** Dashboard origin must be explicitly allowed in backend CORS config.
- **Rate limiting:** WebSocket subscriptions limited per connection (max 50 tables per connection). Reconnect attempts rate-limited (max 5/min).
