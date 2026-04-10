import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as React from "react";

// Hoisted mocks
const { mockUseProjectDecapsulate } = vi.hoisted(() => ({
  mockUseProjectDecapsulate: vi.fn(),
}));

vi.mock("~/lib/use-project-decapsulate", () => ({
  useProjectDecapsulate: mockUseProjectDecapsulate,
}));

import { ProjectDecapsulateGate } from "~/lib/project-decapsulate-gate";

describe("ProjectDecapsulateGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders children when status is 'ready'", () => {
    mockUseProjectDecapsulate.mockReturnValue({ status: "ready", error: null });

    render(
      <ProjectDecapsulateGate projectId="p1" wrappedEncryptionKey="AAAA">
        <p>Project content</p>
      </ProjectDecapsulateGate>,
    );

    expect(screen.getByText("Project content")).toBeDefined();
  });

  it("shows 'no encryption key configured' banner when status is 'no-key'", () => {
    mockUseProjectDecapsulate.mockReturnValue({ status: "no-key", error: null });

    render(
      <ProjectDecapsulateGate projectId="p2" wrappedEncryptionKey={null}>
        <p>Project content</p>
      </ProjectDecapsulateGate>,
    );

    expect(
      screen.getByText(
        "This project has no encryption key configured. Sensitive columns will be unavailable.",
      ),
    ).toBeDefined();
    // Children should still render — project is usable for plain columns
    expect(screen.getByText("Project content")).toBeDefined();
  });

  it("shows 'could not decrypt' error when status is 'error'", () => {
    mockUseProjectDecapsulate.mockReturnValue({
      status: "error",
      error:
        "Could not decrypt this project. You may need to upload a different recovery file.",
    });

    render(
      <ProjectDecapsulateGate projectId="p3" wrappedEncryptionKey="AAAA">
        <p>Project content</p>
      </ProjectDecapsulateGate>,
    );

    expect(
      screen.getByText(
        "Could not decrypt this project. You may need to upload a different recovery file.",
      ),
    ).toBeDefined();
    // Children should still render — project is usable for plain columns
    expect(screen.getByText("Project content")).toBeDefined();
  });

  it("shows loading state when status is 'loading'", () => {
    mockUseProjectDecapsulate.mockReturnValue({
      status: "loading",
      error: null,
    });

    render(
      <ProjectDecapsulateGate projectId="p4" wrappedEncryptionKey="AAAA">
        <p>Project content</p>
      </ProjectDecapsulateGate>,
    );

    // Children still render during loading — decapsulation is non-blocking
    expect(screen.getByText("Project content")).toBeDefined();
  });

  it("shows no-keypair banner when status is 'no-keypair'", () => {
    mockUseProjectDecapsulate.mockReturnValue({
      status: "no-keypair",
      error: null,
    });

    render(
      <ProjectDecapsulateGate projectId="p5" wrappedEncryptionKey="AAAA">
        <p>Project content</p>
      </ProjectDecapsulateGate>,
    );

    expect(
      screen.getByText(
        "Could not decrypt this project. You may need to upload a different recovery file.",
      ),
    ).toBeDefined();
    expect(screen.getByText("Project content")).toBeDefined();
  });
});
