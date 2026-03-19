import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockFetch, mockGetAccessToken } = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAccessToken: vi.fn(),
}));

vi.mock("~/lib/api-client", () => ({
  api: { fetch: mockFetch },
}));

vi.mock("~/lib/auth-store", () => ({
  getAccessToken: mockGetAccessToken,
}));

import { AuthSettingsPage } from "~/components/auth-settings-page";

function defaultMockFetch(path: string) {
  if (path.endsWith("/auth/providers")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: { providers: ["google"] },
    });
  }
  if (path.endsWith("/auth/roles")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: [
        {
          id: "r1",
          name: "anon",
          description: "Anonymous role",
          created_at: "2026-03-18T00:00:00Z",
        },
        {
          id: "r2",
          name: "authenticated",
          description: "Authenticated user",
          created_at: "2026-03-18T00:00:00Z",
        },
        {
          id: "r3",
          name: "editor",
          description: "Custom editor role",
          created_at: "2026-03-18T00:00:00Z",
        },
      ],
    });
  }
  if (path.endsWith("/auth/settings")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        require_email_verification: false,
        password_min_length: 8,
        mfa_enabled: false,
        magic_link_webhook: null,
      },
    });
  }
  if (path === "/v1/db/tables") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: [{ name: "users" }, { name: "posts" }],
    });
  }
  if (path.includes("/policies")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: [
        {
          id: "p1",
          name: "allow_read",
          table_name: "users",
          operation: "select",
          role: "anon",
          condition: "all",
          created_at: "2026-03-18T00:00:00Z",
        },
      ],
    });
  }
  return Promise.resolve({ ok: true, status: 200, data: {} });
}

describe("AuthSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccessToken.mockReturnValue("test-token");
    mockFetch.mockImplementation(defaultMockFetch);
  });

  describe("Tab rendering", () => {
    it("renders all four tabs", () => {
      render(<AuthSettingsPage projectId="proj-1" />);
      expect(screen.getByRole("tab", { name: "Providers" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Roles" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Policies" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "Settings" })).toBeInTheDocument();
    });

    it("shows Providers tab content by default", async () => {
      render(<AuthSettingsPage projectId="proj-1" />);
      await waitFor(() => {
        expect(screen.getByTestId("providers-tab")).toBeInTheDocument();
      });
    });

    it("switches to Roles tab on click", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));
      await waitFor(() => {
        expect(screen.getByTestId("roles-tab")).toBeInTheDocument();
      });
    });

    it("switches to Policies tab on click", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Policies" }));
      await waitFor(() => {
        expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
      });
    });

    it("switches to Settings tab on click", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Settings" }));
      await waitFor(() => {
        expect(screen.getByTestId("settings-tab")).toBeInTheDocument();
      });
    });
  });

  describe("Providers tab", () => {
    it("lists configured OAuth providers", async () => {
      render(<AuthSettingsPage projectId="proj-1" />);
      await waitFor(() => {
        expect(screen.getByText("google")).toBeInTheDocument();
      });
    });

    it("shows Add Provider form fields", async () => {
      render(<AuthSettingsPage projectId="proj-1" />);
      await waitFor(() => {
        expect(screen.getByTestId("providers-tab")).toBeInTheDocument();
      });
      expect(screen.getByLabelText("Provider")).toBeInTheDocument();
      expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
      expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /add provider/i }),
      ).toBeInTheDocument();
    });

    it("calls POST /auth/providers when adding a provider", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);

      await waitFor(() => {
        expect(screen.getByTestId("providers-tab")).toBeInTheDocument();
      });

      await user.selectOptions(screen.getByLabelText("Provider"), "github");
      await user.type(screen.getByLabelText("Client ID"), "my-client-id");
      await user.type(screen.getByLabelText("Client Secret"), "my-client-secret");
      await user.click(screen.getByRole("button", { name: /add provider/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/projects/proj-1/auth/providers",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              provider: "github",
              client_id: "my-client-id",
              client_secret: "my-client-secret",
            }),
          }),
        );
      });
    });

    it("calls DELETE when removing a provider", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);

      await waitFor(() => {
        expect(screen.getByText("google")).toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: /remove/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/projects/proj-1/auth/providers/google",
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });
  });

  describe("Roles tab", () => {
    it("lists roles", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByText("anon")).toBeInTheDocument();
        expect(screen.getByText("authenticated")).toBeInTheDocument();
        expect(screen.getByText("editor")).toBeInTheDocument();
      });
    });

    it("does not show delete button for built-in roles", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByText("anon")).toBeInTheDocument();
      });

      const anonRow = screen.getByTestId("role-anon");
      expect(within(anonRow).queryByRole("button", { name: /delete/i })).toBeNull();

      const authRow = screen.getByTestId("role-authenticated");
      expect(within(authRow).queryByRole("button", { name: /delete/i })).toBeNull();
    });

    it("shows delete button for custom roles", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByText("editor")).toBeInTheDocument();
      });

      const editorRow = screen.getByTestId("role-editor");
      expect(
        within(editorRow).getByRole("button", { name: /delete/i }),
      ).toBeInTheDocument();
    });

    it("shows Create Role form", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByTestId("roles-tab")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Role Name")).toBeInTheDocument();
      expect(screen.getByLabelText("Description")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /create role/i }),
      ).toBeInTheDocument();
    });

    it("calls POST /auth/roles when creating a role", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByTestId("roles-tab")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Role Name"), "moderator");
      await user.type(screen.getByLabelText("Description"), "Can moderate");
      await user.click(screen.getByRole("button", { name: /create role/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/projects/proj-1/auth/roles",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              name: "moderator",
              description: "Can moderate",
            }),
          }),
        );
      });
    });

    it("calls DELETE when removing a custom role", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Roles" }));

      await waitFor(() => {
        expect(screen.getByText("editor")).toBeInTheDocument();
      });

      const editorRow = screen.getByTestId("role-editor");
      await user.click(
        within(editorRow).getByRole("button", { name: /delete/i }),
      );

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/projects/proj-1/auth/roles/editor",
          expect.objectContaining({ method: "DELETE" }),
        );
      });
    });
  });

  describe("Policies tab", () => {
    it("shows table selector", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" apiKey="pqdb_anon_test" />);
      await user.click(screen.getByRole("tab", { name: "Policies" }));

      await waitFor(() => {
        expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Table")).toBeInTheDocument();
    });

    it("lists policies for selected table", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" apiKey="pqdb_anon_test" />);
      await user.click(screen.getByRole("tab", { name: "Policies" }));

      await waitFor(() => {
        expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
      });

      // Wait for tables to load
      await waitFor(() => {
        const tableSelect = screen.getByLabelText("Table") as HTMLSelectElement;
        expect(tableSelect.options.length).toBeGreaterThan(1);
      });

      await user.selectOptions(screen.getByLabelText("Table"), "users");

      await waitFor(() => {
        expect(screen.getByText("allow_read")).toBeInTheDocument();
      });
    });

    it("shows Add Policy form after selecting a table", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" apiKey="pqdb_anon_test" />);
      await user.click(screen.getByRole("tab", { name: "Policies" }));

      await waitFor(() => {
        expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
      });

      await waitFor(() => {
        const tableSelect = screen.getByLabelText("Table") as HTMLSelectElement;
        expect(tableSelect.options.length).toBeGreaterThan(1);
      });

      await user.selectOptions(screen.getByLabelText("Table"), "users");

      await waitFor(() => {
        expect(screen.getByLabelText("Policy Name")).toBeInTheDocument();
      });

      expect(screen.getByLabelText("Operation")).toBeInTheDocument();
      expect(screen.getByLabelText("Role")).toBeInTheDocument();
      expect(screen.getByLabelText("Condition")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /add policy/i }),
      ).toBeInTheDocument();
    });

    it("calls POST to create a policy", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" apiKey="pqdb_anon_test" />);
      await user.click(screen.getByRole("tab", { name: "Policies" }));

      await waitFor(() => {
        expect(screen.getByTestId("policies-tab")).toBeInTheDocument();
      });

      await waitFor(() => {
        const tableSelect = screen.getByLabelText("Table") as HTMLSelectElement;
        expect(tableSelect.options.length).toBeGreaterThan(1);
      });

      await user.selectOptions(screen.getByLabelText("Table"), "users");

      await waitFor(() => {
        expect(screen.getByLabelText("Policy Name")).toBeInTheDocument();
      });

      await user.type(screen.getByLabelText("Policy Name"), "allow_write");
      await user.selectOptions(screen.getByLabelText("Operation"), "insert");
      await user.selectOptions(screen.getByLabelText("Role"), "authenticated");
      await user.selectOptions(screen.getByLabelText("Condition"), "owner");

      await user.click(screen.getByRole("button", { name: /add policy/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/db/tables/users/policies",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              name: "allow_write",
              operation: "insert",
              role: "authenticated",
              condition: "owner",
            }),
          }),
        );
      });
    });
  });

  describe("Settings tab", () => {
    it("displays current auth settings", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Settings" }));

      await waitFor(() => {
        expect(screen.getByTestId("settings-tab")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText("Require Email Verification")).toBeInTheDocument();
        expect(screen.getByLabelText("Minimum Password Length")).toBeInTheDocument();
        expect(screen.getByText("Enable MFA")).toBeInTheDocument();
        expect(screen.getByLabelText("Webhook URL")).toBeInTheDocument();
      });
    });

    it("calls POST /auth/settings when saving settings", async () => {
      const user = userEvent.setup();
      render(<AuthSettingsPage projectId="proj-1" />);
      await user.click(screen.getByRole("tab", { name: "Settings" }));

      await waitFor(() => {
        expect(screen.getByTestId("settings-tab")).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByLabelText("Minimum Password Length")).toBeInTheDocument();
      });

      const pwInput = screen.getByLabelText("Minimum Password Length");
      await user.tripleClick(pwInput);
      await user.keyboard("12");

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          "/v1/projects/proj-1/auth/settings",
          expect.objectContaining({
            method: "POST",
            body: expect.stringContaining('"password_min_length":12'),
          }),
        );
      });
    });
  });
});
