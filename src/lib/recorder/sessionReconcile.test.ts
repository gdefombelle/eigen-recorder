import { describe, it, expect } from 'vitest';
import { isEndedOnServer } from './sessionReconcile';

const at = '2026-11-03T17:50:00Z';

describe('isEndedOnServer', () => {
  it.each([['completed', null], ['completed', at], ['closed', at]])('%s (ended_at %s) → ended', (status, ended_at) => {
    expect(isEndedOnServer({ status, ended_at })).toBe(true);
  });

  it.each([['processing_live'], ['processing_offline']])('%s WITH ended_at → ended (finalization may still be running)', (status) => {
    expect(isEndedOnServer({ status, ended_at: at })).toBe(true);
  });

  it.each([['processing_live'], ['processing_offline']])('%s WITHOUT ended_at → not ended (processing_live also exists while a record is live)', (status) => {
    expect(isEndedOnServer({ status, ended_at: null })).toBe(false);
  });

  it.each([['recording'], ['paused'], ['draft'], ['ready'], ['']])('%s → not ended', (status) => {
    expect(isEndedOnServer({ status, ended_at: null })).toBe(false);
  });

  it('cancelled is never "sent", even with an ended_at', () => {
    expect(isEndedOnServer({ status: 'cancelled', ended_at: at })).toBe(false);
  });

  it('an unknown future status is not treated as ended', () => {
    expect(isEndedOnServer({ status: 'archived', ended_at: at })).toBe(false);
  });
});
