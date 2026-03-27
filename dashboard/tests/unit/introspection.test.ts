import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchIndexes, fetchPublications } from "~/lib/introspection";

describe("introspection fetch functions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("fetchIndexes", () => {
    it("calls the correct endpoint with apikey header", async () => {
      const mockResponse = [
        {
          name: "users_pkey",
          table: "users",
          definition: "CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id)",
          unique: true,
          size_bytes: 16384,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchIndexes("test-api-key");

      expect(globalThis.fetch).toHaveBeenCalledWith("/v1/db/catalog/indexes", {
        headers: { apikey: "test-api-key" },
      });
      expect(result).toEqual(mockResponse);
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetchIndexes("test-api-key")).rejects.toThrow(
        "Failed to fetch indexes",
      );
    });
  });

  describe("fetchPublications", () => {
    it("calls the correct endpoint with apikey header", async () => {
      const mockResponse = [
        {
          name: "my_pub",
          all_tables: false,
          insert: true,
          update: true,
          delete: false,
          tables: ["users"],
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await fetchPublications("test-api-key");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/v1/db/catalog/publications",
        {
          headers: { apikey: "test-api-key" },
        },
      );
      expect(result).toEqual(mockResponse);
    });

    it("throws on non-ok response", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      await expect(fetchPublications("test-api-key")).rejects.toThrow(
        "Failed to fetch publications",
      );
    });
  });
});
