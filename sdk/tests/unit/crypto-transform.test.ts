import { describe, it, expect } from "vitest";
import {
  transformInsertRows,
  transformSelectResponse,
  transformFilters,
  transformFiltersMultiVersion,
  validateFilterOperations,
} from "../../src/query/crypto-transform.js";
import { deriveKeyPair, encrypt } from "../../src/crypto/encryption.js";
import { computeBlindIndex } from "../../src/crypto/blind-index.js";
import { generateHmacKey } from "../../src/crypto/hmac.js";
import { column, defineTableSchema } from "../../src/query/schema.js";
import type { FilterClause } from "../../src/query/types.js";
import type { VersionedHmacKeys } from "../../src/crypto/blind-index.js";

/** Encode binary ciphertext as base64. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const usersSchema = defineTableSchema("users", {
  id: column.uuid().primaryKey(),
  email: column.text().sensitive("searchable"),
  name: column.text().sensitive("private"),
  age: column.integer(),
});

describe("transformInsertRows", () => {
  it("sends searchable columns under the logical name plus _index", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);

    expect(transformed).toHaveLength(1);
    const row = transformed[0];

    // Logical column name contains the ciphertext (backend maps to _encrypted)
    expect(row).toHaveProperty("email");
    expect(typeof row.email).toBe("string");
    expect(row.email).not.toBe("alice@example.com"); // encrypted, not plaintext
    // Blind index column is sent directly
    expect(row).toHaveProperty("email_index");
    // email_index should be a hex string (64 chars for SHA3-256)
    expect(row.email_index).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends private columns under the logical name only", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);
    const row = transformed[0];

    // Logical column name contains the ciphertext (backend maps to _encrypted)
    expect(row).toHaveProperty("name");
    expect(typeof row.name).toBe("string");
    expect(row.name).not.toBe("Alice"); // encrypted, not plaintext
    // Should NOT have index column for private
    expect(row).not.toHaveProperty("name_index");
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

    // Both should have logical column names (ciphertext) and _index
    for (const row of transformed) {
      expect(row).toHaveProperty("email"); // ciphertext under logical name
      expect(row).toHaveProperty("email_index");
      expect(row).toHaveProperty("name"); // ciphertext under logical name
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
    expect(transformed[0].email).not.toBe(transformed[1].email);
  });
});

describe("transformSelectResponse", () => {
  it("decrypts _encrypted columns and maps back to original column names", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    // Simulate server response: backend returns _encrypted and _index columns
    const emailCt = await encrypt("alice@example.com", kp.publicKey);
    const nameCt = await encrypt("Alice", kp.publicKey);
    const serverResponse = [
      {
        id: "1",
        email_encrypted: toBase64(emailCt),
        email_index: computeBlindIndex("alice@example.com", hmacKey),
        name_encrypted: toBase64(nameCt),
        age: 30,
      },
    ];

    const decrypted = await transformSelectResponse(serverResponse, usersSchema, kp.secretKey);

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

    // Simulate server responses
    const aliceEmailCt = await encrypt("alice@example.com", kp.publicKey);
    const bobEmailCt = await encrypt("bob@example.com", kp.publicKey);
    const aliceNameCt = await encrypt("Alice", kp.publicKey);
    const bobNameCt = await encrypt("Bob", kp.publicKey);

    const serverResponse = [
      {
        id: "1",
        email_encrypted: toBase64(aliceEmailCt),
        email_index: computeBlindIndex("alice@example.com", hmacKey),
        name_encrypted: toBase64(aliceNameCt),
        age: 30,
      },
      {
        id: "2",
        email_encrypted: toBase64(bobEmailCt),
        email_index: computeBlindIndex("bob@example.com", hmacKey),
        name_encrypted: toBase64(bobNameCt),
        age: 25,
      },
    ];

    const decrypted = await transformSelectResponse(serverResponse, usersSchema, kp.secretKey);

    expect(decrypted).toHaveLength(2);
    expect(decrypted[0].email).toBe("alice@example.com");
    expect(decrypted[1].email).toBe("bob@example.com");
  });
});

describe("transformFilters", () => {
  it("hashes .eq() values on searchable columns for blind index lookup", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "alice@example.com" },
    ];

    const transformed = transformFilters(filters, usersSchema, hmacKey);

    expect(transformed).toHaveLength(1);
    // Column name stays logical — backend maps to _index
    expect(transformed[0].column).toBe("email");
    expect(transformed[0].op).toBe("eq");
    // Value should be a hex hash, not plaintext
    expect(transformed[0].value).toMatch(/^[0-9a-f]{64}$/);
    expect(transformed[0].value).not.toBe("alice@example.com");
  });

  it("hashes .in() values on searchable columns for blind index lookup", () => {
    const hmacKey = generateHmacKey();
    const filters: FilterClause[] = [
      { column: "email", op: "in", value: ["a@x.com", "b@x.com"] },
    ];

    const transformed = transformFilters(filters, usersSchema, hmacKey);

    expect(transformed).toHaveLength(1);
    // Column name stays logical — backend maps to _index
    expect(transformed[0].column).toBe("email");
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

describe("transformInsertRows with version-prefixed indexes", () => {
  it("produces version-prefixed blind indexes when version is provided", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey, 2);

    const row = transformed[0];
    expect(row.email_index).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("produces unversioned blind indexes when no version is provided", async () => {
    const kp = await deriveKeyPair("test-key");
    const hmacKey = generateHmacKey();

    const rows = [{ id: "1", email: "alice@example.com", name: "Alice", age: 30 }];

    const transformed = await transformInsertRows(rows, usersSchema, kp, hmacKey);

    const row = transformed[0];
    expect(row.email_index).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("transformFiltersMultiVersion", () => {
  it("generates IN clause with all versions for .eq() on searchable columns", () => {
    const key1 = generateHmacKey();
    const key2 = generateHmacKey();
    const versionedKeys: VersionedHmacKeys = {
      currentVersion: 2,
      keys: {
        "1": key1,
        "2": key2,
      },
    };

    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "alice@example.com" },
    ];

    const transformed = transformFiltersMultiVersion(filters, usersSchema, versionedKeys);

    expect(transformed).toHaveLength(1);
    // Should be converted to an "in" filter with all version hashes
    expect(transformed[0].column).toBe("email");
    expect(transformed[0].op).toBe("in");
    const values = transformed[0].value as string[];
    expect(values).toHaveLength(2);
    expect(values[0]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(values[1]).toMatch(/^v2:[0-9a-f]{64}$/);
  });

  it("generates IN clause with all versions for .in() on searchable columns", () => {
    const key1 = generateHmacKey();
    const key2 = generateHmacKey();
    const versionedKeys: VersionedHmacKeys = {
      currentVersion: 2,
      keys: {
        "1": key1,
        "2": key2,
      },
    };

    const filters: FilterClause[] = [
      { column: "email", op: "in", value: ["alice@example.com", "bob@example.com"] },
    ];

    const transformed = transformFiltersMultiVersion(filters, usersSchema, versionedKeys);

    expect(transformed).toHaveLength(1);
    expect(transformed[0].op).toBe("in");
    const values = transformed[0].value as string[];
    // 2 values * 2 versions = 4 hashes
    expect(values).toHaveLength(4);
    values.forEach((v) => expect(v).toMatch(/^v[12]:[0-9a-f]{64}$/));
  });

  it("passes through plain column filters unchanged", () => {
    const key1 = generateHmacKey();
    const versionedKeys: VersionedHmacKeys = {
      currentVersion: 1,
      keys: { "1": key1 },
    };

    const filters: FilterClause[] = [
      { column: "age", op: "gt", value: 18 },
    ];

    const transformed = transformFiltersMultiVersion(filters, usersSchema, versionedKeys);
    expect(transformed).toEqual([{ column: "age", op: "gt", value: 18 }]);
  });

  it("handles single version (no expansion needed beyond prefix)", () => {
    const key1 = generateHmacKey();
    const versionedKeys: VersionedHmacKeys = {
      currentVersion: 1,
      keys: { "1": key1 },
    };

    const filters: FilterClause[] = [
      { column: "email", op: "eq", value: "alice@example.com" },
    ];

    const transformed = transformFiltersMultiVersion(filters, usersSchema, versionedKeys);

    expect(transformed).toHaveLength(1);
    expect(transformed[0].op).toBe("in");
    const values = transformed[0].value as string[];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatch(/^v1:[0-9a-f]{64}$/);
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
