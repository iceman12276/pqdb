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

  it("throws on invalid transport", () => {
    expect(() => parseArgs(["--transport", "grpc"])).toThrow(
      'Invalid transport: grpc. Must be "stdio" or "sse".',
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
});
