import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const {
  mockFetchProjectKeys,
  mockRotateProjectKeys,
  mockCreateScopedKey,
  mockDeleteProjectKey,
  mockFetchTables,
} = vi.hoisted(() => ({
  mockFetchProjectKeys: vi.fn(),
  mockRotateProjectKeys: vi.fn(),
  mockCreateScopedKey: vi.fn(),
  mockDeleteProjectKey: vi.fn(),
  mockFetchTables: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjectKeys: mockFetchProjectKeys,
  rotateProjectKeys: mockRotateProjectKeys,
  createScopedKey: mockCreateScopedKey,
  deleteProjectKey: mockDeleteProjectKey,
}));

vi.mock("~/lib/table-data", () => ({
  fetchTables: mockFetchTables,
}));

import { ApiKeysPage } from "~/components/api-keys-page";

const mockBuiltInKeys = [
  {
    id: "k1",
    role: "anon",
    key_prefix: "pqdb_anon_abc123",
    created_at: "2026-01-15T10:00:00Z",
    name: null,
    permissions: null,
  },
  {
    id: "k2",
    role: "service_role",
    key_prefix: "pqdb_service_role_xyz789",
    created_at: "2026-01-15T10:00:00Z",
    name: null,
    permissions: null,
  },
];

const mockScopedKey = {
  id: "k3",
  role: "scoped",
  key_prefix: "pqdb_scoped_abc123",
  created_at: "2026-01-15T12:00:00Z",
  name: "Read-only users",
  permissions: {
    tables: {
      users: ["select"],
      posts: ["select", "insert"],
    },
  },
};

const mockTables = [
  { name: "users", columns: [{ name: "id", data_type: "uuid", sensitivity: "plain", is_owner: false }] },
  { name: "posts", columns: [{ name: "id", data_type: "uuid", sensitivity: "plain", is_owner: false }] },
  { name: "comments", columns: [{ name: "id", data_type: "uuid", sensitivity: "plain", is_owner: false }] },
];

const mockWriteText = vi.fn().mockResolvedValue(undefined);

describe("Scoped API Keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWriteText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
  });

  describe("Key list display", () => {
    it("shows 'Full access' badge for anon and service_role keys", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce(mockBuiltInKeys);
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        const badges = screen.getAllByText("Full access");
        expect(badges).toHaveLength(2);
      });
    });

    it("shows scoped key with name and permission details", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce([...mockBuiltInKeys, mockScopedKey]);
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("Read-only users")).toBeInTheDocument();
        expect(screen.getByText("scoped")).toBeInTheDocument();
      });

      // Should show table permission badges
      expect(screen.getByText("users: select")).toBeInTheDocument();
      expect(screen.getByText("posts: select, insert")).toBeInTheDocument();
    });

    it("shows delete button for scoped keys but not for built-in keys", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce([...mockBuiltInKeys, mockScopedKey]);
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("Read-only users")).toBeInTheDocument();
      });

      // Only one delete button (for the scoped key)
      const deleteButtons = screen.getAllByRole("button", { name: /delete/i });
      expect(deleteButtons).toHaveLength(1);
    });
  });

  describe("Create Scoped Key dialog", () => {
    it("opens create scoped key dialog when button is clicked", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce(mockBuiltInKeys);
      mockFetchTables.mockResolvedValueOnce(mockTables);
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /create scoped key/i }));

      await waitFor(() => {
        expect(screen.getByText("Create an API key with limited permissions on specific tables.")).toBeInTheDocument();
      });
    });

    it("loads table list in the dialog", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce(mockBuiltInKeys);
      mockFetchTables.mockResolvedValueOnce(mockTables);
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /create scoped key/i }));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
        expect(screen.getByText("posts")).toBeInTheDocument();
        expect(screen.getByText("comments")).toBeInTheDocument();
      });
    });

    it("creates a scoped key and shows the full key once", async () => {
      mockFetchProjectKeys.mockResolvedValue(mockBuiltInKeys);
      mockFetchTables.mockResolvedValue(mockTables);
      mockCreateScopedKey.mockResolvedValueOnce({
        id: "k-new",
        role: "scoped",
        name: "My key",
        key: "pqdb_scoped_fullkey123456789012345678",
        key_prefix: "pqdb_scoped_fullkey1234",
        permissions: { tables: { users: ["select"] } },
      });
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      });

      // Open dialog
      await user.click(screen.getByRole("button", { name: /create scoped key/i }));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
      });

      // Fill in name
      const nameInput = screen.getByPlaceholderText(/key name/i);
      await user.type(nameInput, "My key");

      // Check select on users table
      const usersCheckbox = screen.getByTestId("perm-users-select");
      await user.click(usersCheckbox);

      // Submit
      const createBtn = screen.getByRole("button", { name: /^create$/i });
      await user.click(createBtn);

      // Should show the full key
      await waitFor(() => {
        expect(
          screen.getByText("pqdb_scoped_fullkey123456789012345678"),
        ).toBeInTheDocument();
      });

      // Should call createScopedKey with correct params
      expect(mockCreateScopedKey).toHaveBeenCalledWith("p1", "My key", {
        tables: { users: ["select"] },
      });
    });

    it("disables create button when name is empty", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce(mockBuiltInKeys);
      mockFetchTables.mockResolvedValueOnce(mockTables);
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /create scoped key/i }));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
      });

      // Create button should be disabled (no name, no permissions)
      const createBtn = screen.getByRole("button", { name: /^create$/i });
      expect(createBtn).toBeDisabled();
    });

    it("disables create button when no permissions selected", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce(mockBuiltInKeys);
      mockFetchTables.mockResolvedValueOnce(mockTables);
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("pqdb_anon_abc123****")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /create scoped key/i }));

      await waitFor(() => {
        expect(screen.getByText("users")).toBeInTheDocument();
      });

      // Fill name but no permissions
      const nameInput = screen.getByPlaceholderText(/key name/i);
      await user.type(nameInput, "My key");

      const createBtn = screen.getByRole("button", { name: /^create$/i });
      expect(createBtn).toBeDisabled();
    });
  });

  describe("Delete scoped key", () => {
    it("deletes a scoped key after confirmation", async () => {
      mockFetchProjectKeys.mockResolvedValueOnce([...mockBuiltInKeys, mockScopedKey]);
      mockDeleteProjectKey.mockResolvedValueOnce(undefined);
      const user = userEvent.setup();
      const { wrapper } = createQueryWrapper();
      render(<ApiKeysPage projectId="p1" apiKey="svc_key" />, { wrapper });

      await waitFor(() => {
        expect(screen.getByText("Read-only users")).toBeInTheDocument();
      });

      // Click delete
      const deleteBtn = screen.getByRole("button", { name: /delete/i });
      await user.click(deleteBtn);

      // Confirm dialog
      await waitFor(() => {
        expect(screen.getByText(/are you sure/i)).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /^confirm$/i }));

      await waitFor(() => {
        expect(mockDeleteProjectKey).toHaveBeenCalledWith("p1", "k3");
      });
    });
  });
});
