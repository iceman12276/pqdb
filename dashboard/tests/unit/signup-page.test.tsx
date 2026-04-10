import { describe, it, expect, vi, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockSignup,
  mockNavigate,
  mockGenerateKeyPair,
  mockSaveKeypair,
  mockSetTokens,
  mockClearTokens,
} = vi.hoisted(() => ({
  mockSignup: vi.fn(),
  mockNavigate: vi.fn(),
  mockGenerateKeyPair: vi.fn(),
  mockSaveKeypair: vi.fn(),
  mockSetTokens: vi.fn(),
  mockClearTokens: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { signup: mockSignup },
}));

vi.mock("~/lib/navigation", () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock("@pqdb/client", () => ({
  generateKeyPair: mockGenerateKeyPair,
}));

vi.mock("~/lib/keypair-store", () => ({
  saveKeypair: mockSaveKeypair,
  loadKeypair: vi.fn(),
  deleteKeypair: vi.fn(),
}));

vi.mock("~/lib/auth-store", () => ({
  setTokens: mockSetTokens,
  clearTokens: mockClearTokens,
  getAccessToken: vi.fn(),
  getRefreshToken: vi.fn(),
  onLogout: vi.fn(() => () => undefined),
}));

import { SignupPage } from "~/components/signup-page";

// A real-length ML-KEM-768 public/secret key is 1184 / 2400 bytes. We use
// those exact lengths in mocks so base64 length assertions reflect the real
// data shape the backend validates on signup.
const MOCK_PUBLIC_KEY = new Uint8Array(1184).fill(7);
const MOCK_SECRET_KEY = new Uint8Array(2400).fill(11);

// Minimal unsigned JWT with a `sub` claim the signup page can extract.
// Not a valid signature — the dashboard only reads `sub` locally, the
// server verifies on every subsequent request.
const FAKE_JWT_HEADER = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
  .replace(/=+$/, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const FAKE_JWT_PAYLOAD = btoa(
  JSON.stringify({ sub: "11111111-1111-1111-1111-111111111111" }),
)
  .replace(/=+$/, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const FAKE_JWT = `${FAKE_JWT_HEADER}.${FAKE_JWT_PAYLOAD}.sig`;

describe("SignupPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.indexedDB = new IDBFactory();
    mockGenerateKeyPair.mockResolvedValue({
      publicKey: MOCK_PUBLIC_KEY,
      secretKey: MOCK_SECRET_KEY,
    });
    mockSaveKeypair.mockResolvedValue(undefined);
    if (!("createObjectURL" in URL)) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL =
        vi.fn(() => "blob:mock");
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    }
    if (!("revokeObjectURL" in URL)) {
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
        vi.fn();
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    }
  });

  it("renders email and password fields", () => {
    render(<SignupPage />);
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("renders a Create Account button", () => {
    render(<SignupPage />);
    expect(
      screen.getByRole("button", { name: /create account/i }),
    ).toBeInTheDocument();
  });

  it("renders a link to login page", () => {
    render(<SignupPage />);
    expect(screen.getByRole("link", { name: /sign in/i })).toHaveAttribute(
      "href",
      "/login",
    );
  });

  it("shows validation error for empty email", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(await screen.findByText(/email is required/i)).toBeInTheDocument();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it("shows validation error for short password", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "short");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/password must be at least 8 characters/i),
    ).toBeInTheDocument();
    expect(mockSignup).not.toHaveBeenCalled();
  });

  it("generates a keypair and sends the public key in the signup POST", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: {
        access_token: FAKE_JWT,
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(mockGenerateKeyPair).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockSignup).toHaveBeenCalledTimes(1);
    });

    // Signup must be called with email, password, and a base64-encoded
    // public key of the ML-KEM-768 canonical length (1184 bytes → 1580
    // base64 characters with padding). This is the exact invariant the
    // backend enforces in SignupRequest.
    const args = mockSignup.mock.calls[0]!;
    expect(args[0]).toBe("test@example.com");
    expect(args[1]).toBe("password123");
    expect(typeof args[2]).toBe("string");
    const decoded = Uint8Array.from(atob(args[2]), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(1184);
    expect(decoded).toEqual(MOCK_PUBLIC_KEY);
  });

  it("saves the private key to IndexedDB after a successful signup", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: {
        access_token: FAKE_JWT,
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<SignupPage />);
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await waitFor(() => {
      expect(mockSaveKeypair).toHaveBeenCalledTimes(1);
    });
    const [, kp] = mockSaveKeypair.mock.calls[0]!;
    expect(kp.publicKey).toEqual(MOCK_PUBLIC_KEY);
    expect(kp.secretKey).toEqual(MOCK_SECRET_KEY);
  });

  it("shows the recovery modal after a successful signup and does not navigate immediately", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: {
        access_token: FAKE_JWT,
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<SignupPage />);
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    // The recovery modal should appear before navigation happens — the
    // user MUST see and dismiss the modal so they don't lose their key.
    expect(
      await screen.findByRole("dialog", { name: /save your recovery file/i }),
    ).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates to /projects only after the recovery modal is closed", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: {
        access_token: FAKE_JWT,
        refresh_token: "rt",
        token_type: "bearer",
      },
      error: null,
    });

    render(<SignupPage />);
    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    await screen.findByRole("dialog", { name: /save your recovery file/i });
    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: "/projects" });
    });
  });

  it("shows 'Email already registered' on 409 error", async () => {
    const user = userEvent.setup();
    mockSignup.mockResolvedValueOnce({
      data: null,
      error: { code: 409, message: "Email already registered" },
    });

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      await screen.findByText(/email already registered/i),
    ).toBeInTheDocument();
  });

  it("disables submit button while loading", async () => {
    const user = userEvent.setup();
    let resolveSignup: (value: unknown) => void;
    mockSignup.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSignup = resolve;
      }),
    );

    render(<SignupPage />);

    await user.type(screen.getByLabelText(/email/i), "test@example.com");
    await user.type(screen.getByLabelText(/password/i), "password123");
    await user.click(screen.getByRole("button", { name: /create account/i }));

    expect(
      screen.getByRole("button", { name: /creating account/i }),
    ).toBeDisabled();

    resolveSignup!({
      data: { access_token: FAKE_JWT, refresh_token: "rt" },
      error: null,
    });

    // Wait for the post-signup async flow (saveKeypair, setTokens,
    // modal render) to fully drain so it doesn't leak into the next
    // test's assertions.
    await screen.findByRole("dialog", { name: /save your recovery file/i });
  });

  describe("post-signup error handling (US-004 fix)", () => {
    it("shows error and does not navigate when generateKeyPair fails", async () => {
      const user = userEvent.setup();
      mockGenerateKeyPair.mockRejectedValueOnce(new Error("WASM init failed"));

      render(<SignupPage />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "password123");
      await user.click(
        screen.getByRole("button", { name: /create account/i }),
      );

      expect(
        await screen.findByText(/wasm init failed/i),
      ).toBeInTheDocument();
      // No network call, no persistence, no auth — fully aborted.
      expect(mockSignup).not.toHaveBeenCalled();
      expect(mockSaveKeypair).not.toHaveBeenCalled();
      expect(mockSetTokens).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: /save your recovery file/i }),
      ).not.toBeInTheDocument();
    });

    it("shows error and does not commit tokens when saveKeypair fails after signup succeeds", async () => {
      const user = userEvent.setup();
      mockSignup.mockResolvedValueOnce({
        data: {
          access_token: FAKE_JWT,
          refresh_token: "rt",
          token_type: "bearer",
        },
        error: null,
      });
      mockSaveKeypair.mockRejectedValueOnce(new Error("QuotaExceededError"));

      render(<SignupPage />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "password123");
      await user.click(
        screen.getByRole("button", { name: /create account/i }),
      );

      expect(
        await screen.findByText(/quotaexceedederror/i),
      ).toBeInTheDocument();
      // Critical: tokens were NEVER committed because saveKeypair runs
      // BEFORE setTokens in the new ordering. No half-authenticated
      // zombie account.
      expect(mockSetTokens).not.toHaveBeenCalled();
      // No rollback needed because we never set tokens in the first place.
      expect(mockClearTokens).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: /save your recovery file/i }),
      ).not.toBeInTheDocument();
    });

    it("shows error and does not navigate when access token is malformed", async () => {
      const user = userEvent.setup();
      // developerIdFromAccessToken will throw on a token that's not a
      // 3-part JWT — this must abort the flow before any persistence.
      mockSignup.mockResolvedValueOnce({
        data: {
          access_token: "not.a.valid.jwt",
          refresh_token: "rt",
          token_type: "bearer",
        },
        error: null,
      });

      render(<SignupPage />);
      await user.type(screen.getByLabelText(/email/i), "test@example.com");
      await user.type(screen.getByLabelText(/password/i), "password123");
      await user.click(
        screen.getByRole("button", { name: /create account/i }),
      );

      expect(
        await screen.findByText(/signup failed/i),
      ).toBeInTheDocument();
      expect(mockSaveKeypair).not.toHaveBeenCalled();
      expect(mockSetTokens).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("dialog", { name: /save your recovery file/i }),
      ).not.toBeInTheDocument();
    });
  });
});
