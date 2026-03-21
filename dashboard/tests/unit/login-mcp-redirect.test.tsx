import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockLogin, mockNavigate, mockHandleMcpRedirect } = vi.hoisted(
  () => ({
    mockLogin: vi.fn(),
    mockNavigate: vi.fn(),
    mockHandleMcpRedirect: vi.fn(),
  }),
);

vi.mock("~/lib/api-client", () => ({
  api: { login: mockLogin },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("~/lib/passkey", () => ({
  startPasskeyAuthentication: vi.fn(),
}));

vi.mock("~/lib/mcp-callback", () => ({
  handleMcpRedirect: mockHandleMcpRedirect,
}));

import { LoginPage } from "~/components/login-page";

describe("LoginPage MCP redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to MCP callback after successful login when handleMcpRedirect returns true", async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      data: { access_token: "jwt-token", refresh_token: "rt" },
      error: null,
    });
    mockHandleMcpRedirect.mockReturnValue(true);

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    await waitFor(() => {
      expect(mockHandleMcpRedirect).toHaveBeenCalledWith("jwt-token");
    });
    // Should NOT navigate to /projects when MCP redirect happens
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to /projects when handleMcpRedirect returns false", async () => {
    const user = userEvent.setup();
    mockLogin.mockResolvedValueOnce({
      data: { access_token: "jwt-token", refresh_token: "rt" },
      error: null,
    });
    mockHandleMcpRedirect.mockReturnValue(false);

    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /sign in$/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });
});
