/**
 * Recovery file discovery and private key loading (US-010).
 *
 * Discovers the developer's recovery file from well-known locations
 * and extracts the ML-KEM-768 private key for use in the crypto proxy.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ML_KEM_768_SECRET_KEY_BYTES } from "../config.js";

/**
 * Discover the recovery file path using the following priority order:
 *
 * 1. Explicit path (e.g. from --recovery-file flag)
 * 2. ~/.pqdb/recovery.json
 * 3. Most recent ~/Downloads/pqdb-recovery-*.json (by mtime)
 *
 * @throws Error if no recovery file is found, listing all locations checked.
 */
export function discoverRecoveryFile(explicitPath?: string): string {
  if (explicitPath !== undefined) {
    if (!fs.existsSync(explicitPath)) {
      throw new Error(
        `Recovery file not found at specified path: ${explicitPath}`,
      );
    }
    return explicitPath;
  }

  const home = os.homedir();

  // Priority 2: ~/.pqdb/recovery.json
  const pqdbPath = path.join(home, ".pqdb", "recovery.json");
  if (fs.existsSync(pqdbPath)) {
    return pqdbPath;
  }

  // Priority 3: most recent ~/Downloads/pqdb-recovery-*.json
  const downloadsDir = path.join(home, "Downloads");
  if (fs.existsSync(downloadsDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(downloadsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const recoveryFiles: { filePath: string; mtime: number }[] = [];
    for (const entry of entries) {
      if (
        entry.isFile() &&
        entry.name.startsWith("pqdb-recovery-") &&
        entry.name.endsWith(".json")
      ) {
        const filePath = path.join(downloadsDir, entry.name);
        const stat = fs.statSync(filePath);
        recoveryFiles.push({ filePath, mtime: stat.mtimeMs });
      }
    }

    if (recoveryFiles.length > 0) {
      // Sort descending by mtime — most recent first
      recoveryFiles.sort((a, b) => b.mtime - a.mtime);
      return recoveryFiles[0].filePath;
    }
  }

  throw new Error(
    "No recovery file found. Checked the following locations:\n" +
      "  1. ~/.pqdb/recovery.json\n" +
      "  2. ~/Downloads/pqdb-recovery-*.json\n\n" +
      "To fix this, save your recovery file to ~/.pqdb/recovery.json\n" +
      "or pass --recovery-file <path> to specify the location explicitly.",
  );
}

/**
 * Load and validate the ML-KEM-768 private key from a recovery file.
 *
 * The recovery file is JSON with at least a `private_key` field containing
 * a base64-encoded ML-KEM-768 secret key (exactly 2400 bytes when decoded).
 *
 * @throws Error with a clear message on invalid JSON, missing field, or wrong key length.
 */
export function loadPrivateKeyFromRecovery(filePath: string): Uint8Array {
  const raw = fs.readFileSync(filePath, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Recovery file is not valid JSON");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("private_key" in parsed) ||
    typeof (parsed as Record<string, unknown>).private_key !== "string"
  ) {
    throw new Error("Recovery file missing private_key field");
  }

  const privateKeyB64 = (parsed as Record<string, unknown>).private_key as string;

  // Decode base64 to bytes
  const buf = Buffer.from(privateKeyB64, "base64");
  const decoded = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

  if (decoded.length !== ML_KEM_768_SECRET_KEY_BYTES) {
    throw new Error(
      `Private key must be exactly ${ML_KEM_768_SECRET_KEY_BYTES} bytes (ML-KEM-768), got ${decoded.length}`,
    );
  }

  return decoded;
}
