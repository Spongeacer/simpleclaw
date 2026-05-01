/**
 * SimpleClaw — Markdown Chunker
 * Splits markdown by headings (h1/h2/h3) for semantic chunking.
 * Simpler and more semantic than token-based chunking.
 */

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

/** Split markdown content by headings. Each chunk = one heading section. */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentStart = 1;

  const flush = (endLine: number) => {
    if (current.length === 0) return;
    const text = current.join("\n").trim();
    if (text) {
      chunks.push({
        text,
        startLine: currentStart,
        endLine,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Heading boundary: h1, h2, or h3
    if (/^#{1,3}\s/.test(line)) {
      flush(i); // end previous chunk at line before heading
      current = [line];
      currentStart = i + 1;
    } else {
      current.push(line);
    }
  }

  flush(lines.length);
  return chunks;
}

/** Extract exports from TypeScript/JavaScript code. */
export function extractExports(code: string): string[] {
  const exports: string[] = [];
  const patterns = [
    /export\s+(?:default\s+)?(?:class|function|interface|type|const|let|var)\s+(\w+)/g,
    /export\s*\{\s*([^}]+)\}\s*from/g,
    /export\s*\{\s*([^}]+)\}\s*;/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      if (match[1]) {
        const names = match[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim());
        exports.push(...names.filter(n => n && !n.startsWith("//")));
      }
    }
  }
  return [...new Set(exports)];
}

/** Extract first JSDoc/comment description from a file. */
export function extractDescription(code: string): string | undefined {
  // Try JSDoc on first exported item
  const jsdocMatch = code.match(/\/\*\*\s*\n([\s\S]*?)\*\/\s*\n\s*export/);
  if (jsdocMatch) {
    const desc = jsdocMatch[1]
      .split("\n")
      .map(l => l.replace(/^\s*\*\s?/, "").trim())
      .filter(l => l && !l.startsWith("@"))
      .join(" ")
      .slice(0, 200);
    return desc || undefined;
  }
  // Fallback: first line comment before export
  const lineMatch = code.match(/(?:\/\/\s*(.+?)\n\s*)+export/);
  if (lineMatch) {
    return lineMatch[0].replace(/\/\/\s*/g, "").replace(/\n\s*export.*/, "").trim().slice(0, 200) || undefined;
  }
  return undefined;
}
