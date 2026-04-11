import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  discoverRecoveryFile,
  loadPrivateKeyFromRecovery,
} from "../../src/proxy/recovery.js";

/** Generate a valid base64-encoded key of the given byte length. */
function makeKeyBase64(length: number): string {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = i % 256;
  }
  return Buffer.from(bytes).toString("base64");
}

/** ML-KEM-768 secret key is exactly 2400 bytes. */
const VALID_KEY_B64 = makeKeyBase64(2400);

function makeRecoveryJson(overrides: Record<string, unknown> = {}): string {
  const doc = {
    version: 1,
    developer_id: "dev_123",
    email: "dev@example.com",
    public_key: "pubkey-placeholder",
    private_key: VALID_KEY_B64,
    created_at: "2026-01-01T00:00:00Z",
    warning: "Keep this file safe",
    ...overrides,
  };
  return JSON.stringify(doc);
}

describe("loadPrivateKeyFromRecovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pqdb-recovery-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid recovery file and returns 2400-byte Uint8Array", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    fs.writeFileSync(filePath, makeRecoveryJson());

    const key = loadPrivateKeyFromRecovery(filePath);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(2400);
    // Verify first few bytes match what we encoded
    expect(key[0]).toBe(0);
    expect(key[1]).toBe(1);
    expect(key[255]).toBe(255);
  });

  it("rejects invalid JSON with clear error", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    fs.writeFileSync(filePath, "not { valid json!!!");

    expect(() => loadPrivateKeyFromRecovery(filePath)).toThrow(
      "Recovery file is not valid JSON",
    );
  });

  it("rejects missing private_key field with clear error", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, email: "dev@example.com" }),
    );

    expect(() => loadPrivateKeyFromRecovery(filePath)).toThrow(
      "Recovery file missing private_key field",
    );
  });

  it("rejects wrong key length with clear error showing actual length", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    const wrongKey = makeKeyBase64(100);
    fs.writeFileSync(filePath, makeRecoveryJson({ private_key: wrongKey }));

    expect(() => loadPrivateKeyFromRecovery(filePath)).toThrow(
      "Private key must be exactly 2400 bytes (ML-KEM-768), got 100",
    );
  });

  it("rejects oversized key with clear error", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    const bigKey = makeKeyBase64(5000);
    fs.writeFileSync(filePath, makeRecoveryJson({ private_key: bigKey }));

    expect(() => loadPrivateKeyFromRecovery(filePath)).toThrow(
      "Private key must be exactly 2400 bytes (ML-KEM-768), got 5000",
    );
  });

  it("rejects non-string private_key field", () => {
    const filePath = path.join(tmpDir, "recovery.json");
    fs.writeFileSync(
      filePath,
      makeRecoveryJson({ private_key: 12345 }),
    );

    expect(() => loadPrivateKeyFromRecovery(filePath)).toThrow(
      "Recovery file missing private_key field",
    );
  });

  it("throws when file does not exist", () => {
    const missingPath = path.join(tmpDir, "nonexistent.json");
    expect(() => loadPrivateKeyFromRecovery(missingPath)).toThrow();
  });
});

describe("discoverRecoveryFile", () => {
  let tmpDir: string;
  let fakePqdbDir: string;
  let fakeDownloadsDir: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pqdb-discover-test-"));
    // Create fake ~/.pqdb and ~/Downloads
    fakePqdbDir = path.join(tmpDir, ".pqdb");
    fakeDownloadsDir = path.join(tmpDir, "Downloads");
    fs.mkdirSync(fakePqdbDir, { recursive: true });
    fs.mkdirSync(fakeDownloadsDir, { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns explicit path when provided and file exists", () => {
    const explicitPath = path.join(tmpDir, "my-recovery.json");
    fs.writeFileSync(explicitPath, makeRecoveryJson());

    const result = discoverRecoveryFile(explicitPath);
    expect(result).toBe(explicitPath);
  });

  it("throws when explicit path is provided but file does not exist", () => {
    const missingPath = path.join(tmpDir, "missing.json");
    expect(() => discoverRecoveryFile(missingPath)).toThrow(missingPath);
  });

  it("discovers ~/.pqdb/recovery.json as second priority", () => {
    const pqdbFile = path.join(fakePqdbDir, "recovery.json");
    fs.writeFileSync(pqdbFile, makeRecoveryJson());

    const result = discoverRecoveryFile();
    expect(result).toBe(pqdbFile);
  });

  it("discovers most recent ~/Downloads/pqdb-recovery-*.json by mtime", () => {
    // Create two recovery files with different mtimes
    const older = path.join(fakeDownloadsDir, "pqdb-recovery-2026-01-01.json");
    const newer = path.join(fakeDownloadsDir, "pqdb-recovery-2026-04-10.json");
    fs.writeFileSync(older, makeRecoveryJson());
    fs.writeFileSync(newer, makeRecoveryJson());

    // Set mtimes explicitly: newer file should win
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-04-10T00:00:00Z");
    fs.utimesSync(older, oldTime, oldTime);
    fs.utimesSync(newer, newTime, newTime);

    const result = discoverRecoveryFile();
    expect(result).toBe(newer);
  });

  it("prefers ~/.pqdb/recovery.json over ~/Downloads glob", () => {
    const pqdbFile = path.join(fakePqdbDir, "recovery.json");
    fs.writeFileSync(pqdbFile, makeRecoveryJson());

    const dlFile = path.join(fakeDownloadsDir, "pqdb-recovery-2026-04-10.json");
    fs.writeFileSync(dlFile, makeRecoveryJson());

    const result = discoverRecoveryFile();
    expect(result).toBe(pqdbFile);
  });

  it("skips non-matching files in ~/Downloads", () => {
    // Files that don't match the pattern should be ignored
    fs.writeFileSync(
      path.join(fakeDownloadsDir, "some-other-file.json"),
      makeRecoveryJson(),
    );
    fs.writeFileSync(
      path.join(fakeDownloadsDir, "pqdb-something-else.json"),
      makeRecoveryJson(),
    );

    expect(() => discoverRecoveryFile()).toThrow(/No recovery file found/);
  });

  it("throws with helpful error listing all locations when no file is found", () => {
    // Empty — no recovery files anywhere
    try {
      discoverRecoveryFile();
      expect.unreachable("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/No recovery file found/);
      expect(msg).toMatch(/~\/\.pqdb\/recovery\.json/);
      expect(msg).toMatch(/~\/Downloads\/pqdb-recovery-\*\.json/);
    }
  });
});
