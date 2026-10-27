import { describe, it, expect } from 'vitest';
import { splitIntoParagraphs, isNoiseLine, localizeDateTimeLine } from './transcriptFormat';

describe('splitIntoParagraphs', () => {
  it('returns an empty array for empty or whitespace-only input', () => {
    expect(splitIntoParagraphs('')).toEqual([]);
    expect(splitIntoParagraphs('   ')).toEqual([]);
  });

  it('keeps a short segment (1-2 sentences) as a single paragraph', () => {
    const text = 'We will chat for a bit. I have a little monitor over here.';
    expect(splitIntoParagraphs(text)).toEqual([text]);
  });

  it('groups three sentences per paragraph and carries the remainder', () => {
    const sentences = [
      'One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.', 'Seven.',
    ];
    const text = sentences.join(' ');
    const result = splitIntoParagraphs(text);

    expect(result).toEqual([
      'One. Two. Three.',
      'Four. Five. Six.',
      'Seven.',
    ]);
  });

  it('keeps a trailing partial sentence with no terminal punctuation', () => {
    const text = 'One. Two. Three. and then it trails off';
    const result = splitIntoParagraphs(text);

    expect(result).toEqual([
      'One. Two. Three.',
      'and then it trails off',
    ]);
  });

  it('handles a single long run-on sentence with no punctuation at all', () => {
    const text = 'word '.repeat(50).trim();
    expect(splitIntoParagraphs(text)).toEqual([text]);
  });

  it('collapses stray whitespace between sentences', () => {
    const text = 'One.   Two.\nThree.   Four.';
    expect(splitIntoParagraphs(text)).toEqual(['One. Two. Three.', 'Four.']);
  });
});

describe('isNoiseLine', () => {
  it('detects a "Session ID" line regardless of case', () => {
    expect(isNoiseLine('Session ID: 167c5ee5-4fe0-4144-85f3-193196fd48ff')).toBe(true);
    expect(isNoiseLine('session id:abc')).toBe(true);
  });

  it('does not flag ordinary content lines', () => {
    expect(isNoiseLine('Date & Time: 2026-10-27, 02:38 PM (UTC)')).toBe(false);
    expect(isNoiseLine('Speaker announces something.')).toBe(false);
  });
});

describe('localizeDateTimeLine', () => {
  it('leaves non-matching lines unchanged', () => {
    expect(localizeDateTimeLine('Location: Paris')).toBe('Location: Paris');
    expect(localizeDateTimeLine('Date & Time: not a real date')).toBe('Date & Time: not a real date');
  });

  it('converts a UTC "Date & Time" line to the local timezone and drops the UTC marker', () => {
    const input = 'Date & Time: 2026-10-27, 02:38 PM (UTC)';
    const result = localizeDateTimeLine(input);
    expect(result).not.toBe(input);
    expect(result).not.toContain('UTC');
    expect(result.startsWith('Date & Time: ')).toBe(true);
  });

  it('converts 12 AM and 12 PM to genuinely different instants (no off-by-12 bug)', () => {
    const am = localizeDateTimeLine('Date & Time: 2026-10-27, 12:00 AM (UTC)');
    const pm = localizeDateTimeLine('Date & Time: 2026-10-27, 12:00 PM (UTC)');
    expect(am).not.toBe(pm);
  });
});
