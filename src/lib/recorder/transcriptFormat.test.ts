import { describe, it, expect } from 'vitest';
import { splitIntoParagraphs } from './transcriptFormat';

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
