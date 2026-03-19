import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockLogin, mockNavigate, mockStartPasskeyAuth } = vi.hoisted(() => ({
  mockLogin: vi.fn(),
  mockNavigate: vi.fn(),
  mockStartPasskeyAuth: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { login: mockLogin },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("~/lib/passkey", () => ({
  startPasskeyAuthentication: mockStartPasskeyAuth,
}));

import { LoginPage } from "~/components/login-page";

describe("LoginPage OAuth + Passkey wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear window.location.hash
    window.location.hash = "";
  });

  it("renders enabled OAuth buttons", () => {
    render(<LoginPage />);
    const googleBtn = screen.getByRole("button", {
      name: /sign in with google/i,
    });
    const githubBtn = screen.getByRole("button", {
      name: /sign in with github/i,
    });
    expect(googleBtn).not.toBeDisabled();
    expect(githubBtn).not.toBeDisabled();
  });

  it("renders enabled Passkey button", () => {
    render(<LoginPage />);
    const passkeyBtn = screen.getByRole("button", {
      name: /sign in with passkey/i,
    });
    expect(passkeyBtn).not.toBeDisabled();
  });

  it("Google button redirects to OAuth authorize endpoint", async () => {
    const user = userEvent.setup();
    // Mock window.location.href setter
    const hrefSetter = vi.fn();
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        href: "",
        origin: "http://localhost:3000",
        hash: "",
      },
      writable: true,
    });
    Object.defineProperty(window.location, "href", {
      set: hrefSetter,
      get: () => "",
    });

    render(<LoginPage />);
    await user.click(
      screen.getByRole("button", { name: /sign in with google/i }),
    );

    expect(hrefSetter).toHaveBeenCalledWith(
      expect.stringContaining("/v1/auth/oauth/google/authorize"),
    );
    expect(hrefSetter).toHaveBeenCalledWith(
      expect.stringContaining("redirect_uri="),
    );
  });

  it("Passkey button calls startPasskeyAuthentication", async () => {
    const user = userEvent.setup();
    mockStartPasskeyAuth.mockResolvedValueOnce({
      access_token: "pk-at",
      refresh_token: "pk-rt",
    });

    render(<LoginPage />);
    await user.click(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    );

    await waitFor(() => {
      expect(mockStartPasskeyAuth).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });

  it("shows error when passkey authentication fails", async () => {
    const user = userEvent.setup();
    mockStartPasskeyAuth.mockRejectedValueOnce(
      new Error("Passkey was cancelled"),
    );

    render(<LoginPage />);
    await user.click(
      screen.getByRole("button", { name: /sign in with passkey/i }),
    );

    expect(
      await screen.findByText(/passkey was cancelled/i),
    ).toBeInTheDocument();
  });

  it("extracts tokens from URL hash fragment (OAuth callback)", async () => {
    // Simulate OAuth callback with tokens in hash
    Object.defineProperty(window, "location", {
      value: {
        ...window.location,
        hash: "#access_token=test-at&refresh_token=test-rt&token_type=bearer",
        origin: "http://localhost:3000",
        href: "http://localhost:3000/login#access_token=test-at&refresh_token=test-rt",
      },
      writable: true,
    });
    window.history.replaceState = vi.fn();

    render(<LoginPage />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });
});
