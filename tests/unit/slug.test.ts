import { describe, expect, it } from "vitest";

import { slugify } from "@/lib/slug";

describe("slugify", () => {
  it("lowercases and hyphenates a normal business name", () => {
    expect(slugify("Kente & Co.")).toBe("kente-co");
  });

  it("collapses repeated separators", () => {
    expect(slugify("  Multiple   Spaces  ")).toBe("multiple-spaces");
  });

  it("strips characters outside the allowed set", () => {
    expect(slugify("Café Déjà Vu!!!")).toBe("caf-dj-vu");
  });
});
