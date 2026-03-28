import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createQueryWrapper } from "../query-wrapper";

const { mockCreateTable } = vi.hoisted(() => ({
  mockCreateTable: vi.fn(),
}));

vi.mock("~/lib/table-data", () => ({
  fetchTables: vi.fn().mockResolvedValue([]),
  createTable: mockCreateTable,
}));

import { CreateTableDialog } from "~/components/create-table-dialog";

describe("CreateTableDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderDialog(props: Partial<Parameters<typeof CreateTableDialog>[0]> = {}) {
    const user = userEvent.setup();
    const { wrapper, queryClient } = createQueryWrapper();
    const defaultProps = {
      apiKey: "pqdb_service_abc",
      projectId: "p1",
      open: true,
      onOpenChange: vi.fn(),
      ...props,
    };
    const result = render(<CreateTableDialog {...defaultProps} />, { wrapper });
    return { user, result, queryClient, onOpenChange: defaultProps.onOpenChange };
  }

  it("renders the dialog with form fields when open", () => {
    renderDialog();
    expect(screen.getByText("Create Table")).toBeInTheDocument();
    expect(screen.getByLabelText("Table Name")).toBeInTheDocument();
  });

  it("shows validation error for empty table name on submit", async () => {
    const { user } = renderDialog();
    // Try to submit without entering a table name
    const submitBtn = screen.getByRole("button", { name: /create$/i });
    await user.click(submitBtn);
    expect(screen.getByText("Table name is required")).toBeInTheDocument();
  });

  it("shows validation error for invalid table name", async () => {
    const { user } = renderDialog();
    const nameInput = screen.getByLabelText("Table Name");
    await user.type(nameInput, "2bad");
    const submitBtn = screen.getByRole("button", { name: /create$/i });
    await user.click(submitBtn);
    expect(screen.getByText("Must start with a lowercase letter")).toBeInTheDocument();
  });

  it("shows column required error when no columns defined", async () => {
    const { user } = renderDialog();
    const nameInput = screen.getByLabelText("Table Name");
    await user.type(nameInput, "users");
    // Remove default column
    const removeBtns = screen.queryAllByRole("button", { name: /remove column/i });
    for (const btn of removeBtns) {
      await user.click(btn);
    }
    const submitBtn = screen.getByRole("button", { name: /create$/i });
    await user.click(submitBtn);
    expect(screen.getByText("At least one column is required")).toBeInTheDocument();
  });

  it("can add and remove columns", async () => {
    const { user } = renderDialog();
    // Should start with one default column row
    const addBtn = screen.getByRole("button", { name: /add column/i });
    await user.click(addBtn);
    // Now there should be 2 column name inputs
    const nameInputs = screen.getAllByPlaceholderText("column_name");
    expect(nameInputs.length).toBe(2);

    // Remove one
    const removeBtns = screen.getAllByRole("button", { name: /remove column/i });
    await user.click(removeBtns[0]);
    expect(screen.getAllByPlaceholderText("column_name").length).toBe(1);
  });

  it("calls createTable on valid submit and closes dialog", async () => {
    mockCreateTable.mockResolvedValueOnce({ name: "users", columns: [] });
    const { user, onOpenChange } = renderDialog();

    // Fill table name
    const nameInput = screen.getByLabelText("Table Name");
    await user.type(nameInput, "users");

    // Fill column name in the default row
    const colNameInput = screen.getByPlaceholderText("column_name");
    await user.type(colNameInput, "id");

    // Submit
    const submitBtn = screen.getByRole("button", { name: /create$/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(mockCreateTable).toHaveBeenCalledWith(
        "pqdb_service_abc",
        "users",
        expect.arrayContaining([
          expect.objectContaining({ name: "id" }),
        ]),
      );
    });
  });

  it("shows error message when createTable fails", async () => {
    mockCreateTable.mockRejectedValueOnce(new Error("Failed to create table"));
    const { user } = renderDialog();

    const nameInput = screen.getByLabelText("Table Name");
    await user.type(nameInput, "users");
    const colNameInput = screen.getByPlaceholderText("column_name");
    await user.type(colNameInput, "id");

    const submitBtn = screen.getByRole("button", { name: /create$/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/failed to create table/i)).toBeInTheDocument();
    });
  });

  it("disables submit button when disabled prop is true", () => {
    renderDialog({ disabled: true });
    const submitBtn = screen.getByRole("button", { name: /create$/i });
    expect(submitBtn).toBeDisabled();
  });
});
