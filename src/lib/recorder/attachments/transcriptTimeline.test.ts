import { describe, it, expect } from 'vitest';
import { interleaveAttachments } from './transcriptTimeline';

const seg = (start_ms: number | null, text = `s${start_ms}`) => ({ start_ms, text });
const att = (start_offset_ms: number, id = `a${start_offset_ms}`) => ({ start_offset_ms, id });
const shape = (items: ReturnType<typeof interleaveAttachments<ReturnType<typeof seg>, ReturnType<typeof att>>>) =>
  items.map((i) => (i.type === 'segment' ? i.segment.text : i.attachment.id));

describe('interleaveAttachments', () => {
  it('the mockup case: 00:09 sits after the 00:08 segment, 00:21 after 00:17', () => {
    const items = interleaveAttachments([seg(0), seg(8_000), seg(17_000), seg(30_000)], [att(9_000), att(21_000)]);
    expect(shape(items)).toEqual(['s0', 's8000', 'a9000', 's17000', 'a21000', 's30000']);
  });

  it('an attachment at exactly a segment start goes AFTER that segment (speech was already under way)', () => {
    expect(shape(interleaveAttachments([seg(0), seg(8_000)], [att(8_000)]))).toEqual(['s0', 's8000', 'a8000']);
  });

  it('before the first segment → first; after the last → last', () => {
    expect(shape(interleaveAttachments([seg(5_000), seg(9_000)], [att(1_000), att(99_000)]))).toEqual(['a1000', 's5000', 's9000', 'a99000']);
  });

  it('several attachments at the same position keep their relative order', () => {
    const items = interleaveAttachments([seg(0), seg(20_000)], [att(5_000, 'first'), att(5_000, 'second')]);
    expect(shape(items)).toEqual(['s0', 'first', 'second', 's20000']);
  });

  it('given out of order, they are still placed by offset', () => {
    expect(shape(interleaveAttachments([seg(0), seg(10_000), seg(20_000)], [att(15_000), att(5_000)]))).toEqual(['s0', 'a5000', 's10000', 'a15000', 's20000']);
  });

  it('a segment with no start time never pulls an attachment ahead of it', () => {
    expect(shape(interleaveAttachments([seg(0), seg(null, 'untimed'), seg(10_000)], [att(5_000)]))).toEqual(['s0', 'untimed', 'a5000', 's10000']);
  });

  it('no transcript yet: attachments still show, in timeline order', () => {
    expect(shape(interleaveAttachments([], [att(9_000), att(2_000)]))).toEqual(['a2000', 'a9000']);
  });

  it('no attachments: the transcript is unchanged', () => {
    expect(shape(interleaveAttachments([seg(0), seg(8_000)], []))).toEqual(['s0', 's8000']);
  });

  it('does not mutate its inputs', () => {
    const attachments = [att(9_000), att(1_000)];
    interleaveAttachments([seg(0)], attachments);
    expect(attachments.map((a) => a.start_offset_ms)).toEqual([9_000, 1_000]);
  });
});
