import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

// Hoisted mocks
const {
  mockGetAccessToken,
  mockSaveKeypair,
  mockDeleteKeypair,
  mockGenerateKeyPair,
  mockFetch,
  mockReloadKeypair,
} = vi.hoisted(() => ({
  mockGetAccessToken: vi.fn(),
  mockSaveKeypair: vi.fn(),
  mockDeleteKeypair: vi.fn(),
  mockGenerateKeyPair: vi.fn(),
  mockFetch: vi.fn(),
  mockReloadKeypair: vi.fn(),
}));

vi.mock("~/lib/auth-store", () => ({
  getAccessToken: mockGetAccessToken,
  onLogin: vi.fn(() => () => undefined),
  onLogout: vi.fn(() => () => undefined),
}));

vi.mock("~/lib/keypair-store", () => ({
  saveKeypair: mockSaveKeypair,
  loadKeypair: vi.fn(),
  deleteKeypair: mockDeleteKeypair,
}));

vi.mock("@pqdb/client", () => ({
  generateKeyPair: mockGenerateKeyPair,
}));

// Stub global fetch
vi.stubGlobal("fetch", mockFetch);

import { RecoverKeypairModal } from "~/components/recover-keypair-modal";

// ML-KEM-768 sizes
const PK_BYTES = 1184;
const SK_BYTES = 2400;

const MOCK_PUBLIC_KEY = new Uint8Array(PK_BYTES).fill(7);
const MOCK_SECRET_KEY = new Uint8Array(SK_BYTES).fill(11);
const MOCK_PUBLIC_KEY_2 = new Uint8Array(PK_BYTES).fill(9);
const MOCK_SECRET_KEY_2 = new Uint8Array(SK_BYTES).fill(13);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const DEV_ID = "11111111-1111-1111-1111-111111111111";
const DEV_EMAIL = "test@example.com";

function fakeAccessToken(sub: string): string {
  const header = btoa(JSON.stringify({ alg: "EdDSA", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub, exp: 9999999999 }));
  return `${header}.${payload}.fake-sig`;
}

function makeRecoveryFile(
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): string {
  return JSON.stringify({
    version: 1,
    developer_id: DEV_ID,
    email: DEV_EMAIL,
    public_key: toBase64(publicKey),
    private_key: toBase64(secretKey),
    created_at: "2026-01-01T00:00:00.000Z",
    warning: "test",
  });
}

describe("RecoverKeypairModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    globalThis.indexedDB = new IDBFactory();
    mockGetAccessToken.mockReturnValue(fakeAccessToken(DEV_ID));
    mockSaveKeypair.mockResolvedValue(undefined);
    mockDeleteKeypair.mockResolvedValue(undefined);
    mockReloadKeypair.mockResolvedValue(undefined);
  });

  it("renders the modal with two options", () => {
    render(
      <RecoverKeypairModal
        developerId={DEV_ID}
        onReload={mockReloadKeypair}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText(/upload recovery file/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/generate new keypair/i),
    ).toBeInTheDocument();
  });

  it("upload flow: parses JSON, validates public key match, stores in IndexedDB", async () => {
    const user = userEvent.setup();

    // Mock GET /v1/auth/me/public-key — returns the matching key
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ public_key: toBase64(MOCK_PUBLIC_KEY) }),
    });

    render(
      <RecoverKeypairModal
        developerId={DEV_ID}
        onReload={mockReloadKeypair}
      />,
    );

    // Click upload option
    await user.click(screen.getByText(/upload recovery file/i));

    // Create a recovery file and upload it
    const fileContent = makeRecoveryFile(MOCK_PUBLIC_KEY, MOCK_SECRET_KEY);
    const file = new File([fileContent], "recovery.json", {
      type: "application/json",
    });

    const input = screen.getByTestId("recovery-file-input");
    await user.upload(input, file);

    // Wait for the save to complete
    await waitFor(() => {
      expect(mockSaveKeypair).toHaveBeenCalledWith(DEV_ID, {
        publicKey: MOCK_PUBLIC_KEY,
        secretKey: MOCK_SECRET_KEY,
      });
    });

    expect(mockReloadKeypair).toHaveBeenCalled();
  });

  it("upload flow: rejects mismatched public key", async () => {
    const user = userEvent.setup();

    // Mock GET /v1/auth/me/public-key — returns DIFFERENT key
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ public_key: toBase64(MOCK_PUBLIC_KEY_2) }),
    });

    render(
      <RecoverKeypairModal
        developerId={DEV_ID}
        onReload={mockReloadKeypair}
      />,
    );

    await user.click(screen.getByText(/upload recovery file/i));

    const fileContent = makeRecoveryFile(MOCK_PUBLIC_KEY, MOCK_SECRET_KEY);
    const file = new File([fileContent], "recovery.json", {
      type: "application/json",
    });

    const input = screen.getByTestId("recovery-file-input");
    await user.upload(input, file);

    await waitFor(() => {
      expect(
        screen.getByText(/does not match your account/i),
      ).toBeInTheDocument();
    });

    // Should NOT have saved
    expect(mockSaveKeypair).not.toHaveBeenCalled();
    expect(mockReloadKeypair).not.toHaveBeenCalled();
  });

  it("regenerate flow: generates keypair, PUTs new key, saves to IndexedDB", async () => {
    const user = userEvent.setup();

    mockGenerateKeyPair.mockResolvedValue({
      publicKey: MOCK_PUBLIC_KEY_2,
      secretKey: MOCK_SECRET_KEY_2,
    });

    // Mock PUT /v1/auth/me/public-key
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <RecoverKeypairModal
        developerId={DEV_ID}
        onReload={mockReloadKeypair}
      />,
    );

    // Click regenerate option
    await user.click(screen.getByText(/generate new keypair/i));

    // Should show warning
    expect(
      screen.getByText(/will become unrecoverable/i),
    ).toBeInTheDocument();

    // Checkbox must be checked before proceeding
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    const confirmButton = screen.getByRole("button", { name: /confirm/i });
    expect(confirmButton).toBeDisabled();

    // Check the checkbox
    await user.click(checkbox);
    expect(confirmButton).toBeEnabled();

    // Click confirm
    await user.click(confirmButton);

    await waitFor(() => {
      expect(mockGenerateKeyPair).toHaveBeenCalled();
    });

    // Verify PUT was called with new public key
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/v1/auth/me/public-key",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            public_key: toBase64(MOCK_PUBLIC_KEY_2),
          }),
        }),
      );
    });

    // Verify old keypair was deleted and new one saved
    await waitFor(() => {
      expect(mockDeleteKeypair).toHaveBeenCalledWith(DEV_ID);
    });
    expect(mockSaveKeypair).toHaveBeenCalledWith(DEV_ID, {
      publicKey: MOCK_PUBLIC_KEY_2,
      secretKey: MOCK_SECRET_KEY_2,
    });
    expect(mockReloadKeypair).toHaveBeenCalled();
  });
});
