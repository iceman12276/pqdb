import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseArgs, buildConfig } from "../../src/config.js";

describe("parseArgs", () => {
  it("returns defaults when no args provided", () => {
    const result = parseArgs([]);
    expect(result).toEqual({
      projectUrl: undefined,
      transport: "stdio",
      port: 3001,
    });
  });

  it("parses --project-url", () => {
    const result = parseArgs(["--project-url", "http://localhost:8000"]);
    expect(result.projectUrl).toBe("http://localhost:8000");
  });

  it("parses --transport stdio", () => {
    const result = parseArgs(["--transport", "stdio"]);
    expect(result.transport).toBe("stdio");
  });

  it("parses --transport sse", () => {
    const result = parseArgs(["--transport", "sse"]);
    expect(result.transport).toBe("sse");
  });

  it("parses --transport http", () => {
    const result = parseArgs(["--transport", "http"]);
    expect(result.transport).toBe("http");
  });

  it("throws on invalid transport", () => {
    expect(() => parseArgs(["--transport", "grpc"])).toThrow(
      'Invalid transport: grpc. Must be "stdio", "sse", or "http".',
    );
  });

  it("parses --port", () => {
    const result = parseArgs(["--port", "4000"]);
    expect(result.port).toBe(4000);
  });

  it("throws on invalid port", () => {
    expect(() => parseArgs(["--port", "99999"])).toThrow("Invalid port");
  });

  it("parses all args together", () => {
    const result = parseArgs([
      "--project-url",
      "http://api.example.com",
      "--transport",
      "sse",
      "--port",
      "5000",
    ]);
    expect(result).toEqual({
      projectUrl: "http://api.example.com",
      transport: "sse",
      port: 5000,
    });
  });

  it("parses https:// project URL", () => {
    const result = parseArgs(["--project-url", "https://localhost"]);
    expect(result.projectUrl).toBe("https://localhost");
  });
});

describe("buildConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when PQDB_API_KEY is missing", () => {
    delete process.env.PQDB_API_KEY;
    expect(() =>
      buildConfig({ projectUrl: "http://localhost:8000", transport: "stdio", port: 3001 }),
    ).toThrow("PQDB_API_KEY environment variable is required.");
  });

  it("throws when project URL is missing from both args and env", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    expect(() =>
      buildConfig({ projectUrl: undefined, transport: "stdio", port: 3001 }),
    ).toThrow("Project URL is required");
  });

  it("uses CLI --project-url over env var", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    process.env.PQDB_PROJECT_URL = "http://env-url.com";
    const config = buildConfig({
      projectUrl: "http://cli-url.com",
      transport: "stdio",
      port: 3001,
    });
    expect(config.projectUrl).toBe("http://cli-url.com");
  });

  it("falls back to PQDB_PROJECT_URL env var", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    process.env.PQDB_PROJECT_URL = "http://env-url.com";
    const config = buildConfig({
      projectUrl: undefined,
      transport: "stdio",
      port: 3001,
    });
    expect(config.projectUrl).toBe("http://env-url.com");
  });

  it("includes encryptionKey when PQDB_ENCRYPTION_KEY is set", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    process.env.PQDB_ENCRYPTION_KEY = "my-secret-key";
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
    });
    expect(config.encryptionKey).toBe("my-secret-key");
  });

  it("encryptionKey is undefined when PQDB_ENCRYPTION_KEY is not set", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    delete process.env.PQDB_ENCRYPTION_KEY;
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
    });
    expect(config.encryptionKey).toBeUndefined();
  });

  it("builds complete config from args + env", () => {
    process.env.PQDB_API_KEY = "pqdb_service_key456";
    process.env.PQDB_ENCRYPTION_KEY = "enc-key";
    delete process.env.PQDB_PRIVATE_KEY;
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "sse",
      port: 4000,
    });
    expect(config).toEqual({
      projectUrl: "http://localhost:8000",
      transport: "sse",
      port: 4000,
      apiKey: "pqdb_service_key456",
      encryptionKey: "enc-key",
      devToken: undefined,
      projectId: undefined,
      privateKey: undefined,
    });
  });

  it("includes devToken when PQDB_DEV_TOKEN is set", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    process.env.PQDB_DEV_TOKEN = "my-jwt-token";
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
    });
    expect(config.devToken).toBe("my-jwt-token");
  });

  it("devToken is undefined when PQDB_DEV_TOKEN is not set", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    delete process.env.PQDB_DEV_TOKEN;
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "stdio",
      port: 3001,
    });
    expect(config.devToken).toBeUndefined();
  });

  it("allows missing PQDB_API_KEY for http transport", () => {
    delete process.env.PQDB_API_KEY;
    const config = buildConfig({
      projectUrl: "http://localhost:8000",
      transport: "http",
      port: 3002,
    });
    expect(config.apiKey).toBe("");
  });

  it("still requires PQDB_API_KEY for stdio transport", () => {
    delete process.env.PQDB_API_KEY;
    expect(() =>
      buildConfig({ projectUrl: "http://localhost:8000", transport: "stdio", port: 3001 }),
    ).toThrow("PQDB_API_KEY environment variable is required.");
  });

  it("accepts https:// project URLs", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    const config = buildConfig({
      projectUrl: "https://localhost",
      transport: "stdio",
      port: 3001,
    });
    expect(config.projectUrl).toBe("https://localhost");
  });

  it("accepts https:// project URL from env var", () => {
    process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
    process.env.PQDB_PROJECT_URL = "https://localhost";
    const config = buildConfig({
      projectUrl: undefined,
      transport: "stdio",
      port: 3001,
    });
    expect(config.projectUrl).toBe("https://localhost");
  });

  // ── PQDB_PRIVATE_KEY (US-008) ─────────────────────────────────────────

  describe("PQDB_PRIVATE_KEY parsing", () => {
    // ML-KEM-768 secret key = 2400 bytes
    const VALID_KEY_SIZE = 2400;

    function makeKeyBase64(length: number): string {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = i % 256;
      }
      return Buffer.from(bytes).toString("base64");
    }

    function makeKeyBase64Url(length: number): string {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = i % 256;
      }
      return Buffer.from(bytes).toString("base64url");
    }

    it("privateKey is undefined when PQDB_PRIVATE_KEY is not set", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      delete process.env.PQDB_PRIVATE_KEY;
      const config = buildConfig({
        projectUrl: "http://localhost:8000",
        transport: "stdio",
        port: 3001,
      });
      expect(config.privateKey).toBeUndefined();
    });

    it("decodes a valid standard base64 PQDB_PRIVATE_KEY into a Uint8Array of 2400 bytes", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      process.env.PQDB_PRIVATE_KEY = makeKeyBase64(VALID_KEY_SIZE);
      const config = buildConfig({
        projectUrl: "http://localhost:8000",
        transport: "stdio",
        port: 3001,
      });
      expect(config.privateKey).toBeInstanceOf(Uint8Array);
      expect(config.privateKey!.length).toBe(VALID_KEY_SIZE);
      // Verify round-trip: first byte should be 0, second 1, ...
      expect(config.privateKey![0]).toBe(0);
      expect(config.privateKey![1]).toBe(1);
      expect(config.privateKey![255]).toBe(255);
    });

    it("decodes a valid base64url PQDB_PRIVATE_KEY into a Uint8Array of 2400 bytes", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      process.env.PQDB_PRIVATE_KEY = makeKeyBase64Url(VALID_KEY_SIZE);
      const config = buildConfig({
        projectUrl: "http://localhost:8000",
        transport: "stdio",
        port: 3001,
      });
      expect(config.privateKey).toBeInstanceOf(Uint8Array);
      expect(config.privateKey!.length).toBe(VALID_KEY_SIZE);
      expect(config.privateKey![0]).toBe(0);
      expect(config.privateKey![1]).toBe(1);
    });

    it("throws a clear error when PQDB_PRIVATE_KEY decodes to the wrong length", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      process.env.PQDB_PRIVATE_KEY = makeKeyBase64(100); // too small
      expect(() =>
        buildConfig({
          projectUrl: "http://localhost:8000",
          transport: "stdio",
          port: 3001,
        }),
      ).toThrow(/PQDB_PRIVATE_KEY.*2400/);
    });

    it("throws a clear error when PQDB_PRIVATE_KEY is not valid base64", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      process.env.PQDB_PRIVATE_KEY = "!!!not valid base64!!!";
      expect(() =>
        buildConfig({
          projectUrl: "http://localhost:8000",
          transport: "stdio",
          port: 3001,
        }),
      ).toThrow(/PQDB_PRIVATE_KEY/);
    });

    it("rejects an oversized PQDB_PRIVATE_KEY with a clear error", () => {
      process.env.PQDB_API_KEY = "pqdb_anon_testkey123";
      process.env.PQDB_PRIVATE_KEY = makeKeyBase64(5000);
      expect(() =>
        buildConfig({
          projectUrl: "http://localhost:8000",
          transport: "stdio",
          port: 3001,
        }),
      ).toThrow(/PQDB_PRIVATE_KEY/);
    });
  });
});
