import { describe, it, expect } from 'vitest';
import { extractMarkdownTable, formatMsRange, splitAroundTable } from './markdownTable';

describe('extractMarkdownTable', () => {
  it('returns null when there is no table', () => {
    expect(extractMarkdownTable('Just plain text.\n- a bullet\n- another')).toBeNull();
  });

  it('parses a header, separator and data rows', () => {
    const md = [
      'Date & Time: 2026-10-27, 02:38 PM (UTC)',
      'Location: Allée François Rabelais 17, Noisy-le-Roi',
      '',
      '| Timecode (ms) | Event | Source |',
      '|--|--|--|',
      '| 2700-6400 | Speaker announces that several actions will be undertaken simultaneously. | [S1-T1] |',
      '| 7800-14100 | Plan to run a test of the new Live-Room presentation in Eigen Pocket. | [S1-T2] |',
    ].join('\n');

    const table = extractMarkdownTable(md);
    expect(table).not.toBeNull();
    expect(table!.headers).toEqual(['Timecode (ms)', 'Event', 'Source']);
    expect(table!.rows).toEqual([
      ['2700-6400', 'Speaker announces that several actions will be undertaken simultaneously.', '[S1-T1]'],
      ['7800-14100', 'Plan to run a test of the new Live-Room presentation in Eigen Pocket.', '[S1-T2]'],
    ]);
  });

  it('does not misidentify a non-separator pipe line as the header/separator pair', () => {
    const md = '| a | b |\n| c | d |\n| e | f |';
    // No row of dashes anywhere — this isn't a real table by markdown rules.
    expect(extractMarkdownTable(md)).toBeNull();
  });

  it('stops collecting rows at the first non-pipe line', () => {
    const md = [
      '| H1 | H2 |',
      '|--|--|',
      '| a | b |',
      '',
      'Some trailing prose that is not part of the table.',
    ].join('\n');
    const table = extractMarkdownTable(md);
    expect(table!.rows).toEqual([['a', 'b']]);
  });
});

describe('splitAroundTable', () => {
  it('returns the whole input as `before` when there is no table', () => {
    const md = 'Just plain text.\n- a bullet';
    expect(splitAroundTable(md)).toEqual({ before: md, table: null, after: '' });
  });

  it('splits the prose before the table from the table itself', () => {
    const md = [
      'Date & Time: 2026-10-27, 02:38 PM (UTC)',
      'Location: Allée François Rabelais 17, Noisy-le-Roi',
      '',
      '| Timecode (ms) | Event | Source |',
      '|--|--|--|',
      '| 2700-6400 | Speaker announces. | [S1-T1] |',
    ].join('\n');

    const result = splitAroundTable(md);
    expect(result.before).toBe(
      'Date & Time: 2026-10-27, 02:38 PM (UTC)\nLocation: Allée François Rabelais 17, Noisy-le-Roi\n',
    );
    expect(result.table).toEqual({
      headers: ['Timecode (ms)', 'Event', 'Source'],
      rows: [['2700-6400', 'Speaker announces.', '[S1-T1]']],
    });
    expect(result.after).toBe('');
  });
});

describe('formatMsRange', () => {
  it('formats a start-end millisecond range as mm:ss', () => {
    expect(formatMsRange('2700-6400')).toBe('00:02–00:06');
  });

  it('formats a single millisecond value as mm:ss', () => {
    expect(formatMsRange('7800')).toBe('00:07');
  });

  it('returns the input unchanged when it does not look like a ms value', () => {
    expect(formatMsRange('[S1-T1]')).toBe('[S1-T1]');
    expect(formatMsRange('')).toBe('');
  });
});
