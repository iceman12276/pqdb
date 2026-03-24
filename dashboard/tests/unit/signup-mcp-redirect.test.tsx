import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockSignup, mockNavigate, mockHandleMcpRedirect } = vi.hoisted(
  () => ({
    mockSignup: vi.fn(),
    mockNavigate: vi.fn(),
    mockHandleMcpRedirect: vi.fn(),
  }),
);

vi.mock("~/lib/api-client", () => ({
  api: { signup: mockSignup },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("~/lib/mcp-callback", () => ({
  handleMcpRedirect: mockHandleMcpRedirect,
}));

import { SignupPage } from "~/components/signup-page";

describe("SignupPage MCP redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to MCP callback after successful signup when handleMcpRedirect returns true", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: { access_token: "jwt-token", refresh_token: "rt" },
      error: null,
    });
    // handleMcpRedirect is now async
    mockHandleMcpRedirect.mockResolvedValue(true);

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() => {
      expect(mockHandleMcpRedirect).toHaveBeenCalledWith("jwt-token");
    });
    // Should NOT navigate to /projects when MCP redirect happens
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to /projects when handleMcpRedirect returns false", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: { access_token: "jwt-token", refresh_token: "rt" },
      error: null,
    });
    // handleMcpRedirect is now async
    mockHandleMcpRedirect.mockResolvedValue(false);

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(
      screen.getByRole("button", { name: /create account/i }),
    );

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });
});
