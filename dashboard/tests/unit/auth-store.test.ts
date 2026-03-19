import { describe, it, expect, beforeEach } from "vitest";
import {
  getTokens,
  setTokens,
  clearTokens,
  getAccessToken,
} from "~/lib/auth-store";

describe("auth-store", () => {
  beforeEach(() => {
    clearTokens();
    sessionStorage.clear();
  });

  it("returns null when no tokens are stored", () => {
    expect(getTokens()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("stores and retrieves tokens in memory", () => {
    setTokens({ access_token: "at", refresh_token: "rt" });
    expect(getTokens()).toEqual({
      access_token: "at",
      refresh_token: "rt",
    });
    expect(getAccessToken()).toBe("at");
  });

  it("clears tokens from memory", () => {
    setTokens({ access_token: "at", refresh_token: "rt" });
    clearTokens();
    expect(getTokens()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("persists tokens to sessionStorage when persist option is true", () => {
    setTokens({ access_token: "at", refresh_token: "rt" }, { persist: true });
    expect(sessionStorage.getItem("pqdb-tokens")).toBe(
      JSON.stringify({ access_token: "at", refresh_token: "rt" }),
    );
  });

  it("restores tokens from sessionStorage on first read", () => {
    // First clear everything, then manually set sessionStorage
    // (simulating: user had persisted tokens, page reloaded, memory is empty)
    clearTokens();
    sessionStorage.setItem(
      "pqdb-tokens",
      JSON.stringify({ access_token: "at", refresh_token: "rt" }),
    );
    expect(getTokens()).toEqual({
      access_token: "at",
      refresh_token: "rt",
    });
  });

  it("clears sessionStorage when clearTokens is called", () => {
    setTokens({ access_token: "at", refresh_token: "rt" }, { persist: true });
    clearTokens();
    expect(sessionStorage.getItem("pqdb-tokens")).toBeNull();
  });
});
