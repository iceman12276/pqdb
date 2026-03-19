import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { setTokens, clearTokens } from "~/lib/auth-store";

const { mockNavigate } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

import { AuthGuard } from "~/components/auth-guard";

describe("AuthGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTokens();
    sessionStorage.clear();
  });

  it("redirects to /login when no tokens exist", () => {
    render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    );

    expect(mockNavigate).toHaveBeenCalledWith({ to: "/login" });
    expect(screen.queryByText("Protected content")).not.toBeInTheDocument();
  });

  it("renders children when tokens exist", () => {
    setTokens({ access_token: "at", refresh_token: "rt" });

    render(
      <AuthGuard>
        <div>Protected content</div>
      </AuthGuard>,
    );

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByText("Protected content")).toBeInTheDocument();
  });
});
