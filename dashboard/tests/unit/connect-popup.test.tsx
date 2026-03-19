import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockFetchProjectKeys } = vi.hoisted(() => ({
  mockFetchProjectKeys: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  fetchProjectKeys: mockFetchProjectKeys,
}));

import { ConnectPopup } from "~/components/connect-popup";

const mockKeys = [
  {
    id: "k1",
    role: "anon",
    key_prefix: "pqdb_anon_abc",
    created_at: "2026-01-15T10:00:00Z",
  },
  {
    id: "k2",
    role: "service_role",
    key_prefix: "pqdb_service_role_xyz",
    created_at: "2026-01-15T10:00:00Z",
  },
];

describe("ConnectPopup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows 'Select a project' when no project is selected", () => {
    render(<ConnectPopup projectId={null} projectName={null} />);
    expect(screen.getByText(/select a project first/i)).toBeInTheDocument();
  });

  it("fetches and displays API keys for selected project", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    render(<ConnectPopup projectId="p1" projectName="My App" />);

    expect(await screen.findByText("anon")).toBeInTheDocument();
    expect(screen.getByText("service_role")).toBeInTheDocument();
  });

  it("displays masked key prefixes", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    render(<ConnectPopup projectId="p1" projectName="My App" />);

    await waitFor(() => {
      const matches = screen.getAllByText(/pqdb_anon_abc/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows SDK connection snippet", async () => {
    mockFetchProjectKeys.mockResolvedValueOnce(mockKeys);
    render(<ConnectPopup projectId="p1" projectName="My App" />);

    await waitFor(() => {
      expect(screen.getByText(/createClient/)).toBeInTheDocument();
    });
  });

  it("shows loading state while fetching keys", () => {
    mockFetchProjectKeys.mockReturnValue(new Promise(() => {}));
    render(<ConnectPopup projectId="p1" projectName="My App" />);
    expect(screen.getByTestId("connect-loading")).toBeInTheDocument();
  });
});
