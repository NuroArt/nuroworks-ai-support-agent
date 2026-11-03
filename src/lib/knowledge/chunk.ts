/**
 * Split on paragraph boundaries, then pack paragraphs up to a size budget.
 *
 * Fixed-width character windows cut sentences in half and the retrieved context
 * reads as gibberish. Packing whole paragraphs keeps each chunk self-contained.
 */
const TARGET = 1200;   // characters, roughly 300 tokens
const OVERLAP = 200;   // carry the tail of the previous chunk for continuity

export function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];

  const paras = clean.split(/\n\n+/);
  const chunks: string[] = [];
  let buf = '';

  for (const p of paras) {
    // A single oversized paragraph still has to be broken, but on sentence ends.
    if (p.length > TARGET) {
      if (buf.trim()) { chunks.push(buf.trim()); buf = ''; }
      let rest = p;
      while (rest.length > TARGET) {
        const window = rest.slice(0, TARGET);
        const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('\n'));
        const at = cut > TARGET * 0.5 ? cut + 1 : TARGET;
        chunks.push(rest.slice(0, at).trim());
        rest = rest.slice(at);
      }
      if (rest.trim()) buf = rest.trim() + '\n\n';
      continue;
    }

    if ((buf + p).length > TARGET && buf.trim()) {
      chunks.push(buf.trim());
      buf = buf.slice(-OVERLAP);
    }
    buf += p + '\n\n';
  }

  if (buf.trim()) chunks.push(buf.trim());
  return chunks.filter((c) => c.length > 40);   // drop headings-only fragments
}
