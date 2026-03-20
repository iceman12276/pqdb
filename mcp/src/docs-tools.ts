/**
 * Documentation and type generation tools for the pqdb MCP server.
 *
 * Tools:
 *   - pqdb_search_docs: keyword search over embedded pqdb documentation
 *   - pqdb_generate_types: generate TypeScript interfaces from introspection
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Static documentation corpus ──────────────────────────────────────

interface DocEntry {
  title: string;
  keywords: string[];
  content: string;
}

const DOCS_CORPUS: DocEntry[] = [
  {
    title: "Column Sensitivity Levels",
    keywords: ["column", "sensitivity", "searchable", "private", "plain", "encrypted", "level"],
    content:
      "pqdb supports three column sensitivity levels:\n" +
      "- **plain**: Stored as-is in native Postgres types. Fully queryable with all filter operations.\n" +
      "- **searchable**: Client-side ML-KEM-768 encrypted. Stored as {col}_encrypted (bytea) + {col}_index (text, HMAC-SHA3-256 blind index). Supports .eq() and .in() queries only.\n" +
      "- **private**: Client-side ML-KEM-768 encrypted. Stored as {col}_encrypted (bytea) only. No server-side filtering possible.\n" +
      "The original column name is never created in the physical table for sensitive fields.",
  },
  {
    title: "Post-Quantum Encryption",
    keywords: ["encryption", "pqc", "post-quantum", "ml-kem", "ml-kem-768", "kyber", "nist", "cryptography", "encrypt", "decrypt", "key"],
    content:
      "pqdb uses NIST-standardized post-quantum cryptography (PQC) algorithms. All sensitive data is encrypted client-side using ML-KEM-768 (formerly CRYSTALS-Kyber) before transmission to the server. " +
      "The server never holds decryption keys — this is zero-knowledge architecture. " +
      "ML-KEM-768 provides IND-CCA2 security and is resistant to both classical and quantum computer attacks.",
  },
  {
    title: "Query Operations",
    keywords: ["query", "filter", "operations", "select", "eq", "gt", "lt", "gte", "lte", "in", "order", "limit", "offset", "pagination"],
    content:
      "Query operations available in pqdb:\n" +
      "- .eq(column, value): Equality filter. Works on plain and searchable columns.\n" +
      "- .gt(column, value): Greater than. Plain columns only.\n" +
      "- .lt(column, value): Less than. Plain columns only.\n" +
      "- .gte(column, value): Greater than or equal. Plain columns only.\n" +
      "- .lte(column, value): Less than or equal. Plain columns only.\n" +
      "- .in(column, values): IN filter. Works on plain and searchable columns.\n" +
      "- .order(column, direction): Order results. Plain columns only.\n" +
      "- .limit(n): Limit result count.\n" +
      "- .offset(n): Skip rows for pagination.\n" +
      "Range queries (.gt, .lt, .gte, .lte) are NOT possible on encrypted columns — this is a mathematical limitation of blind indexing.",
  },
  {
    title: "API Key Authentication",
    keywords: ["api", "key", "authentication", "apikey", "anon", "service", "service_role", "header", "auth"],
    content:
      "pqdb uses API key authentication for project-scoped endpoints. Keys are sent in the 'apikey' HTTP header.\n" +
      "Two roles per project:\n" +
      "- **anon key** (pqdb_anon_*): Limited access, subject to RLS policies.\n" +
      "- **service_role key** (pqdb_service_*): Full access, bypasses RLS. Use server-side only.\n" +
      "Keys are stored as argon2id hashes. Format: pqdb_{role}_{random_32_chars}.",
  },
  {
    title: "Developer Authentication",
    keywords: ["developer", "jwt", "token", "login", "signup", "refresh", "ed25519", "auth", "password"],
    content:
      "Developer authentication uses Ed25519 JWT tokens with argon2id password hashing.\n" +
      "Endpoints: POST /v1/auth/signup, POST /v1/auth/login, POST /v1/auth/refresh.\n" +
      "The JWT is sent as 'Authorization: Bearer <token>' header for project management endpoints " +
      "(list projects, create project, manage API keys, etc.).",
  },
  {
    title: "Shadow Column Naming",
    keywords: ["shadow", "column", "naming", "convention", "encrypted", "index", "blind", "hmac"],
    content:
      "For sensitive columns, pqdb creates shadow columns instead of the original column name:\n" +
      "- Encrypted data: {original_name}_encrypted (bytea type)\n" +
      "- Blind index: {original_name}_index (text type, for searchable columns only)\n" +
      "The SDK transparently maps between original names and shadow columns. " +
      "For example, defining 'email' as searchable creates 'email_encrypted' and 'email_index' in the physical table.",
  },
  {
    title: "Multi-Tenancy Architecture",
    keywords: ["multi-tenant", "tenancy", "database", "isolation", "project", "platform"],
    content:
      "pqdb uses database-level multi-tenancy:\n" +
      "- Platform database (pqdb_platform): Stores developer accounts, projects, API keys.\n" +
      "- Project databases (pqdb_project_{uuid}): One isolated Postgres database per project.\n" +
      "Each project gets its own database, provisioned automatically on project creation. " +
      "This provides strong isolation between tenants.",
  },
  {
    title: "HMAC Blind Indexing",
    keywords: ["hmac", "blind", "index", "searchable", "sha3", "hash", "vault", "secret"],
    content:
      "Searchable columns use HMAC-SHA3-256 blind indexes for equality queries.\n" +
      "Each project has a unique 256-bit HMAC key stored in HashiCorp Vault at secret/pqdb/projects/{project_id}/hmac.\n" +
      "The SDK computes HMAC(value) client-side and sends the hash as the _index column. " +
      "The server can match indexes without ever seeing plaintext values.",
  },
  {
    title: "Row Level Security (RLS)",
    keywords: ["rls", "row", "level", "security", "policy", "owner", "role", "permission", "access"],
    content:
      "pqdb supports Row Level Security (RLS) policies on tables.\n" +
      "Policies control which rows each role can SELECT, INSERT, UPDATE, or DELETE.\n" +
      "Owner-based policies use the is_owner column flag to restrict access to rows owned by the authenticated user. " +
      "The anon API key is subject to RLS; the service_role key bypasses all RLS policies.",
  },
  {
    title: "Vector Similarity Search",
    keywords: ["vector", "similarity", "search", "embedding", "cosine", "l2", "distance", "pgvector", "similar_to"],
    content:
      "pqdb supports vector similarity search via pgvector.\n" +
      "Use .similarTo({ column, vector, limit?, distance? }) in queries.\n" +
      "Supported distance metrics: cosine (default), l2 (Euclidean), inner_product.\n" +
      "Vector columns store float arrays and support approximate nearest neighbor (ANN) indexing.",
  },
  {
    title: "MCP Server Integration",
    keywords: ["mcp", "model", "context", "protocol", "server", "ai", "agent", "tool", "resource"],
    content:
      "The pqdb MCP server allows AI agents to interact with pqdb databases via the Model Context Protocol.\n" +
      "Available tools include schema introspection, CRUD operations, auth management, SQL execution, and documentation search.\n" +
      "Configuration: set PQDB_PROJECT_URL, PQDB_API_KEY, and optionally PQDB_ENCRYPTION_KEY and PQDB_DEV_TOKEN as environment variables.\n" +
      "Transport options: stdio (default) or SSE.",
  },
  {
    title: "Table Management",
    keywords: ["table", "create", "drop", "schema", "define", "introspect", "column", "type"],
    content:
      "Tables are managed via the /v1/db/ endpoints.\n" +
      "- POST /v1/db/tables: Create a table with column definitions including sensitivity levels.\n" +
      "- GET /v1/db/introspect: List all tables with their schemas.\n" +
      "- GET /v1/db/introspect/{table}: Get detailed schema for a single table.\n" +
      "The SDK's defineTable() method sends column definitions to the API and sets up client-side encryption automatically.",
  },
];

/**
 * Search the docs corpus by keyword matching.
 * Returns entries where any keyword or title matches any word in the query.
 */
export function searchDocs(query: string): { title: string; content: string }[] {
  const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (queryWords.length === 0) return [];

  const scored: { entry: DocEntry; score: number }[] = [];

  for (const entry of DOCS_CORPUS) {
    let score = 0;
    const titleLower = entry.title.toLowerCase();
    const allKeywords = entry.keywords.map((k) => k.toLowerCase());

    for (const word of queryWords) {
      // Exact keyword match: high score
      if (allKeywords.includes(word)) {
        score += 3;
      }
      // Partial keyword match
      else if (allKeywords.some((k) => k.includes(word) || word.includes(k))) {
        score += 2;
      }
      // Title contains word
      if (titleLower.includes(word)) {
        score += 2;
      }
      // Content contains word
      if (entry.content.toLowerCase().includes(word)) {
        score += 1;
      }
    }

    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => ({ title: s.entry.title, content: s.entry.content }));
}

// ── Type generation helpers ──────────────────────────────────────────

/** Introspected column from the pqdb API. */
interface IntrospectColumn {
  name: string;
  type: string;
  sensitivity: string;
  is_owner: boolean;
}

/** Introspected table from the pqdb API. */
interface IntrospectTable {
  name: string;
  columns: IntrospectColumn[];
  sensitivity_summary: Record<string, number>;
}

/** Response from GET /v1/db/introspect. */
interface IntrospectAllResponse {
  tables: IntrospectTable[];
}

/** Map SQL types to TypeScript types. */
function sqlTypeToTs(sqlType: string): string {
  const t = sqlType.toLowerCase();

  // Arrays
  if (t.endsWith("[]")) {
    const inner = sqlTypeToTs(t.slice(0, -2));
    return `${inner}[]`;
  }

  // Numeric types
  if (
    t === "integer" || t === "int" || t === "int4" ||
    t === "bigint" || t === "int8" ||
    t === "smallint" || t === "int2" ||
    t === "serial" || t === "bigserial" ||
    t === "numeric" || t === "decimal" ||
    t === "real" || t === "float4" ||
    t === "double precision" || t === "float8"
  ) {
    return "number";
  }

  // Boolean
  if (t === "boolean" || t === "bool") {
    return "boolean";
  }

  // JSON types
  if (t === "json" || t === "jsonb") {
    return "Record<string, unknown>";
  }

  // String types (text, varchar, char, uuid, timestamp, date, etc.)
  return "string";
}

/** Convert a snake_case table name to PascalCase for the interface name. */
function toPascalCase(name: string): string {
  return name
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** Generate TypeScript interfaces from introspection data. */
export function generateTypeScript(tables: IntrospectTable[]): string {
  const lines: string[] = [
    "// Auto-generated by pqdb MCP server",
    "// Do not edit manually — regenerate with pqdb_generate_types",
    "",
  ];

  for (const table of tables) {
    const interfaceName = toPascalCase(table.name);
    lines.push(`export interface ${interfaceName} {`);

    for (const col of table.columns) {
      const tsType = sqlTypeToTs(col.type);
      const sensitivityComment =
        col.sensitivity !== "plain" ? ` // ${col.sensitivity}` : "";
      lines.push(`  ${col.name}: ${tsType};${sensitivityComment}`);
    }

    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

/** Make an authenticated GET request using apikey header. */
async function apikeyGet<T>(
  projectUrl: string,
  apiKey: string,
  path: string,
): Promise<T> {
  const response = await fetch(`${projectUrl}${path}`, {
    method: "GET",
    headers: { apikey: apiKey },
  });

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { detail?: string };
      detail = body.detail ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

/**
 * Register documentation and type generation tools on the MCP server.
 */
export function registerDocsTools(
  mcpServer: McpServer,
  projectUrl: string,
  apiKey: string,
): void {
  // ── pqdb_search_docs ────────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_search_docs",
    "Search pqdb documentation for concepts, features, and usage. No API call — uses embedded docs.",
    {
      query: z.string().describe("Search query (keywords about pqdb features, concepts, operations)"),
    },
    async ({ query }) => {
      const results = searchDocs(query);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ query, results }),
          },
        ],
      };
    },
  );

  // ── pqdb_generate_types ─────────────────────────────────────────────

  mcpServer.tool(
    "pqdb_generate_types",
    "Generate TypeScript interface definitions from the database schema via introspection",
    {},
    async () => {
      try {
        const result = await apikeyGet<IntrospectAllResponse>(
          projectUrl,
          apiKey,
          "/v1/db/introspect",
        );

        const typescript = generateTypeScript(result.tables);

        return {
          content: [{ type: "text" as const, text: typescript }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: err instanceof Error ? err.message : "Failed to generate types",
            },
          ],
        };
      }
    },
  );
}
