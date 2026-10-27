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

/** Formats a millisecond offset as mm:ss, e.g. 6400 -> "00:06". */
export function fmtMs(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Whether `currentMs` falls within [startMs, endMs) — used to highlight the
 * transcript segment the audio player is currently on. A null/undefined
 * startMs means the segment has no timing at all (not active); a null/
 * undefined endMs means "still going" (e.g. the last/only segment), not
 * "never active".
 */
export function isTimeInRange(
  currentMs: number,
  startMs: number | null | undefined,
  endMs: number | null | undefined,
): boolean {
  if (startMs == null) return false;
  return currentMs >= startMs && (endMs == null || currentMs < endMs);
}

/**
 * A raw internal id has no value to a viewer — drop lines like
 * "Session ID: 167c5ee5-4fe0-4144-85f3-193196fd48ff" from an insight
 * artifact's preamble entirely rather than showing them.
 */
export function isNoiseLine(line: string): boolean {
  return /^session\s*id\s*:/i.test(line.trim());
}

/**
 * Reformats a Timeline preamble line of the form
 * "Date & Time: 2026-10-27, 02:38 PM (UTC)" into the viewer's local
 * timezone, e.g. "Date & Time: Oct 27, 2026, 2:38 PM". Returns the line
 * unchanged if it doesn't match that exact backend-generated shape.
 */
export function localizeDateTimeLine(line: string): string {
  const m = line.match(
    /^(date\s*&\s*time\s*:\s*)(\d{4})-(\d{2})-(\d{2}),\s*(\d{1,2}):(\d{2})\s*([AP]M)\s*\(UTC\)\s*$/i,
  );
  if (!m) return line;
  const [, label, year, month, day, hour12Raw, minute, ampm] = m;
  let hour = Number(hour12Raw) % 12;
  if (ampm.toUpperCase() === 'PM') hour += 12;
  const utcDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, Number(minute)));
  const formatted = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(utcDate);
  return `${label}${formatted}`;
}

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
