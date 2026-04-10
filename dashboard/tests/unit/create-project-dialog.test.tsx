import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mockCreateProject } = vi.hoisted(() => ({
  mockCreateProject: vi.fn(),
}));

vi.mock("~/lib/projects", () => ({
  createProject: mockCreateProject,
}));

const { mockUseKeypair, mockUseEnvelopeKeys, mockEncapsulate } = vi.hoisted(
  () => ({
    mockUseKeypair: vi.fn(),
    mockUseEnvelopeKeys: vi.fn(),
    mockEncapsulate: vi.fn(),
  }),
);

vi.mock("~/lib/keypair-context", () => ({
  useKeypair: mockUseKeypair,
  useEnvelopeKeys: mockUseEnvelopeKeys,
  uint8ArrayToBase64: (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)),
}));

vi.mock("@pqdb/client", () => ({
  encapsulate: mockEncapsulate,
}));

import { CreateProjectDialog } from "~/components/create-project-dialog";

function setupKeypair(
  overrides: Partial<{
    publicKey: Uint8Array | null;
    privateKey: Uint8Array | null;
    loaded: boolean;
    error: string | null;
  }> = {},
) {
  const defaults = {
    publicKey: null,
    privateKey: null,
    loaded: true,
    error: null,
  };
  mockUseKeypair.mockReturnValue({ ...defaults, ...overrides });
}

function setupEnvelopeKeys(overrides: Record<string, unknown> = {}) {
  const defaults = {
    wrappingKey: null,
    encryptionKeys: new Map(),
    setWrappingKey: vi.fn(),
    clearKeys: vi.fn(),
    getEncryptionKey: vi.fn(() => null),
    addEncryptionKey: vi.fn(),
    setProjectEncryptionKey: vi.fn(),
    unwrapProjectKeys: vi.fn(),
  };
  mockUseEnvelopeKeys.mockReturnValue({ ...defaults, ...overrides });
  return { ...defaults, ...overrides };
}

const fakePublicKey = new Uint8Array(1184); // ML-KEM-768 public key is 1184 bytes
const fakeCiphertext = new Uint8Array([10, 20, 30, 40, 50]);
const fakeSharedSecret = new Uint8Array(32); // 32-byte shared secret
fakeSharedSecret.fill(0xab);

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
    setupKeypair();
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

  it("calls encapsulate(publicKey), POSTs base64 ciphertext, stores sharedSecret in context", async () => {
    const user = userEvent.setup();
    const mockSetProjectEncryptionKey = vi.fn();
    setupKeypair({ publicKey: fakePublicKey });
    setupEnvelopeKeys({
      setProjectEncryptionKey: mockSetProjectEncryptionKey,
    });

    mockEncapsulate.mockResolvedValueOnce({
      ciphertext: fakeCiphertext,
      sharedSecret: fakeSharedSecret,
    });
    mockCreateProject.mockResolvedValueOnce({
      ...createdProject,
      id: "proj-encap",
    });

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "PQC Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      // Verify encapsulate was called with the public key
      expect(mockEncapsulate).toHaveBeenCalledWith(fakePublicKey);
    });

    // Verify createProject was called with base64-encoded ciphertext
    const wrappedKeyArg = mockCreateProject.mock.calls[0][2];
    expect(typeof wrappedKeyArg).toBe("string");
    // base64 of fakeCiphertext [10, 20, 30, 40, 50]
    const expectedBase64 = btoa(String.fromCharCode(...fakeCiphertext));
    expect(wrappedKeyArg).toBe(expectedBase64);

    // Verify shared secret was stored in context
    expect(mockSetProjectEncryptionKey).toHaveBeenCalledWith(
      "proj-encap",
      fakeSharedSecret,
    );
  });

  it("does not call encapsulate when publicKey is null (keypair not loaded)", async () => {
    const user = userEvent.setup();
    setupKeypair({ publicKey: null });
    mockCreateProject.mockResolvedValueOnce(createdProject);

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "No Key Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(mockCreateProject).toHaveBeenCalledWith(
        "No Key Project",
        "us-east-1",
        undefined,
      );
    });
    expect(mockEncapsulate).not.toHaveBeenCalled();
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

  it("shows error when encapsulate fails", async () => {
    const user = userEvent.setup();
    setupKeypair({ publicKey: fakePublicKey });
    setupEnvelopeKeys();

    mockEncapsulate.mockRejectedValueOnce(new Error("Encapsulation failed"));

    render(<CreateProjectDialog {...defaultProps} />);

    await user.type(screen.getByLabelText(/project name/i), "Fail Project");
    await user.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText(/encapsulation failed/i),
    ).toBeInTheDocument();
    expect(mockCreateProject).not.toHaveBeenCalled();
  });
});
