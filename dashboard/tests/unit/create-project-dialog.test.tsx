import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockCreateProject } = vi.hoisted(() => ({
  mockCreateProject: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  createProject: mockCreateProject,
}));

import { CreateProjectDialog } from "~/components/create-project-dialog";

describe("CreateProjectDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the dialog when open", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByText(/create project/i)).toBeInTheDocument();
  });

  it("renders name input field", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
  });

  it("renders region select with default", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByLabelText(/region/i)).toBeInTheDocument();
  });

  it("shows validation error when name is empty", async () => {
    const user = userEvent.setup();
    render(<CreateProjectDialog {...defaultProps} />);

    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText(/project name is required/i),
    ).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });

  it("calls createProject with name and region on submit", async () => {
    const user = userEvent.setup();
    mockCreateProject.mockResolvedValueOnce({
      id: "new-id",
      name: "New Project",
      region: "us-east-1",
      status: "active",
      database_name: "pqdb_project_new",
      created_at: "2026-03-18T00:00:00Z",
      api_keys: [],
    });

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith("New Project", "us-east-1");
    });
  });

  it("calls onCreated with project data on success", async () => {
    const user = userEvent.setup();
    const createdProject = {
      id: "new-id",
      name: "New Project",
      region: "us-east-1",
      status: "active",
      database_name: "pqdb_project_new",
      created_at: "2026-03-18T00:00:00Z",
      api_keys: [
        { id: "k1", role: "anon", key: "pqdb_anon_abc123", key_prefix: "pqdb_anon_abc" },
      ],
    };
    mockCreateProject.mockResolvedValueOnce(createdProject);

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(defaultProps.onCreated).toHaveBeenCalledWith(createdProject);
    });
  });

  it("shows error message on create failure", async () => {
    const user = userEvent.setup();
    mockCreateProject.mockRejectedValueOnce(new Error("Name already taken"));

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "Duplicate");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(await screen.findByText(/name already taken/i)).toBeInTheDocument();
  });

  it("disables submit button while creating", async () => {
    const user = userEvent.setup();
    let resolveCreate: (value: unknown) => void;
    mockCreateProject.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "Test");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
    });

    resolveCreate!({
      id: "x",
      name: "Test",
      region: "us-east-1",
      status: "active",
      database_name: null,
      created_at: "2026-03-18T00:00:00Z",
      api_keys: [],
    });
  });
});
