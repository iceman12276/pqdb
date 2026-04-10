import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockSignup,
  mockNavigate,
  mockHandleMcpRedirect,
  mockGenerateKeyPair,
  mockSaveKeypair,
} = vi.hoisted(() => ({
  mockSignup: vi.fn(),
  mockNavigate: vi.fn(),
  mockHandleMcpRedirect: vi.fn(),
  mockGenerateKeyPair: vi.fn(),
  mockSaveKeypair: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { signup: mockSignup },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("~/lib/mcp-callback", () => ({
  handleMcpRedirect: mockHandleMcpRedirect,
}));

vi.mock("@pqdb/client", () => ({
  generateKeyPair: mockGenerateKeyPair,
}));

vi.mock("~/lib/keypair-store", () => ({
  saveKeypair: mockSaveKeypair,
  loadKeypair: vi.fn(),
  deleteKeypair: vi.fn(),
}));

import { SignupPage } from "~/components/signup-page";

// Minimal JWT with a sub claim; signature not verified client-side.
function mkJwt(): string {
  const header = btoa(JSON.stringify({ alg: "none" }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const payload = btoa(
    JSON.stringify({ sub: "11111111-1111-1111-1111-111111111111" }),
  )
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${payload}.sig`;
}

describe("SignupPage MCP redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.indexedDB = new IDBFactory();
    mockGenerateKeyPair.mockResolvedValue({
      publicKey: new Uint8Array(1184).fill(1),
      secretKey: new Uint8Array(2400).fill(2),
    });
    mockSaveKeypair.mockResolvedValue(undefined);
  });

  async function completeSignupForm() {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));
    return user;
  }

  async function dismissRecoveryModal(user: ReturnType<typeof userEvent.setup>) {
    await screen.findByRole("dialog", { name: /save your recovery file/i });
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /^close$/i }));
  }

  it("redirects to MCP callback after recovery modal is dismissed when handleMcpRedirect returns true", async () => {
    const token = mkJwt();
    mockSignup.mockResolvedValueOnce({
      data: { access_token: token, refresh_token: "rt" },
      error: null,
    });
    mockHandleMcpRedirect.mockResolvedValue(true);

    const user = await completeSignupForm();
    await dismissRecoveryModal(user);

    await waitFor(() => {
      expect(mockHandleMcpRedirect).toHaveBeenCalledWith(token);
    });
    // Should NOT navigate to /projects when MCP redirect happens
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to /projects when handleMcpRedirect returns false", async () => {
    const token = mkJwt();
    mockSignup.mockResolvedValueOnce({
      data: { access_token: token, refresh_token: "rt" },
      error: null,
    });
    mockHandleMcpRedirect.mockResolvedValue(false);

    const user = await completeSignupForm();
    await dismissRecoveryModal(user);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });
});
