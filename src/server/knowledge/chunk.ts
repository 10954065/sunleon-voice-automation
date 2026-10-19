const DEFAULT_MAX_CHUNK_CHARS = 800;
const DEFAULT_OVERLAP_CHARS = 100;

/**
 * Splits text into overlapping chunks on paragraph boundaries where possible,
 * falling back to hard character splits for single paragraphs longer than the limit.
 * Pure and deterministic — no I/O, no provider calls.
 */
export function chunkText(
  text: string,
  options: { maxChars?: number; overlapChars?: number } = {}
): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS;
  const overlapChars = options.overlapChars ?? DEFAULT_OVERLAP_CHARS;

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = paragraph.length <= maxChars ? paragraph : "";
    }

    if (paragraph.length > maxChars) {
      chunks.push(...splitLongParagraph(paragraph, maxChars, overlapChars));
      current = "";
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongParagraph(paragraph: string, maxChars: number, overlapChars: number): string[] {
  const pieces: string[] = [];
  let start = 0;

  while (start < paragraph.length) {
    const end = Math.min(start + maxChars, paragraph.length);
    pieces.push(paragraph.slice(start, end));
    if (end >= paragraph.length) break;
    start = end - overlapChars;
  }

  return pieces;
}
