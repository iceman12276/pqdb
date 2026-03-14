import { describe, it, expect } from "vitest";
import {
  transformInsertRows,
  transformSelectResponse,
  transformFilters,
  validateFilterOperations,
} from "../../src/query/crypto-transform.js";
import { deriveKeyPair } from "../../src/crypto/encryption.js";
import { generateHmacKey } from "../../src/crypto/hmac.js";
import { column, defineTableSchema } from "../../src/query/schema.js";
import type { FilterClause } from "../../src/query/types.js";

const usersSchema = defineTableSchema("users", {
  id: column.uuid().primaryKey(),
  email: column.text().sensitive("searchable"),
  name: column.text().sensitive("private"),
  age: column.integer(),
});

describe("transformInsertRows", () => {
  it("maps searchable columns to _encrypted and _index shadow columns", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);

    expect(transformed).toHaveLength(1);
    const row = transformed[0];

    // Original searchable column should be removed
    expect(row).not.toHaveProperty("email");
    // Shadow columns should be present
    expect(row).toHaveProperty("email_encrypted");
    expect(row).toHaveProperty("email_index");
    // email_encrypted should be a base64 string (for JSON serialization)
    expect(typeof row.email_encrypted).toBe("string");
    // email_index should be a hex string (64 chars for SHA3-256)
    expect(row.email_index).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps private columns to _encrypted shadow column only", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);
    const row = transformed[0];

    // Original private column should be removed
    expect(row).not.toHaveProperty("name");
    // Should have encrypted column
    expect(row).toHaveProperty("name_encrypted");
    // Should NOT have index column
    expect(row).not.toHaveProperty("name_index");
    expect(typeof row.name_encrypted).toBe("string");
  });

  it("passes plain columns through unchanged", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);
    const row = transformed[0];

    // Plain columns should pass through
    expect(row.id).toBe("1");
    expect(row.age).toBe(30);
  });

  it("handles multiple rows", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [
      { id: "1", email: "alice@example.com", name: "Alice", age: 30 },
      { id: "2", email: "bob@example.com", name: "Bob", age: 25 },
    ];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);
    expect(transformed).toHaveLength(2);

    // Both should have shadow columns
    for (const row of transformed) {
      expect(row).toHaveProperty("email_encrypted");
      expect(row).toHaveProperty("email_index");
      expect(row).toHaveProperty("name_encrypted");
      expect(row).not.toHaveProperty("email");
      expect(row).not.toHaveProperty("name");
    }
  });

  it("produces deterministic blind indexes for same value", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [
      { id: "1", email: "same@example.com", name: "A", age: 1 },
      { id: "2", email: "same@example.com", name: "B", age: 2 },
    ];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);

    // Same email → same blind index
    expect(transformed[0].email_index).toBe(transformed[1].email_index);
    // But different ciphertexts (randomized encryption)
    expect(transformed[0].email_encrypted).not.toBe(transformed[1].email_encrypted);
  });
});

describe("transformSelectResponse", () => {
  it("decrypts _encrypted columns and maps back to original column names", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    // First, encrypt some data
    const original = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];
    const encrypted = await transformInsertRows(original, usersSchema, kp, hmacKey);

    // Now decrypt it (as if the server returned it)
    const decrypted = await transformSelectResponse(encrypted, usersSchema, kp.secretKey);

    expect(decrypted).toHaveLength(1);
    const row = decrypted[0];

    // Original column names should be restored
    expect(row.email).toBe("alice@example.com");
    expect(row.name).toBe("Alice");
    expect(row.age).toBe(30);
    expect(row.id).toBe("1");

    // Shadow columns should be removed
    expect(row).not.toHaveProperty("email_encrypted");
    expect(row).not.toHaveProperty("email_index");
    expect(row).not.toHaveProperty("name_encrypted");
  });

  it("handles multiple rows", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const original = [
      { id: "1", email: "alice@example.com", name: "Alice", age: 30 },
      { id: "2", email: "bob@example.com", name: "Bob", age: 25 },
    ];

    const encrypted = await transformInsertRows(original, usersSchema, kp, hmacKey);
    const decrypted = await transformSelectResponse(encrypted, usersSchema, kp.secretKey);

    expect(decrypted).toHaveLength(2);
    expect(decrypted[0].email).toBe("alice@example.com");
    expect(decrypted[1].email).toBe("bob@example.com");
  });
});

describe("transformFilters", () => {
  it("rewrites .eq() on searchable column to use _index", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "alice@example.com" },
    ];

    const transformed = transformFilters(filters, usersSchema, hmacKey);

    expect(transformed).toHaveLength(1);
    expect(transformed[0].column).toBe("email_index");
    expect(transformed[0].op).toBe("eq");
    // Value should be a hex hash, not plaintext
    expect(transformed[0].value).toMatch(/^[0-9a-f]{64}$/);
    expect(transformed[0].value).not.toBe("alice@example.com");
  });

  it("rewrites .in() on searchable column to use _index with hashed values", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "email", op: "in", value: ["a@x.com", "b@x.com"] },
    ];

    const transformed = transformFilters(filters, usersSchema, hmacKey);

    expect(transformed).toHaveLength(1);
    expect(transformed[0].column).toBe("email_index");
    expect(transformed[0].op).toBe("in");
    const values = transformed[0].value as string[];
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[0]).not.toBe(values[1]);
  });

  it("passes through filters on plain columns unchanged", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "age", op: "gt", value: 18 },
    ];

    const transformed = transformFilters(filters, usersSchema, hmacKey);

    expect(transformed).toEqual([{ column: "age", op: "gt", value: 18 }]);
  });

  it("produces deterministic hashes for filter values", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "alice@example.com" },
    ];

    const t1 = transformFilters(filters, usersSchema, hmacKey);
    const t2 = transformFilters(filters, usersSchema, hmacKey);

    expect(t1[0].value).toBe(t2[0].value);
  });
});

describe("validateFilterOperations", () => {
  it("allows .eq() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).not.toThrow();
  });

  it("allows .in() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "in", value: ["a", "b"] },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).not.toThrow();
  });

  it("rejects .gt() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "gt", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).toThrow(
      /Range queries not supported on encrypted columns/,
    );
  });

  it("rejects .lt() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "lt", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).toThrow(
      /Range queries not supported on encrypted columns/,
    );
  });

  it("rejects .gte() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "gte", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).toThrow(
      /Range queries not supported on encrypted columns/,
    );
  });

  it("rejects .lte() on searchable columns", () => {
    const filters: FilterClause[] = [
      { column: "email", op: "lte", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).toThrow(
      /Range queries not supported on encrypted columns/,
    );
  });

  it("rejects any filter on private columns", () => {
    const filters: FilterClause[] = [
      { column: "name", op: "eq", value: "test" },
    ];

    expect(() => validateFilterOperations(filters, usersSchema)).toThrow(
      /Cannot filter on private column/,
    );
  });

  it("allows all operations on plain columns", () => {
    const ops: FilterClause[] = [
      { column: "age", op: "eq", value: 1 },
      { column: "age", op: "gt", value: 1 },
      { column: "age", op: "lt", value: 1 },
      { column: "age", op: "gte", value: 1 },
      { column: "age", op: "lte", value: 1 },
      { column: "age", op: "in", value: [1, 2] },
    ];

    expect(() => validateFilterOperations(ops, usersSchema)).not.toThrow();
  });
});
