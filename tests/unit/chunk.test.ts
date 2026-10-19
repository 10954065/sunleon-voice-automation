import { describe, expect, it } from "vitest";

import { chunkText } from "@/server/knowledge/chunk";

describe("chunkText", () => {
  it("returns an empty array for blank input", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("keeps short text as a single chunk", () => {
    const chunks = chunkText("A short paragraph about a business.");
    expect(chunks).toEqual(["A short paragraph about a business."]);
  });

  it("groups multiple short paragraphs into one chunk under the limit", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const chunks = chunkText(text, { maxChars: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain("First paragraph.");
    expect(chunks[0]).toContain("Second paragraph.");
  });

  it("splits into separate chunks once the limit is exceeded", () => {
    const text = "A".repeat(50) + "\n\n" + "B".repeat(50);
    const chunks = chunkText(text, { maxChars: 60, overlapChars: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 60)).toBe(true);
  });

  it("hard-splits a single paragraph longer than the max with overlap", () => {
    const text = "X".repeat(220);
    const chunks = chunkText(text, { maxChars: 100, overlapChars: 20 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]).toHaveLength(100);
  });
});
