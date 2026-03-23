import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoisted mocks
const {
  mockApiFetch,
  mockDeriveWrappingKey,
  mockUnwrapKey,
  mockWrapKey,
  mockFetchProjects,
  mockSetWrappingKey,
  mockSetTokens,
} = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockDeriveWrappingKey: vi.fn(),
  mockUnwrapKey: vi.fn(),
  mockWrapKey: vi.fn(),
  mockFetchProjects: vi.fn(),
  mockSetWrappingKey: vi.fn(),
  mockSetTokens: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { fetch: mockApiFetch },
}));

vi.mock("~/lib/envelope-crypto", () => ({
  deriveWrappingKey: mockDeriveWrappingKey,
  unwrapKey: mockUnwrapKey,
  wrapKey: mockWrapKey,
}));

vi.mock("~/lib/projects", () => ({
  fetchProjects: mockFetchProjects,
}));

vi.mock("~/lib/envelope-key-context", () => ({
  useEnvelopeKeys: () => ({
    setWrappingKey: mockSetWrappingKey,
    encryptionKeys: new Map(),
  }),
}));

vi.mock("~/lib/auth-store", () => ({
  setTokens: mockSetTokens,
  getTokens: vi.fn(() => ({
    access_token: "old-access",
    refresh_token: "old-refresh",
  })),
}));

import { ChangePasswordDialog } from "~/components/change-password-dialog";

function renderDialog(open = true) {
  const onOpenChange = vi.fn();
  const result = render(
    <ChangePasswordDialog open={open} onOpenChange={onOpenChange} />,
  );
  return { ...result, onOpenChange };
}

describe("ChangePasswordDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders dialog with required fields when open", () => {
    renderDialog();
    expect(
      screen.getByRole("heading", { name: "Change Password" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm new password/i)).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    renderDialog(false);
    expect(screen.queryByText("Change Password")).not.toBeInTheDocument();
  });

  it("shows validation error when fields are empty", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: /change password/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(/all fields are required/i);
  });

  it("shows validation error when passwords don't match", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^new password$/i), "newpass123");
    await user.type(screen.getByLabelText(/confirm new password/i), "newpass456");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(/passwords do not match/i);
  });

  it("shows validation error when new password is same as current", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "samepass");
    await user.type(screen.getByLabelText(/^new password$/i), "samepass");
    await user.type(screen.getByLabelText(/confirm new password/i), "samepass");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      /new password must be different/i,
    );
  });

  it("calls change-password API and re-wraps keys on success", async () => {
    const user = userEvent.setup();
    const oldWrappingKey = {} as CryptoKey;
    const newWrappingKey = {} as CryptoKey;
    const fakeWrappedBlob = new Uint8Array([1, 2, 3]);
    const newWrappedBlob = new Uint8Array([4, 5, 6]);

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/change-password") {
        return {
          ok: true,
          status: 200,
          data: { access_token: "new-access", refresh_token: "new-refresh" },
        };
      }
      // PATCH encryption key
      if (init?.method === "PATCH") {
        return { ok: true, status: 200, data: {} };
      }
      return { ok: true, status: 200, data: {} };
    });

    mockDeriveWrappingKey
      .mockResolvedValueOnce(oldWrappingKey)
      .mockResolvedValueOnce(newWrappingKey);

    mockFetchProjects.mockResolvedValue([
      {
        id: "proj-1",
        name: "Test Project",
        wrapped_encryption_key: "AQID", // base64 of [1,2,3]
      },
    ]);

    mockUnwrapKey.mockResolvedValue("plaintext-key");
    mockWrapKey.mockResolvedValue(newWrappedBlob);

    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^new password$/i), "newpass123");
    await user.type(screen.getByLabelText(/confirm new password/i), "newpass123");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      // Verify change-password API was called
      expect(mockApiFetch).toHaveBeenCalledWith("/v1/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: "oldpass",
          new_password: "newpass123",
        }),
      });
    });

    await waitFor(() => {
      // Verify wrapping keys were derived
      expect(mockDeriveWrappingKey).toHaveBeenCalledWith("oldpass", "dev@example.com");
      expect(mockDeriveWrappingKey).toHaveBeenCalledWith("newpass123", "dev@example.com");
    });

    await waitFor(() => {
      // Verify unwrap was called with old key
      expect(mockUnwrapKey).toHaveBeenCalled();
      // Verify wrap was called with new key
      expect(mockWrapKey).toHaveBeenCalledWith("plaintext-key", newWrappingKey);
    });

    await waitFor(() => {
      // Verify PATCH was called to store the re-wrapped key
      expect(mockApiFetch).toHaveBeenCalledWith(
        "/v1/projects/proj-1/encryption-key",
        expect.objectContaining({ method: "PATCH" }),
      );
    });

    await waitFor(() => {
      // Verify new wrapping key was set in context
      expect(mockSetWrappingKey).toHaveBeenCalledWith(newWrappingKey);
    });

    await waitFor(() => {
      // Verify new tokens were saved
      expect(mockSetTokens).toHaveBeenCalledWith(
        { access_token: "new-access", refresh_token: "new-refresh" },
        { persist: true },
      );
    });

    await waitFor(() => {
      // Dialog should close
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it("shows error when change-password API fails", async () => {
    const user = userEvent.setup();

    mockApiFetch.mockResolvedValue({
      ok: false,
      status: 401,
      data: { error: { message: "Invalid credentials" } },
    });

    renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "wrongpass");
    await user.type(screen.getByLabelText(/^new password$/i), "newpass123");
    await user.type(screen.getByLabelText(/confirm new password/i), "newpass123");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/invalid credentials/i);
    });
  });

  it("continues re-wrapping if one project fails", async () => {
    const user = userEvent.setup();
    const oldWrappingKey = {} as CryptoKey;
    const newWrappingKey = {} as CryptoKey;

    mockApiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/auth/change-password") {
        return {
          ok: true,
          status: 200,
          data: { access_token: "new-access", refresh_token: "new-refresh" },
        };
      }
      if (path === "/v1/projects/proj-1/encryption-key" && init?.method === "PATCH") {
        return { ok: false, status: 500, data: null };
      }
      if (init?.method === "PATCH") {
        return { ok: true, status: 200, data: {} };
      }
      return { ok: true, status: 200, data: {} };
    });

    mockDeriveWrappingKey
      .mockResolvedValueOnce(oldWrappingKey)
      .mockResolvedValueOnce(newWrappingKey);

    mockFetchProjects.mockResolvedValue([
      { id: "proj-1", name: "Proj 1", wrapped_encryption_key: "AQID" },
      { id: "proj-2", name: "Proj 2", wrapped_encryption_key: "BAUG" },
    ]);

    mockUnwrapKey.mockResolvedValue("plaintext-key");
    mockWrapKey.mockResolvedValue(new Uint8Array([4, 5, 6]));

    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^new password$/i), "newpass123");
    await user.type(screen.getByLabelText(/confirm new password/i), "newpass123");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      // Should still complete and close despite proj-1 failure
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // Both PATCHes attempted
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/projects/proj-1/encryption-key",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/projects/proj-2/encryption-key",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("skips re-wrapping for projects without wrapped_encryption_key", async () => {
    const user = userEvent.setup();

    mockApiFetch.mockImplementation(async (path: string) => {
      if (path === "/v1/auth/change-password") {
        return {
          ok: true,
          status: 200,
          data: { access_token: "new-access", refresh_token: "new-refresh" },
        };
      }
      return { ok: true, status: 200, data: {} };
    });

    mockDeriveWrappingKey.mockResolvedValue({} as CryptoKey);
    mockFetchProjects.mockResolvedValue([
      { id: "proj-1", name: "Proj 1", wrapped_encryption_key: null },
    ]);

    const { onOpenChange } = renderDialog();

    await user.type(screen.getByLabelText(/email/i), "dev@example.com");
    await user.type(screen.getByLabelText(/current password/i), "oldpass");
    await user.type(screen.getByLabelText(/^new password$/i), "newpass123");
    await user.type(screen.getByLabelText(/confirm new password/i), "newpass123");
    await user.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // No PATCH calls for encryption keys
    const patchCalls = mockApiFetch.mock.calls.filter(
      (c: unknown[]) => (c[1] as RequestInit)?.method === "PATCH",
    );
    expect(patchCalls).toHaveLength(0);

    // unwrapKey should not have been called
    expect(mockUnwrapKey).not.toHaveBeenCalled();
  });
});
