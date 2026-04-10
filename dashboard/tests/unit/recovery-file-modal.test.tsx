import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RecoveryFileModal } from "~/components/recovery-file-modal";

const DEVELOPER_ID = "11111111-1111-1111-1111-111111111111";
const EMAIL = "alice@example.com";
const PUBLIC_KEY = new Uint8Array([1, 2, 3, 4, 5]);
const SECRET_KEY = new Uint8Array([9, 8, 7, 6, 5]);

function renderModal(onClose = vi.fn()) {
  return render(
    <RecoveryFileModal
      developerId={DEVELOPER_ID}
      email={EMAIL}
      keypair={{ publicKey: PUBLIC_KEY, secretKey: SECRET_KEY }}
      onClose={onClose}
    />,
  );
}

describe("RecoveryFileModal", () => {
  beforeEach(() => {
    // Provide minimal URL.createObjectURL / revokeObjectURL stubs so JSDOM
    // doesn't throw when the modal triggers a Blob download.
    if (!("createObjectURL" in URL)) {
      (URL as unknown as { createObjectURL: () => string }).createObjectURL =
        vi.fn(() => "blob:mock");
    } else {
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    }
    if (!("revokeObjectURL" in URL)) {
      (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL =
        vi.fn();
    } else {
      vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    }
  });

  it("renders a Download recovery file button", () => {
    renderModal();
    expect(
      screen.getByRole("button", { name: /download recovery file/i }),
    ).toBeInTheDocument();
  });

  it("disables the close button until the user downloads or acknowledges", () => {
    renderModal();
    expect(
      screen.getByRole("button", { name: /^close$/i }),
    ).toBeDisabled();
  });

  it("enables the close button after clicking Download recovery file", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(
      screen.getByRole("button", { name: /download recovery file/i }),
    );

    expect(
      screen.getByRole("button", { name: /^close$/i }),
    ).toBeEnabled();
  });

  it("enables the close button after checking the acknowledgement checkbox", async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));

    expect(
      screen.getByRole("button", { name: /^close$/i }),
    ).toBeEnabled();
  });

  it("invokes onClose when the (enabled) close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(onClose);

    await user.click(screen.getByRole("checkbox", { name: /i understand/i }));
    await user.click(screen.getByRole("button", { name: /^close$/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("writes a parseable JSON recovery file with both keys base64-encoded", async () => {
    const user = userEvent.setup();

    // Capture the Blob passed to createObjectURL so we can read its contents.
    let capturedBlob: Blob | null = null;
    vi.spyOn(URL, "createObjectURL").mockImplementation((obj: Blob | MediaSource) => {
      capturedBlob = obj as Blob;
      return "blob:mock";
    });

    renderModal();
    await user.click(
      screen.getByRole("button", { name: /download recovery file/i }),
    );

    expect(capturedBlob).not.toBeNull();
    const text = await capturedBlob!.text();
    const parsed = JSON.parse(text);

    expect(parsed.version).toBe(1);
    expect(parsed.developer_id).toBe(DEVELOPER_ID);
    expect(parsed.email).toBe(EMAIL);
    expect(typeof parsed.public_key).toBe("string");
    expect(typeof parsed.private_key).toBe("string");
    expect(typeof parsed.created_at).toBe("string");
    expect(typeof parsed.warning).toBe("string");

    // Base64 should round-trip back to the original bytes.
    const pub = Uint8Array.from(atob(parsed.public_key), (c) =>
      c.charCodeAt(0),
    );
    const priv = Uint8Array.from(atob(parsed.private_key), (c) =>
      c.charCodeAt(0),
    );
    expect(pub).toEqual(PUBLIC_KEY);
    expect(priv).toEqual(SECRET_KEY);
  });

  it("sets the download filename to pqdb-recovery-{email}.json", async () => {
    const user = userEvent.setup();
    renderModal();

    // Intercept anchor clicks so we can read the download attribute.
    const originalCreate = document.createElement.bind(document);
    let capturedDownload: string | null = null;
    const spy = vi
      .spyOn(document, "createElement")
      .mockImplementation((tag: string) => {
        const el = originalCreate(tag);
        if (tag === "a") {
          const anchor = el as HTMLAnchorElement;
          const origClick = anchor.click.bind(anchor);
          anchor.click = () => {
            capturedDownload = anchor.download;
            origClick();
          };
        }
        return el;
      });

    await user.click(
      screen.getByRole("button", { name: /download recovery file/i }),
    );

    spy.mockRestore();
    expect(capturedDownload).toBe(`pqdb-recovery-${EMAIL}.json`);
  });
});
