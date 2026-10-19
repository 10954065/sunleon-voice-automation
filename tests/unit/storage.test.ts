import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalDiskStorageAdapter } from "@/server/knowledge/storage";

describe("LocalDiskStorageAdapter", () => {
  let dir: string;
  let adapter: LocalDiskStorageAdapter;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sunleon-storage-test-"));
    adapter = new LocalDiskStorageAdapter(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a file through put and get", async () => {
    const key = await adapter.put(Buffer.from("hello world"), "txt");
    expect(key.endsWith(".txt")).toBe(true);

    const contents = await adapter.get(key);
    expect(contents.toString("utf-8")).toBe("hello world");
  });

  it("generates distinct keys for repeated uploads", async () => {
    const keyA = await adapter.put(Buffer.from("a"), "txt");
    const keyB = await adapter.put(Buffer.from("b"), "txt");
    expect(keyA).not.toBe(keyB);
  });

  it("deletes a stored file without throwing if it is already gone", async () => {
    const key = await adapter.put(Buffer.from("temp"), "txt");
    await adapter.delete(key);
    await expect(adapter.delete(key)).resolves.toBeUndefined();
  });
});
