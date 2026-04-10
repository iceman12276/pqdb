import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";

import {
  saveKeypair,
  loadKeypair,
  deleteKeypair,
} from "~/lib/keypair-store";

describe("keypair-store (IndexedDB)", () => {
  beforeEach(() => {
    // Reset IndexedDB state between tests so databases do not bleed across cases.
    globalThis.indexedDB = new IDBFactory();
  });

  it("saves and loads a keypair by developer id", async () => {
    const developerId = "11111111-1111-1111-1111-111111111111";
    const keypair = {
      publicKey: new Uint8Array([1, 2, 3, 4]),
      secretKey: new Uint8Array([5, 6, 7, 8]),
    };

    await saveKeypair(developerId, keypair);
    const loaded = await loadKeypair(developerId);

    expect(loaded).not.toBeNull();
    expect(loaded!.publicKey).toEqual(keypair.publicKey);
    expect(loaded!.secretKey).toEqual(keypair.secretKey);
  });

  it("returns null when no keypair is stored for the developer id", async () => {
    const loaded = await loadKeypair(
      "22222222-2222-2222-2222-222222222222",
    );
    expect(loaded).toBeNull();
  });

  it("keeps keypairs isolated per developer id", async () => {
    const devA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const devB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await saveKeypair(devA, {
      publicKey: new Uint8Array([1]),
      secretKey: new Uint8Array([2]),
    });
    await saveKeypair(devB, {
      publicKey: new Uint8Array([3]),
      secretKey: new Uint8Array([4]),
    });

    const a = await loadKeypair(devA);
    const b = await loadKeypair(devB);

    expect(a!.publicKey).toEqual(new Uint8Array([1]));
    expect(a!.secretKey).toEqual(new Uint8Array([2]));
    expect(b!.publicKey).toEqual(new Uint8Array([3]));
    expect(b!.secretKey).toEqual(new Uint8Array([4]));
  });

  it("overwrites an existing keypair for the same developer id", async () => {
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await saveKeypair(id, {
      publicKey: new Uint8Array([1]),
      secretKey: new Uint8Array([2]),
    });
    await saveKeypair(id, {
      publicKey: new Uint8Array([9]),
      secretKey: new Uint8Array([10]),
    });
    const loaded = await loadKeypair(id);
    expect(loaded!.publicKey).toEqual(new Uint8Array([9]));
    expect(loaded!.secretKey).toEqual(new Uint8Array([10]));
  });

  it("deletes a stored keypair", async () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await saveKeypair(id, {
      publicKey: new Uint8Array([1]),
      secretKey: new Uint8Array([2]),
    });
    await deleteKeypair(id);
    expect(await loadKeypair(id)).toBeNull();
  });

  it("uses database 'pqdb' with object store 'keypairs'", async () => {
    const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await saveKeypair(id, {
      publicKey: new Uint8Array([1]),
      secretKey: new Uint8Array([2]),
    });

    // Open the database directly and verify the expected structure.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("pqdb");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(db.name).toBe("pqdb");
    expect(Array.from(db.objectStoreNames)).toContain("keypairs");
    db.close();
  });
});
