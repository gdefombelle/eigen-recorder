// transcriptFormat.ts — splits a long transcript segment's text into readable
// paragraphs, grouping a few sentences at a time.
//
// Purely presentational. The backend returns one segment per speaker turn —
// during a long uninterrupted stretch of speech (solo dictation, a long
// answer in an interview) that can be several hundred words with no internal
// structure, rendered as a single run-on block otherwise. This doesn't touch
// the data (timestamps still belong to the segment as a whole, not invented
// per paragraph) — it only breaks the block up for readability.

const SENTENCES_PER_PARAGRAPH = 3;

export function splitIntoParagraphs(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const sentences = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g) ?? [trimmed];
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    const s = sentence.trim();
    if (!s) continue;
    current.push(s);
    if (current.length >= SENTENCES_PER_PARAGRAPH) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));

  return paragraphs;
}
