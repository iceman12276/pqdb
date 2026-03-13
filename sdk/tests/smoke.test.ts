import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("@pqdb/client", () => {
  it("exports a version string", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("version is a non-empty string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION.length).toBeGreaterThan(0);
  });
});
