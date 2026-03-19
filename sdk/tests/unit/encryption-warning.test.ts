import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient } from "../../src/client/index.js";

describe("createClient encryption key warning", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("logs a warning when encryptionKey is provided", () => {
    createClient("http://localhost:3000", "pqdb_anon_abc123", {
      encryptionKey: "my-secret-key",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("encryption key"),
    );
  });

  it("warning includes backup responsibility message", () => {
    createClient("http://localhost:3000", "pqdb_anon_abc123", {
      encryptionKey: "my-secret-key",
    });

    const message = warnSpy.mock.calls[0][0] as string;
    expect(message).toMatch(/never sent to the server/i);
    expect(message).toMatch(/unrecoverable/i);
    expect(message).toMatch(/store.*securely/i);
  });

  it("does NOT log a warning when no encryptionKey is provided", () => {
    createClient("http://localhost:3000", "pqdb_anon_abc123");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("only logs warning once per client instance, not on every from() call", () => {
    const client = createClient("http://localhost:3000", "pqdb_anon_abc123", {
      encryptionKey: "my-secret-key",
    });

    // The warning fires at creation time, not on from() calls
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Multiple defineTable/from calls should not trigger additional warnings
    const schema = client.defineTable("test", {
      id: { type: "plain" },
    });
    client.from(schema);
    client.from(schema);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
