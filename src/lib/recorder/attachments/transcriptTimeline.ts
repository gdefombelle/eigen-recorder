// transcriptTimeline — places attachments in a transcript at the minute they were added.
//
// start_offset_ms and a segment's start_ms share one referential (audio timeline,
// pauses excluded), so an attachment simply goes before the first segment that
// starts AFTER it. At the same instant the segment comes first: the speech was
// already under way when the photo was taken.

export type TimelineItem<S, A> =
  | { type: 'segment';    segment: S; }
  | { type: 'attachment'; attachment: A };

export function interleaveAttachments<S extends { start_ms?: number | null }, A extends { start_offset_ms: number }>(
  segments: readonly S[],
  attachments: readonly A[],
): Array<TimelineItem<S, A>> {
  const pending = [...attachments].sort((a, b) => a.start_offset_ms - b.start_offset_ms);   // stable: ties keep given order
  const out: Array<TimelineItem<S, A>> = [];
  let next = 0;

  for (const segment of segments) {
    // A segment without a start time has no position of its own: it never pulls attachments ahead of it.
    if (segment.start_ms != null) {
      while (next < pending.length && pending[next].start_offset_ms < segment.start_ms) {
        out.push({ type: 'attachment', attachment: pending[next++] });
      }
    }
    out.push({ type: 'segment', segment });
  }
  while (next < pending.length) out.push({ type: 'attachment', attachment: pending[next++] });
  return out;
}
