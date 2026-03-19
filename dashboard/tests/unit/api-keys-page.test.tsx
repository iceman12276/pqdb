import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProjectKeys, mockRotateProjectKeys } = vi.hoisted(() => ({
  mockFetchProjectKeys: vi.fn(),
  mockRotateProjectKeys: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjectKeys: mockFetchProjectKeys,
  rotateProjectKeys: mockRotateProjectKeys,
}));

import { ApiKeysPage } from "~/components/api-keys-page";

const mockKeys = [
  {
    id: "k1",
    role: "anon",
    key_prefix: "pqdb_anon_abc123",
    created_at: "2026-01-15T10:00:00Z",
  },
  {
    id: "k2",
    role: "service_role",
    key_prefix: "pqdb_service_role_xyz789",
    created_at: "2026-01-15T10:00:00Z",
  },
];

const mockRotatedKeys = [
  {
    id: "k3",
    role: "anon",
    key: "pqdb_anon_newkey123456789012345678901234",
    key_prefix: "pqdb_anon_newkey1234",
  },
  {
    id: "k4",
    role: "service_role",
    key: "pqdb_service_role_newkey12345678901234567890",
    key_prefix: "pqdb_service_role_newkey",
  },
];

const mockWriteText = vi.fn().mockResolvedValue(undefined);

describe("ApiKeysPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
  });

  it("shows loading state while fetching keys", () => {
    mockFetchProjectKeys.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });
    expect(screen.getByTestId("keys-loading")).toBeInTheDocument();
  });

  it("displays API keys in masked format", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      expect(
        screen.getByText("pqdb_service_role_xyz789****"),
      ).toBeInTheDocument();
    });
  });

  it("shows role labels for each key", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("anon")).toBeInTheDocument();
      expect(screen.getByText("service_role")).toBeInTheDocument();
    });
  });

  it("shows SDK connection snippet with placeholder instead of masked key", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("sdk-snippet")).toBeInTheDocument();
    });

    const snippet = screen.getByTestId("sdk-snippet");
    expect(snippet.textContent).toContain("createClient");
    expect(snippet.textContent).toContain("http://localhost:8000");
    expect(snippet.textContent).toContain("<your-anon-key>");
    // Must NOT contain the masked key prefix
    expect(snippet.textContent).not.toContain("pqdb_anon_abc123");
  });

  it("copies key to clipboard when copy button is clicked", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
    });

    // Use fireEvent instead of userEvent to avoid clipboard interception
    const anonCopyBtn = screen.getByRole("button", { name: "Copy anon key" });
    fireEvent.click(anonCopyBtn);
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith("pqdb_anon_abc123****");
    });
  });

  it("copies SDK snippet with placeholder to clipboard", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("sdk-snippet")).toBeInTheDocument();
    });

    const snippetCopyBtn = screen.getByTestId("copy-snippet-btn");
    fireEvent.click(snippetCopyBtn);
    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining("<your-anon-key>"),
      );
    });
  });

  it("opens rotation confirmation dialog when Rotate Keys is clicked", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    const user = userEvent.setup();
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
    });

    const rotateBtn = screen.getByRole("button", { name: /rotate keys/i });
    await user.click(rotateBtn);

    // Confirmation dialog should appear
    expect(
      screen.getByText(/this will invalidate your current api keys/i),
    ).toBeInTheDocument();
  });

  it("calls rotate endpoint and shows new keys in modal after confirmation", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    mockRotateProjectKeys.mockResolvedValueOnce(mockRotatedKeys);
    const user = userEvent.setup();
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
    });

    // Click rotate
    await user.click(screen.getByRole("button", { name: /rotate keys/i }));

    // Confirm rotation
    const confirmBtn = screen.getByRole("button", { name: /confirm/i });
    await user.click(confirmBtn);

    // Wait for new keys to show
    await waitFor(() => {
      expect(mockRotateProjectKeys).toHaveBeenCalledWith("p1");
    });

    // Should show the full new keys (one-time display)
    await waitFor(() => {
      expect(
        screen.getByText("pqdb_anon_newkey123456789012345678901234"),
      ).toBeInTheDocument();
    });

    // Should show warning
    expect(
      screen.getByText(/keys are shown only once/i),
    ).toBeInTheDocument();
  });

  it("shows SDK snippet with full anon key in rotation modal", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    mockRotateProjectKeys.mockResolvedValueOnce(mockRotatedKeys);
    const user = userEvent.setup();
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
    });

    // Click rotate and confirm
    await user.click(screen.getByRole("button", { name: /rotate keys/i }));
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    // Wait for new keys modal
    await waitFor(() => {
      expect(
        screen.getByText("pqdb_anon_newkey123456789012345678901234"),
      ).toBeInTheDocument();
    });

    // Should show an SDK snippet with the full anon key
    const snippet = screen.getByTestId("new-keys-snippet");
    expect(snippet.textContent).toContain("createClient");
    expect(snippet.textContent).toContain(
      "pqdb_anon_newkey123456789012345678901234",
    );
  });

  it("shows error state when fetch fails", async () => {
    mockFetchProjectKeys.mockRejectedValueOnce(
      new Error("Failed to fetch API keys"),
    );
    const { wrapper } = createQueryWrapper();
    render(<ApiKeysPage projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText(/failed to load api keys/i)).toBeInTheDocument();
    });
  });
});
