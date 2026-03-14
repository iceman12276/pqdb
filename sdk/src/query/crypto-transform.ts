/**
 * Crypto transform layer — maps between developer-facing column names
 * and physical shadow columns for encrypted data.
 *
 * Handles:
 * - INSERT: encrypt values, produce shadow columns, compute blind indexes
 * - SELECT response: decrypt shadow columns, restore original column names
 * - Filters: rewrite column references and hash values for blind index lookup
 * - Validation: reject unsupported operations on encrypted columns
 */
import { encrypt, decrypt } from "../crypto/encryption.js";
import { computeBlindIndex } from "../crypto/blind-index.js";
import type { KeyPair } from "../crypto/pqc.js";
import type { TableSchema, SchemaColumns } from "./schema.js";
import type { FilterClause } from "./types.js";

/** Encode binary ciphertext as base64 for JSON transport. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Decode base64 string back to Uint8Array. */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Transform insert rows: encrypt sensitive columns, produce shadow columns.
 *
 * For each row:
 * - searchable columns → {col}_encrypted (base64) + {col}_index (hex hash)
 * - private columns → {col}_encrypted (base64)
 * - plain columns → pass through unchanged
 */
export async function transformInsertRows<S extends SchemaColumns>(
  rows: Record<string, unknown>[],
  schema: TableSchema<S>,
  keyPair: KeyPair,
  hmacKey: Uint8Array,
): Promise<Record<string, unknown>[]> {
  return Promise.all(
    rows.map(async (row) => {
      const transformed: Record<string, unknown> = {};

      for (const [colName, value] of Object.entries(row)) {
        const colDef = schema.columns[colName];

        if (!colDef || colDef.sensitivity === "plain") {
          transformed[colName] = value;
          continue;
        }

        const plaintext = String(value);
        const ciphertext = await encrypt(plaintext, keyPair.publicKey);
        // Send the logical column name — the backend maps to {col}_encrypted
        transformed[colName] = toBase64(ciphertext);

        if (colDef.sensitivity === "searchable") {
          transformed[`${colName}_index`] = computeBlindIndex(plaintext, hmacKey);
        }
      }

      return transformed;
    }),
  );
}

/**
 * Transform select response: decrypt shadow columns, restore original names.
 *
 * For each row in the response:
 * - {col}_encrypted → decrypt → set as {col}
 * - {col}_index → remove (not needed on client)
 * - plain columns → pass through unchanged
 */
export async function transformSelectResponse<S extends SchemaColumns>(
  rows: Record<string, unknown>[],
  schema: TableSchema<S>,
  secretKey: Uint8Array,
): Promise<Record<string, unknown>[]> {
  // Build a set of encrypted column base names for quick lookup
  const sensitiveColumns = new Map<string, "searchable" | "private">();
  for (const [colName, colDef] of Object.entries(schema.columns)) {
    if (colDef.sensitivity === "searchable" || colDef.sensitivity === "private") {
      sensitiveColumns.set(colName, colDef.sensitivity);
    }
  }

  return Promise.all(
    rows.map(async (row) => {
      const transformed: Record<string, unknown> = {};

      // First pass: copy all non-shadow columns
      for (const [key, value] of Object.entries(row)) {
        if (key.endsWith("_encrypted") || key.endsWith("_index")) {
          // Check if this is a known shadow column
          const baseName = key.endsWith("_encrypted")
            ? key.slice(0, -"_encrypted".length)
            : key.slice(0, -"_index".length);

          if (sensitiveColumns.has(baseName)) {
            continue; // Skip shadow columns — handled below
          }
        }
        transformed[key] = value;
      }

      // Second pass: decrypt _encrypted columns
      for (const [colName] of sensitiveColumns) {
        const encryptedKey = `${colName}_encrypted`;
        const encryptedValue = row[encryptedKey];

        if (encryptedValue !== undefined) {
          const ciphertext = fromBase64(encryptedValue as string);
          transformed[colName] = await decrypt(ciphertext, secretKey);
        }
      }

      return transformed;
    }),
  );
}

/**
 * Transform filters: rewrite column references for shadow columns
 * and hash values for blind index lookup.
 *
 * - searchable + eq/in → column becomes {col}_index, value becomes HMAC hash
 * - plain → pass through unchanged
 */
export function transformFilters<S extends SchemaColumns>(
  filters: FilterClause[],
  schema: TableSchema<S>,
  hmacKey: Uint8Array,
): FilterClause[] {
  return filters.map((filter) => {
    const colDef = schema.columns[filter.column];
    if (!colDef || colDef.sensitivity === "plain") {
      return filter;
    }

    // For searchable columns with eq/in, rewrite to use _index
    if (filter.op === "eq") {
      return {
        column: `${filter.column}_index`,
        op: "eq",
        value: computeBlindIndex(String(filter.value), hmacKey),
      };
    }

    if (filter.op === "in") {
      const values = filter.value as unknown[];
      return {
        column: `${filter.column}_index`,
        op: "in",
        value: values.map((v) => computeBlindIndex(String(v), hmacKey)),
      };
    }

    // Should not reach here if validateFilterOperations is called first
    return filter;
  });
}

/** Allowed filter operations for searchable columns. */
const SEARCHABLE_ALLOWED_OPS = new Set(["eq", "in"]);

/**
 * Validate that filter operations are supported for their column sensitivity.
 *
 * Throws if:
 * - Range queries (gt, lt, gte, lte) are used on searchable columns
 * - Any filter is used on private columns
 */
export function validateFilterOperations<S extends SchemaColumns>(
  filters: FilterClause[],
  schema: TableSchema<S>,
): void {
  for (const filter of filters) {
    const colDef = schema.columns[filter.column];
    if (!colDef) continue;

    if (colDef.sensitivity === "private") {
      throw new Error(
        `Cannot filter on private column "${filter.column}". ` +
          `Private columns are encrypted without a blind index and cannot be queried.`,
      );
    }

    if (
      colDef.sensitivity === "searchable" &&
      !SEARCHABLE_ALLOWED_OPS.has(filter.op)
    ) {
      throw new Error(
        `Range queries not supported on encrypted columns. ` +
          `Column "${filter.column}" is searchable — only .eq() and .in() are supported.`,
      );
    }
  }
}
