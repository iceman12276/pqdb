import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchReplication } = vi.hoisted(() => ({
  mockFetchReplication: vi.fn(),
}));

vi.mock("~/lib/introspection", () => ({
  fetchReplication: mockFetchReplication,
}));

import { ReplicationPage } from "~/components/replication-page";
import type { ReplicationInfo } from "~/lib/introspection";

const mockData: ReplicationInfo = {
  slots: [
    {
      slot_name: "my_slot",
      slot_type: "logical",
      active: true,
      restart_lsn: "0/1234567",
      confirmed_flush_lsn: "0/1234568",
    },
    {
      slot_name: "standby_slot",
      slot_type: "physical",
      active: false,
      restart_lsn: "0/AABBCCD",
      confirmed_flush_lsn: null,
    },
  ],
  stats: [
    {
      client_addr: "192.168.1.100",
      state: "streaming",
      sent_lsn: "0/1234567",
      write_lsn: "0/1234567",
      replay_lsn: "0/1234566",
      replay_lag: "00:00:01.234",
    },
  ],
};

describe("ReplicationPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows loading skeletons while fetching", () => {
    mockFetchReplication.mockReturnValue(new Promise(() => {}));
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(screen.getByTestId("replication-loading")).toBeInTheDocument();
  });

  it("shows error state on fetch failure", async () => {
    mockFetchReplication.mockRejectedValueOnce(new Error("Failed to fetch replication status"));
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/failed to fetch replication status/i)).toBeInTheDocument();
  });

  it("shows empty state when no replication configured", async () => {
    mockFetchReplication.mockResolvedValueOnce({ slots: [], stats: [] });
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });
    expect(await screen.findByText(/no replication configured/i)).toBeInTheDocument();
  });

  it("renders replication slots table", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("my_slot")).toBeInTheDocument();
    expect(screen.getByText("standby_slot")).toBeInTheDocument();
  });

  it("shows slot type for each slot", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("my_slot")).toBeInTheDocument();
    });
    expect(screen.getByText("logical")).toBeInTheDocument();
    expect(screen.getByText("physical")).toBeInTheDocument();
  });

  it("shows active status badge", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("my_slot")).toBeInTheDocument();
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
  });

  it("renders active replication connections", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("192.168.1.100")).toBeInTheDocument();
    });
    expect(screen.getByText("streaming")).toBeInTheDocument();
  });

  it("shows replay lag for active connections", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    await waitFor(() => {
      expect(screen.getByText("192.168.1.100")).toBeInTheDocument();
    });
    expect(screen.getByText("00:00:01.234")).toBeInTheDocument();
  });

  it("shows heading text", async () => {
    mockFetchReplication.mockResolvedValueOnce(mockData);
    const { wrapper } = createQueryWrapper();
    render(<ReplicationPage projectId="p1" apiKey="pqdb_anon_abc" />, { wrapper });

    expect(await screen.findByText("Replication")).toBeInTheDocument();
  });
});
