import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockFetch, mockGetAccessToken, mockGetTokens } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAccessToken: vi.fn(),
  mockGetTokens: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { fetch: mockFetch },
}));

vi.mock("~/lib/auth-store", () => ({
  getAccessToken: mockGetAccessToken,
  getTokens: mockGetTokens,
}));

vi.mock("~/lib/passkey", () => ({
  startPasskeyRegistration: vi.fn(),
}));

import { SettingsPage } from "~/components/settings-page";

/** Build a fake JWT-shaped string at runtime to avoid static secret detection. */
function buildFakeToken(): string {
  const header = btoa(JSON.stringify({ alg: "EdDSA" }));
  const payload = btoa(JSON.stringify({ sub: "12345678", type: "access" }));
  return `${header}.${payload}.fakesig`;
}

describe("SettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({ ok: true, status: 200, data: [] });
    mockGetAccessToken.mockReturnValue("test-token");
    mockGetTokens.mockReturnValue({
      access_token: buildFakeToken(),
      refresh_token: "rt",
    });
  });

  it("renders Security heading", async () => {
    render(<SettingsPage />);
    expect(screen.getByText("Security")).toBeInTheDocument();
  });

  it("renders Passkeys section", async () => {
    render(<SettingsPage />);
    expect(screen.getByText("Passkeys")).toBeInTheDocument();
  });

  it("renders Linked OAuth Accounts section", async () => {
    render(<SettingsPage />);
    expect(screen.getByText("Linked OAuth Accounts")).toBeInTheDocument();
  });

  it("shows no passkeys message when empty", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("no-passkeys")).toBeInTheDocument();
    });
  });

  it("shows no oauth message when empty", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("no-oauth")).toBeInTheDocument();
    });
  });

  it("renders Add Passkey button", () => {
    render(<SettingsPage />);
    expect(
      screen.getByRole("button", { name: /add passkey/i }),
    ).toBeInTheDocument();
  });

  it("renders passkey name input", () => {
    render(<SettingsPage />);
    expect(
      screen.getByPlaceholderText(/passkey name/i),
    ).toBeInTheDocument();
  });

  it("renders passkey list when passkeys exist", async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/passkeys") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "cred-1",
              name: "My YubiKey",
              created_at: "2026-03-18T00:00:00+00:00",
              last_used_at: null,
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("My YubiKey")).toBeInTheDocument();
    });
    expect(screen.getByTestId("passkey-list")).toBeInTheDocument();
  });

  it("renders Delete button for each passkey", async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/passkeys") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "cred-1",
              name: "Key 1",
              created_at: "2026-03-18T00:00:00+00:00",
              last_used_at: null,
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /delete/i }),
      ).toBeInTheDocument();
    });
  });

  it("renders oauth accounts with Unlink button", async () => {
    mockFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/oauth/identities") {
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "oa-1",
              provider: "google",
              email: "dev@gmail.com",
              created_at: "2026-03-18T00:00:00+00:00",
            },
          ],
        };
      }
      return { ok: true, status: 200, data: [] };
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("google")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /unlink/i }),
    ).toBeInTheDocument();
  });

  it("calls delete endpoint when Delete passkey is clicked", async () => {
    const user = userEvent.setup();
    let deleteCalled = false;
    mockFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/passkeys" && !init?.method) {
        // After delete, return empty list
        if (deleteCalled) {
          return { ok: true, status: 200, data: [] };
        }
        return {
          ok: true,
          status: 200,
          data: [
            {
              id: "abc123",
              name: "Test Key",
              created_at: "2026-03-18T00:00:00+00:00",
              last_used_at: null,
            },
          ],
        };
      }
      if (path === "/v1/auth/oauth/identities" && !init?.method) {
        return { ok: true, status: 200, data: [] };
      }
      if (init?.method === "DELETE") {
        deleteCalled = true;
        return { ok: true, status: 200, data: { status: "deleted" } };
      }
      return { ok: true, status: 200, data: [] };
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText("Test Key")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /delete/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/auth/passkeys/abc123",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});
