import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockCreateProject } = vi.hoisted(() => ({
  mockCreateProject: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  createProject: mockCreateProject,
}));

const { mockUseEnvelopeKeys, mockGenerateEncryptionKey, mockWrapKey } =
  vi.hoisted(() => ({
    mockUseEnvelopeKeys: vi.fn(),
    mockGenerateEncryptionKey: vi.fn(),
    mockWrapKey: vi.fn(),
  }));

vi.mock("~/lib/envelope-key-context", () => ({
  useEnvelopeKeys: mockUseEnvelopeKeys,
  uint8ArrayToBase64: (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)),
}));

vi.mock("~/lib/envelope-crypto", () => ({
  generateEncryptionKey: mockGenerateEncryptionKey,
  wrapKey: mockWrapKey,
}));

import { CreateProjectDialog } from "~/components/create-project-dialog";

const fakeWrappingKey = {} as CryptoKey;

function setupEnvelopeKeys(overrides: Record<string, unknown> = {}) {
  const defaults = {
    wrappingKey: null,
    encryptionKeys: new Map(),
    setWrappingKey: vi.fn(),
    clearKeys: vi.fn(),
    getEncryptionKey: vi.fn(() => null),
    addEncryptionKey: vi.fn(),
    unwrapProjectKeys: vi.fn(),
  };
  mockUseEnvelopeKeys.mockReturnValue({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

const createdProject = {
  id: "new-id",
  name: "New Project",
  region: "us-east-1",
  status: "active",
  database_name: "pqdb_project_new",
  created_at: "2026-03-18T00:00:00Z",
  wrapped_encryption_key: null,
  api_keys: [
    {
      id: "k1",
      role: "anon",
      key: "pqdb_anon_abc123",
      key_prefix: "pqdb_anon_abc",
    },
  ],
};

describe("CreateProjectDialog", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onCreated: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setupEnvelopeKeys();
  });

  it("renders the dialog when open", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByText(/create project/i)).toBeInTheDocument();
  });

  it("renders name input field", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByLabelText(/project name/i)).toBeInTheDocument();
  });

  it("shows default region as static text", () => {
    render(<CreateProjectDialog {...defaultProps} />);
    expect(screen.getByText(/us-east-1 \(default\)/)).toBeInTheDocument();
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

  it("calls createProject without wrappedEncryptionKey when no wrapping key (OAuth)", async () => {
    const user = userEvent.setup();
    setupEnvelopeKeys({ wrappingKey: null });
    mockCreateProject.mockResolvedValueOnce(createdProject);

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith(
        "New Project",
        "us-east-1",
        undefined,
      );
    });
    expect(mockGenerateEncryptionKey).not.toHaveBeenCalled();
    expect(mockWrapKey).not.toHaveBeenCalled();
  });

  it("generates and wraps encryption key when wrapping key is available", async () => {
    const user = userEvent.setup();
    const mockAddEncryptionKey = vi.fn();
    setupEnvelopeKeys({
      wrappingKey: fakeWrappingKey,
      addEncryptionKey: mockAddEncryptionKey,
    });

    const fakeEncKey = "fake-encryption-key-base64url";
    const fakeWrappedBlob = new Uint8Array([1, 2, 3, 4, 5]);
    mockGenerateEncryptionKey.mockReturnValue(fakeEncKey);
    mockWrapKey.mockResolvedValue(fakeWrappedBlob);
    mockCreateProject.mockResolvedValueOnce({
      ...createdProject,
      id: "proj-123",
    });

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockGenerateEncryptionKey).toHaveBeenCalledOnce();
      expect(mockWrapKey).toHaveBeenCalledWith(fakeEncKey, fakeWrappingKey);
    });

    // Verify createProject was called with the base64 wrapped key
    const wrappedKeyArg = mockCreateProject.mock.calls[0][2];
    expect(typeof wrappedKeyArg).toBe("string");
    expect(wrappedKeyArg.length).toBeGreaterThan(0);
  });

  it("stores encryption key in context after successful project creation", async () => {
    const user = userEvent.setup();
    const mockAddEncryptionKey = vi.fn();
    setupEnvelopeKeys({
      wrappingKey: fakeWrappingKey,
      addEncryptionKey: mockAddEncryptionKey,
    });

    const fakeEncKey = "fake-enc-key";
    mockGenerateEncryptionKey.mockReturnValue(fakeEncKey);
    mockWrapKey.mockResolvedValue(new Uint8Array([10, 20, 30]));
    mockCreateProject.mockResolvedValueOnce({
      ...createdProject,
      id: "proj-456",
    });

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockAddEncryptionKey).toHaveBeenCalledWith(
        "proj-456",
        fakeEncKey,
      );
    });
  });

  it("does not store encryption key if wrapping key is null", async () => {
    const user = userEvent.setup();
    const mockAddEncryptionKey = vi.fn();
    setupEnvelopeKeys({
      wrappingKey: null,
      addEncryptionKey: mockAddEncryptionKey,
    });
    mockCreateProject.mockResolvedValueOnce(createdProject);

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "New Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalled();
    });
    expect(mockAddEncryptionKey).not.toHaveBeenCalled();
  });

  it("calls onCreated with project data on success", async () => {
    const user = userEvent.setup();
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
