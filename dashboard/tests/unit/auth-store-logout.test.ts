import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearTokens, setTokens, onLogout } from "~/lib/auth-store";

describe("auth-store onLogout", () => {
  beforeEach(() => {
    // Reset state
    clearTokens();
  });

  it("calls registered logout callbacks when clearTokens is called", () => {
    const callback = vi.fn();
    onLogout(callback);

    setTokens(
      { access_token: "test", refresh_token: "test" },
      { persist: false },
    );
    clearTokens();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe prevents callback from being called", () => {
    const callback = vi.fn();
    const unsubscribe = onLogout(callback);

    unsubscribe();
    clearTokens();

    expect(callback).not.toHaveBeenCalled();
  });

  it("supports multiple callbacks", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    onLogout(cb1);
    onLogout(cb2);

    clearTokens();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});
