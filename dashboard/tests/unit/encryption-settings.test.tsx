import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { EncryptionSettings } from "~/components/encryption-settings";

describe("EncryptionSettings", () => {
  it("renders the Encryption section heading", () => {
    render(<EncryptionSettings />);
    expect(screen.getByText("Encryption")).toBeInTheDocument();
  });

  it("shows the zero-knowledge model explanation", () => {
    render(<EncryptionSettings />);
    expect(
      screen.getByText(/zero-knowledge/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/never sent to the server/i),
    ).toBeInTheDocument();
  });

  it("shows the key type (ML-KEM-768)", () => {
    render(<EncryptionSettings />);
    expect(screen.getByText(/ML-KEM-768/)).toBeInTheDocument();
  });

  it("explains what the key protects", () => {
    render(<EncryptionSettings />);
    expect(screen.getByText("searchable")).toBeInTheDocument();
    expect(screen.getByText("private")).toBeInTheDocument();
    expect(screen.getByText(/encrypted with your key/i)).toBeInTheDocument();
  });

  it("explains what happens if the key is lost", () => {
    render(<EncryptionSettings />);
    expect(
      screen.getByText(/permanently unrecoverable/i),
    ).toBeInTheDocument();
  });

  it("shows backup recommendations", () => {
    render(<EncryptionSettings />);
    expect(screen.getAllByText(/password manager/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/secure vault/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/offline backup/i).length).toBeGreaterThanOrEqual(1);
  });
});
