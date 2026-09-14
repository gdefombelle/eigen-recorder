/**
 * Regression tests for startNowKnowledgeSession() response normalisation.
 *
 * The backend returns a nested structure { session: {…}, room: {…} }.
 * The function must map it to the flat StartNowResponse used by the rest of
 * the app — and must throw if session.id is absent so the caller never
 * propagates `undefined` to a subsequent /devices call.
 *
 * See: bug "POST /knowledge-sessions/undefined/devices" (2026-09-14)
 * where the old flat-response assumption produced `started.id === undefined`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

// ── Mock $lib/auth/api so we never hit the network ───────────────────────────
vi.mock('$lib/auth/api', () => ({
  request: vi.fn(),
}));

// ── Mock local deps that aren't relevant here ────────────────────────────────
vi.mock('$lib/platform', () => ({ isNative: () => false }));
vi.mock('./audioRecorder', () => ({ getSupportedMimeType: () => 'audio/webm' }));

import { request } from '$lib/auth/api';
import { startNowKnowledgeSession } from './knowledgeSessionApi';

const mockRequest = request as ReturnType<typeof vi.fn>;

afterEach(() => { vi.clearAllMocks(); });

// ── helpers ───────────────────────────────────────────────────────────────────

function wireResponse(overrides: Record<string, unknown> = {}) {
  return {
    session: { id: 'sess-uuid-123', status: 'ready', title: 'My Session' },
    room:    { id: 'room-uuid-456' },
    ...overrides,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('startNowKnowledgeSession — response normalisation', () => {

  it('maps nested { session, room } to flat StartNowResponse', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse());

    const result = await startNowKnowledgeSession({ title: 'My Session' });

    expect(result.id).toBe('sess-uuid-123');
    expect(result.room_id).toBe('room-uuid-456');
    expect(result.status).toBe('ready');
    expect(result.title).toBe('My Session');
  });

  it('handles null room (room not yet created)', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse({ room: null }));

    const result = await startNowKnowledgeSession({ title: 'Test' });

    expect(result.id).toBe('sess-uuid-123');
    expect(result.room_id).toBeNull();
  });

  it('throws a clear error when session.id is missing — prevents /undefined/devices', async () => {
    // Simulate a malformed backend response (missing session.id)
    mockRequest.mockResolvedValueOnce({ session: { status: 'ready', title: 'X' }, room: null });

    await expect(startNowKnowledgeSession({ title: 'X' }))
      .rejects
      .toThrow('Invalid start-now response: missing session id');
  });

  it('throws when session object itself is absent', async () => {
    mockRequest.mockResolvedValueOnce({ room: { id: 'room-uuid' } });

    await expect(startNowKnowledgeSession({ title: 'X' }))
      .rejects
      .toThrow('Invalid start-now response: missing session id');
  });

  it('result.id is never the string "undefined"', async () => {
    mockRequest.mockResolvedValueOnce(wireResponse());

    const result = await startNowKnowledgeSession({ title: 'Test' });

    expect(result.id).not.toBe('undefined');
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
  });
});
