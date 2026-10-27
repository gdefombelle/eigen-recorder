// markdownTable.ts — extracts a markdown pipe table from an insight
// artifact's body_markdown, for insight kinds (Timeline, in practice) the
// backend renders as a table rather than a bullet list.
//
// Gabriel's report: the Timeline insight showed raw rows like
// "| 2700-6400 | Speaker announces... | [S1-T1] |" one per card, because
// the existing line-by-line markdown splitter has no concept of table
// syntax — it just strips bullets/bold/links per line and renders each
// line verbatim, pipes included.

import { fmtMs } from './transcriptFormat';

export interface MarkdownTable {
  headers: string[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

const isPipeLine = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparatorRow = (cells: string[]) =>
  cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.trim()));

/** Line range (inclusive start, exclusive end) spanned by the first table found, or null. */
function findTableBounds(lines: string[]): { start: number; end: number } | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isPipeLine(lines[i]) || !isPipeLine(lines[i + 1])) continue;
    if (!isSeparatorRow(splitRow(lines[i + 1]))) continue;

    let end = i + 2;
    while (end < lines.length && isPipeLine(lines[end])) end++;
    return { start: i, end };
  }
  return null;
}

/** Extracts the first markdown pipe table found in `md`, or null if none. */
export function extractMarkdownTable(md: string): MarkdownTable | null {
  const lines = md.split('\n');
  const bounds = findTableBounds(lines);
  if (!bounds) return null;

  return {
    headers: splitRow(lines[bounds.start]),
    rows: lines.slice(bounds.start + 2, bounds.end).map(splitRow),
  };
}

/**
 * Splits `md` into the text before the first table, the table itself
 * (or null if there isn't one), and the text after it — so a caller can
 * render the surrounding prose with its normal line-based parser while
 * rendering the table rows structurally.
 */
export function splitAroundTable(md: string): { before: string; table: MarkdownTable | null; after: string } {
  const lines = md.split('\n');
  const bounds = findTableBounds(lines);
  if (!bounds) return { before: md, table: null, after: '' };

  return {
    before: lines.slice(0, bounds.start).join('\n'),
    table: {
      headers: splitRow(lines[bounds.start]),
      rows: lines.slice(bounds.start + 2, bounds.end).map(splitRow),
    },
    after: lines.slice(bounds.end).join('\n'),
  };
}

/**
 * Formats a "start-end" (or single) millisecond range as mm:ss, e.g.
 * "2700-6400" -> "00:02–00:06". Returns the raw string unchanged if it
 * doesn't match either shape — this is presentation only, never silently
 * drop data we can't confidently reformat.
 */
export function formatMsRange(raw: string): string {
  const range = raw.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) return `${fmtMs(Number(range[1]))}–${fmtMs(Number(range[2]))}`;
  const single = raw.match(/^(\d+)$/);
  if (single) return fmtMs(Number(single[1]));
  return raw;
}
