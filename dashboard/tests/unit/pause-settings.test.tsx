import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockFetchProject, mockPauseProject, mockRestoreProject } = vi.hoisted(
  () => ({
    mockFetchProject: vi.fn(),
    mockPauseProject: vi.fn(),
    mockRestoreProject: vi.fn(),
  }),
);

vi.mock("~/lib/projects", () => ({
  fetchProject: mockFetchProject,
  pauseProject: mockPauseProject,
  restoreProject: mockRestoreProject,
}));

import { PauseSettings } from "~/components/pause-settings";

const activeProject = {
  id: "p1",
  name: "My App",
  region: "us-east-1",
  status: "active",
  database_name: "pqdb_project_abc123",
  created_at: "2026-01-15T10:00:00Z",
  wrapped_encryption_key: null,
};

const pausedProject = {
  ...activeProject,
  status: "paused",
};

describe("PauseSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Pause button when project is active", async () => {
    mockFetchProject.mockResolvedValueOnce(activeProject);
    const { wrapper } = createQueryWrapper();
    render(<PauseSettings projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /pause project/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows Restore button when project is paused", async () => {
    mockFetchProject.mockResolvedValueOnce(pausedProject);
    const { wrapper } = createQueryWrapper();
    render(<PauseSettings projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /restore project/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows confirmation dialog when Pause button is clicked", async () => {
    const user = userEvent.setup();
    mockFetchProject.mockResolvedValueOnce(activeProject);
    const { wrapper } = createQueryWrapper();
    render(<PauseSettings projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /pause project/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /pause project/i }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Pausing will block all API requests. Continue?",
        ),
      ).toBeInTheDocument();
    });
  });

  it("calls pauseProject when confirmation is accepted", async () => {
    const user = userEvent.setup();
    mockFetchProject.mockResolvedValueOnce(activeProject);
    mockPauseProject.mockResolvedValueOnce(pausedProject);
    const { wrapper } = createQueryWrapper();
    render(<PauseSettings projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /pause project/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /pause project/i }));

    await waitFor(() => {
      expect(
        screen.getByText("Pausing will block all API requests. Continue?"),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /^pause$/i }));

    await waitFor(() => {
      expect(mockPauseProject).toHaveBeenCalledWith("p1");
    });
  });

  it("calls restoreProject when Restore button is clicked", async () => {
    const user = userEvent.setup();
    mockFetchProject.mockResolvedValueOnce(pausedProject);
    mockRestoreProject.mockResolvedValueOnce(activeProject);
    const { wrapper } = createQueryWrapper();
    render(<PauseSettings projectId="p1" />, { wrapper });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /restore project/i }),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /restore project/i }));

    await waitFor(() => {
      expect(mockRestoreProject).toHaveBeenCalledWith("p1");
    });
  });
});
