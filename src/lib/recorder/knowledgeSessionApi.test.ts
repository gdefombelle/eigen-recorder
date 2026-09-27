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
import {
  startNowKnowledgeSession,
  getKnowledgeSessionMinutes,
  updateKnowledgeSessionMinutes,
  listKnowledgeSessionArtifacts,
  createKnowledgeSessionArtifact,
} from './knowledgeSessionApi';

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

// ── Post-session artifacts ────────────────────────────────────────────────────

describe('getKnowledgeSessionMinutes', () => {
  it('calls GET /knowledge-sessions/{id}/minutes/document with auth', async () => {
    const minutes = {
      id: 'min-001', session_id: 'sess-abc',
      content_json: { executive_summary: 'Q3 sprint done.', action_items: [{ action: 'Fix login bug' }] },
      status: 'draft', revision: 1, updated_at: '2026-09-26T10:00:00Z',
    };
    mockRequest.mockResolvedValueOnce(minutes);

    const result = await getKnowledgeSessionMinutes('sess-abc');

    expect(mockRequest).toHaveBeenCalledWith('/knowledge-sessions/sess-abc/minutes/document');
    expect(result.id).toBe('min-001');
    expect(result.status).toBe('draft');
    expect(result.revision).toBe(1);
  });

  it('propagates ApiError when backend returns 404', async () => {
    mockRequest.mockRejectedValueOnce(new Error('Not Found'));

    await expect(getKnowledgeSessionMinutes('no-such-session')).rejects.toThrow('Not Found');
  });
});

describe('listKnowledgeSessionArtifacts', () => {
  it('calls GET /knowledge-sessions/{id}/artifacts?scope=session', async () => {
    mockRequest.mockResolvedValueOnce([]);

    await listKnowledgeSessionArtifacts('sess-abc');

    expect(mockRequest).toHaveBeenCalledWith('/knowledge-sessions/sess-abc/artifacts?scope=session');
  });

  it('returns an empty array when no artifacts exist', async () => {
    mockRequest.mockResolvedValueOnce([]);

    const result = await listKnowledgeSessionArtifacts('sess-abc');

    expect(result).toEqual([]);
  });

  it('returns existing artifacts with correct shape', async () => {
    const artifact = {
      artifact_id: 'art-001', kind: 'mind_map', scope: 'session',
      title: 'Sprint mind map', body_markdown: '```evtx-mindmap\n{}\n```',
      source_session_ids: ['sess-abc'], citations: [], diagnostics: {},
      created_at: '2026-09-26T10:00:00Z',
    };
    mockRequest.mockResolvedValueOnce([artifact]);

    const result = await listKnowledgeSessionArtifacts('sess-abc');

    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('mind_map');
    expect(result[0].artifact_id).toBe('art-001');
  });
});

describe('updateKnowledgeSessionMinutes', () => {
  it('calls PUT /knowledge-sessions/{id}/minutes/document with content_json', async () => {
    const updated = {
      id: 'min-001', session_id: 'sess-abc',
      content_json: { executive_summary: 'Updated summary.' },
      status: 'draft', revision: 2, updated_at: '2026-09-26T11:00:00Z',
    };
    mockRequest.mockResolvedValueOnce(updated);

    const result = await updateKnowledgeSessionMinutes('sess-abc', {
      content_json: { executive_summary: 'Updated summary.' },
    });

    expect(mockRequest).toHaveBeenCalledWith(
      '/knowledge-sessions/sess-abc/minutes/document',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ content_json: { executive_summary: 'Updated summary.' } }),
      }),
    );
    expect(result.revision).toBe(2);
  });
});

describe('createKnowledgeSessionArtifact', () => {
  it('calls POST /knowledge-sessions/{id}/artifacts with correct body', async () => {
    const artifact = {
      artifact_id: 'art-002', kind: 'mind_map', scope: 'session',
      title: 'Generated mind map', body_markdown: '',
      source_session_ids: ['sess-abc'], citations: [], diagnostics: {},
      created_at: '2026-09-26T10:00:00Z',
    };
    mockRequest.mockResolvedValueOnce(artifact);

    const result = await createKnowledgeSessionArtifact('sess-abc', 'mind_map', 'fr');

    expect(mockRequest).toHaveBeenCalledWith(
      '/knowledge-sessions/sess-abc/artifacts',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'mind_map', scope: 'session', preferred_language: 'fr' }),
      }),
    );
    expect(result.kind).toBe('mind_map');
    expect(result.artifact_id).toBe('art-002');
  });

  it('defaults preferred_language to fr', async () => {
    mockRequest.mockResolvedValueOnce({
      artifact_id: 'art-003', kind: 'mind_map', scope: 'session',
      title: 'Map', body_markdown: '', source_session_ids: [],
      citations: [], diagnostics: {}, created_at: '',
    });

    await createKnowledgeSessionArtifact('sess-abc', 'mind_map');

    const body = JSON.parse(mockRequest.mock.calls[0][1].body);
    expect(body.preferred_language).toBe('fr');
    expect(body.scope).toBe('session');
  });
});
