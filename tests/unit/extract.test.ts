import { describe, expect, it } from "vitest";

import { extractTextFromFile, extractTextFromHtml, UnsupportedFileTypeError } from "@/server/knowledge/extract";

describe("extractTextFromFile", () => {
  it("reads plain text files as-is", async () => {
    const text = await extractTextFromFile(Buffer.from("Hello business hours: 9am-5pm"), "txt");
    expect(text).toBe("Hello business hours: 9am-5pm");
  });

  it("reads markdown files as-is", async () => {
    const text = await extractTextFromFile(Buffer.from("# Heading\nBody"), "md");
    expect(text).toBe("# Heading\nBody");
  });

  it("joins CSV columns per row", async () => {
    const csv = "question,answer\nWhat are your hours?,9am-5pm\n";
    const text = await extractTextFromFile(Buffer.from(csv), "csv");
    expect(text).toContain("question — answer");
    expect(text).toContain("What are your hours? — 9am-5pm");
  });

  it("rejects an unsupported extension", async () => {
    await expect(extractTextFromFile(Buffer.from("x"), "exe")).rejects.toBeInstanceOf(
      UnsupportedFileTypeError
    );
  });
});

describe("extractTextFromHtml", () => {
  it("strips scripts, styles, and nav chrome, keeping body text", () => {
    const html = `
      <html><body>
        <nav>Site Nav</nav>
        <script>trackEvent();</script>
        <style>.x{color:red}</style>
        <main><h1>Welcome</h1><p>We are open 9am-5pm.</p></main>
      </body></html>
    `;
    const text = extractTextFromHtml(html);
    expect(text).toContain("Welcome");
    expect(text).toContain("We are open 9am-5pm.");
    expect(text).not.toContain("Site Nav");
    expect(text).not.toContain("trackEvent");
  });
});
