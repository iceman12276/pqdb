import { describe, it, expect, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EncryptionProvider, useEncryption } from "~/lib/encryption-context";

function TestConsumer() {
  const { encryptionKey, isUnlocked, unlock, lock } = useEncryption();
  return (
    <div>
      <span data-testid="status">{isUnlocked ? "unlocked" : "locked"}</span>
      <span data-testid="key">{encryptionKey ?? "none"}</span>
      <button onClick={() => unlock("my-secret-key")}>Unlock</button>
      <button onClick={() => lock()}>Lock</button>
    </div>
  );
}

describe("EncryptionContext", () => {
  it("starts in locked state with no key", () => {
    render(
      <EncryptionProvider>
        <TestConsumer />
      </EncryptionProvider>,
    );
    expect(screen.getByTestId("status")).toHaveTextContent("locked");
    expect(screen.getByTestId("key")).toHaveTextContent("none");
  });

  it("unlocks when key is provided", async () => {
    const user = userEvent.setup();
    render(
      <EncryptionProvider>
        <TestConsumer />
      </EncryptionProvider>,
    );

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    expect(screen.getByTestId("status")).toHaveTextContent("unlocked");
    expect(screen.getByTestId("key")).toHaveTextContent("my-secret-key");
  });

  it("locks and clears key", async () => {
    const user = userEvent.setup();
    render(
      <EncryptionProvider>
        <TestConsumer />
      </EncryptionProvider>,
    );

    await user.click(screen.getByRole("button", { name: /unlock/i }));
    expect(screen.getByTestId("status")).toHaveTextContent("unlocked");

    await user.click(screen.getByRole("button", { name: /^lock$/i }));
    expect(screen.getByTestId("status")).toHaveTextContent("locked");
    expect(screen.getByTestId("key")).toHaveTextContent("none");
  });

  it("returns defaults when used outside provider", () => {
    render(<TestConsumer />);
    expect(screen.getByTestId("status")).toHaveTextContent("locked");
    expect(screen.getByTestId("key")).toHaveTextContent("none");
  });
});
