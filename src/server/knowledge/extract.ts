import { load as loadHtml } from "cheerio";
import { parse as parseCsv } from "csv-parse/sync";

export class UnsupportedFileTypeError extends Error {}

export async function extractTextFromFile(buffer: Buffer, extension: string): Promise<string> {
  const normalizedExt = extension.toLowerCase().replace(/^\./, "");

  switch (normalizedExt) {
    case "pdf": {
      const { PDFParse } = await import("pdf-parse");
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result.text;
      } finally {
        await parser.destroy();
      }
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case "txt":
    case "md":
      return buffer.toString("utf-8");
    case "csv": {
      const rows: string[][] = parseCsv(buffer.toString("utf-8"), { skip_empty_lines: true });
      return rows.map((row) => row.join(" — ")).join("\n\n");
    }
    default:
      throw new UnsupportedFileTypeError(`Unsupported file type: .${normalizedExt}`);
  }
}

/** Extracts readable text from an HTML page, dropping scripts/styles/nav chrome. */
export function extractTextFromHtml(html: string): string {
  const $ = loadHtml(html);
  $("script, style, noscript, nav, footer, header, svg").remove();
  const text = $("body").text();
  return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
