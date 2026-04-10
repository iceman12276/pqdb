import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";

const { mockGetEncryptionKey } = vi.hoisted(() => ({
  mockGetEncryptionKey: vi.fn(),
}));

vi.mock("~/lib/keypair-context", () => ({
  useEnvelopeKeys: () => ({
    getEncryptionKey: mockGetEncryptionKey,
  }),
}));

import { RevealEncryptionKey } from "~/components/reveal-encryption-key";

describe("RevealEncryptionKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Encryption Key heading", () => {
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);
    expect(screen.getByText("Encryption Key")).toBeInTheDocument();
  });

  it("shows Reveal button when key is available but hidden", () => {
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);
    expect(
      screen.getByRole("button", { name: /reveal/i }),
    ).toBeInTheDocument();
    // Key should not be visible
    expect(screen.queryByDisplayValue("test-key-abc123")).not.toBeInTheDocument();
  });

  it("shows key in read-only input after clicking Reveal", async () => {
    const user = userEvent.setup();
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);

    await user.click(screen.getByRole("button", { name: /reveal/i }));

    const input = screen.getByDisplayValue("test-key-abc123");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("readOnly");
  });

  it("shows Copy and Hide buttons after revealing", async () => {
    const user = userEvent.setup();
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);

    await user.click(screen.getByRole("button", { name: /reveal/i }));

    expect(
      screen.getByRole("button", { name: /copy/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /hide/i }),
    ).toBeInTheDocument();
  });

  it("hides key when Hide is clicked", async () => {
    const user = userEvent.setup();
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);

    await user.click(screen.getByRole("button", { name: /reveal/i }));
    expect(screen.getByDisplayValue("test-key-abc123")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /hide/i }));
    expect(screen.queryByDisplayValue("test-key-abc123")).not.toBeInTheDocument();
    // Reveal button should be back
    expect(
      screen.getByRole("button", { name: /reveal/i }),
    ).toBeInTheDocument();
  });

  it("copies key to clipboard when Copy is clicked", async () => {
    const user = userEvent.setup();
    const mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });

    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);

    await user.click(screen.getByRole("button", { name: /reveal/i }));
    await user.click(screen.getByRole("button", { name: /copy/i }));

    expect(mockWriteText).toHaveBeenCalledWith("test-key-abc123");
  });

  it("shows warning text about key security", () => {
    mockGetEncryptionKey.mockReturnValue("test-key-abc123");
    render(<RevealEncryptionKey projectId="proj-1" />);
    expect(
      screen.getByText(/never stored by pqdb/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/permanently unrecoverable/i),
    ).toBeInTheDocument();
  });

  it("shows unavailable message when key is null", () => {
    mockGetEncryptionKey.mockReturnValue(null);
    render(<RevealEncryptionKey projectId="proj-1" />);

    expect(
      screen.getByText(/encryption key not available/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/log in with your password/i),
    ).toBeInTheDocument();
    // No Reveal button
    expect(
      screen.queryByRole("button", { name: /reveal/i }),
    ).not.toBeInTheDocument();
  });

  it("calls getEncryptionKey with the correct projectId", () => {
    mockGetEncryptionKey.mockReturnValue("some-key");
    render(<RevealEncryptionKey projectId="proj-42" />);
    expect(mockGetEncryptionKey).toHaveBeenCalledWith("proj-42");
  });
});
