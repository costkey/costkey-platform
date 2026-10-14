import { describe, expect, it, vi } from "vitest";
import { loadChunk } from "./chunkLoad";

describe("loadChunk", () => {
  it("retries a chunk that failed to load once", async () => {
    const load = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module")).mockResolvedValue({ default: "page" });
    await expect(loadChunk(load)).resolves.toEqual({ default: "page" });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
