import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchBackupStats } = vi.hoisted(() => ({
  mockFetchBackupStats: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchBackupStats: mockFetchBackupStats,
}));

import { BackupsPage } from "~/components/backups-page";
import type { BackupStats } from "~/lib/introspection";

const mockStats: BackupStats = {
  archived_count: 42,
  failed_count: 3,
  last_archived_wal: "000000010000000000000010",
  last_archived_time: "2026-03-30T12:00:00+00:00",
  last_failed_wal: "000000010000000000000005",
  last_failed_time: "2026-03-29T08:00:00+00:00",
};

const emptyStats: BackupStats = {
  archived_count: 0,
  failed_count: 0,
  last_archived_wal: null,
  last_archived_time: null,
  last_failed_wal: null,
  last_failed_time: null,
};

describe("BackupsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchBackupStats.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("backups-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchBackupStats.mockRejectedValueOnce(
      new Error("Failed to fetch backup stats"),
    );
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(
      await screen.findByText(/failed to fetch backup stats/i),
    ).toBeInTheDocument();
  });

  it("shows empty state when WAL archiving is not configured", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(emptyStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(
      await screen.findByText(/wal archiving is not configured/i),
    ).toBeInTheDocument();
  });

  it("shows info banner about backup management", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(emptyStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(
      await screen.findByText(/backup management is handled by your database provider/i),
    ).toBeInTheDocument();
  });

  it("renders archived count when archiving is active", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("42")).toBeInTheDocument();
    });
  });

  it("renders failed count when archiving is active", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("3")).toBeInTheDocument();
    });
  });

  it("shows last archived WAL name", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(
      await screen.findByText("000000010000000000000010"),
    ).toBeInTheDocument();
  });

  it("shows last failed WAL name", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(
      await screen.findByText("000000010000000000000005"),
    ).toBeInTheDocument();
  });

  it("shows last archived time", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(
      await screen.findByText(/2026-03-30/),
    ).toBeInTheDocument();
  });

  it("shows last failed time", async () => {
    mockFetchBackupStats.mockResolvedValueOnce(mockStats);
    const { wrapper } = createQueryWrapper();
    render(<BackupsPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(
      await screen.findByText(/2026-03-29/),
    ).toBeInTheDocument();
  });
});
