import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { column, defineTableSchema, ColumnDef } from "../../src/query/schema.js";
import { QueryBuilder } from "../../src/query/builder.js";
import { HttpClient } from "../../src/client/http.js";
import { createClient } from "../../src/client/index.js";

describe("ColumnDef.owner()", () => {
  it(".owner() marks a uuid column as the owner column", () => {
    const col = column.uuid().owner();
    expect(col.isOwner).toBe(true);
    expect(col.type).toBe("uuid");
  });

  it(".owner() returns a new ColumnDef (immutable)", () => {
    const base = column.uuid();
    const owned = base.owner();
    expect(base.isOwner).toBe(false);
    expect(owned.isOwner).toBe(true);
  });

  it(".owner() preserves other properties", () => {
    const col = column.uuid().primaryKey().owner();
    expect(col.isPrimaryKey).toBe(true);
    expect(col.isOwner).toBe(true);
    expect(col.type).toBe("uuid");
    expect(col.sensitivity).toBe("plain");
  });

  it("chaining .owner() on non-uuid columns is NOT available at runtime", () => {
    // .owner() is only defined on UuidColumnDef which is returned by column.uuid()
    // For non-uuid columns, .owner() should not exist
    const textCol = column.text();
    expect("owner" in textCol).toBe(false);
  });
});

describe("defineTableSchema with owner column", () => {
  it("schema includes owner metadata", () => {
    const schema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    expect(schema.columns.owner_id.isOwner).toBe(true);
    expect(schema.columns.id.isOwner).toBe(false);
    expect(schema.columns.title.isOwner).toBeUndefined();
  });
});

describe("serializeSchema includes owner flag", () => {
  it("serializes owner: true for owner columns", () => {
    const schema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    // The schema columns should carry enough info for the SDK to serialize
    // owner: true when sending to the server during table creation
    const ownerCol = schema.columns.owner_id;
    expect(ownerCol.type).toBe("uuid");
    expect(ownerCol.isOwner).toBe(true);

    // Non-owner columns should not have isOwner = true
    expect(schema.columns.id.isOwner).toBe(false);
  });
});

describe("QueryBuilder.insert auto-sets owner column", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const MOCK_USER_AUTH_RESPONSE = {
    user: {
      id: "user-uuid-123",
      email: "user@test.com",
      role: "authenticated",
      email_verified: false,
      metadata: {},
    },
    access_token: "user-access-token",
    refresh_token: "user-refresh-token",
    token_type: "bearer",
  };

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-sets owner column to current user ID on insert", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // user signIn
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      // insert response
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "post-1", owner_id: "user-uuid-123", title: "Hello" }],
      };
    });

    const postsSchema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    await client.from(postsSchema).insert([{ id: "post-1", title: "Hello" }]).execute();

    // The insert request body should have owner_id auto-set
    const [, insertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(insertInit.body as string);
    expect(body.rows[0].owner_id).toBe("user-uuid-123");
  });

  it("does NOT override owner column if explicitly provided", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ id: "post-1", owner_id: "other-user-id", title: "Hello" }],
      };
    });

    const postsSchema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    await client
      .from(postsSchema)
      .insert([{ id: "post-1", owner_id: "other-user-id", title: "Hello" }])
      .execute();

    const [, insertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(insertInit.body as string);
    expect(body.rows[0].owner_id).toBe("other-user-id");
  });

  it("does NOT set owner column if no user is signed in", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ id: "post-1", title: "Hello" }],
    });

    const postsSchema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_key");

    await client.from(postsSchema).insert([{ id: "post-1", title: "Hello" }]).execute();

    const [, insertInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(insertInit.body as string);
    // owner_id should NOT be set because no user is signed in
    expect(body.rows[0].owner_id).toBeUndefined();
  });

  it("auto-sets owner column across multiple rows", async () => {
    let callCount = 0;
    fetchMock.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: true, status: 200, json: async () => MOCK_USER_AUTH_RESPONSE };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [],
      };
    });

    const postsSchema = defineTableSchema("posts", {
      id: column.uuid().primaryKey(),
      owner_id: column.uuid().owner(),
      title: column.text(),
    });

    const client = createClient("http://localhost:3000", "pqdb_anon_key");
    await client.auth.users.signIn({ email: "user@test.com", password: "pass123" });

    await client
      .from(postsSchema)
      .insert([
        { id: "post-1", title: "Hello" },
        { id: "post-2", title: "World" },
      ])
      .execute();

    const [, insertInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const body = JSON.parse(insertInit.body as string);
    expect(body.rows[0].owner_id).toBe("user-uuid-123");
    expect(body.rows[1].owner_id).toBe("user-uuid-123");
  });
});
