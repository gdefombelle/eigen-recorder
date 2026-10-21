/**
 * Tests for recorderStore.mockUpload()'s resume logic.
 *
 * Context: a sync retry (Settings "Synchroniser" / the sessions-list Sync
 * action) used to always call startNowKnowledgeSession() + registerDevice()
 * from scratch, even when a PREVIOUS attempt had already created the backend
 * session and device and only failed on a later step (chunk upload or
 * /stop timing out). Since the backend does not honor `request_id` as an
 * idempotency key on start-now (confirmed by reading
 * eigenvertex/src/api/routes/knowledge_sessions.py — the field is accepted
 * but never read), a blind retry from scratch after a partial success risks
 * creating a duplicate backend session.
 *
 * The fix: a session already carrying knowledge_session_id + device_id +
 * metadata.recorded_offline is treated as "resumable" — creation and device
 * registration are skipped, already-uploaded chunks are skipped, and only
 * the remaining work (chunk upload, /stop) is retried.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { ApiError } from '$lib/auth/api';
import type { LocalKnowledgeSession, AudioChunkMetadata } from './types';

// ── Mocks ────────────────────────────────────────────────────────────────

const mockGetSession       = vi.fn();
const mockSaveSession      = vi.fn().mockResolvedValue(undefined);
const mockGetChunksMeta    = vi.fn();
const mockGetChunkBlob     = vi.fn();
const mockUpdateChunkStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('./offlineStorage', () => ({
  offlineStorage: {
    getSession:          (...a: unknown[]) => mockGetSession(...a),
    saveSession:         (...a: unknown[]) => mockSaveSession(...a),
    getChunksMeta:       (...a: unknown[]) => mockGetChunksMeta(...a),
    getChunkBlob:        (...a: unknown[]) => mockGetChunkBlob(...a),
    updateChunkStatus:   (...a: unknown[]) => mockUpdateChunkStatus(...a),
    getAllSessions:      vi.fn().mockResolvedValue([]),
    getTotalStorageBytes: vi.fn().mockResolvedValue(0),
  },
}));

const mockStartNow      = vi.fn();
const mockRegisterDevice = vi.fn();
const mockUploadChunk   = vi.fn();
const mockStop          = vi.fn();
vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          (...a: unknown[]) => mockStartNow(...a),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    (...a: unknown[]) => mockRegisterDevice(...a),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              vi.fn(),
  stopRecordingDevice:               (...a: unknown[]) => mockStop(...a),
  uploadAudioChunk:                  (...a: unknown[]) => mockUploadChunk(...a),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('$lib/auth/auth', () => ({
  getUser:         vi.fn().mockReturnValue({ token: 't' }),
  isAuthenticated: vi.fn().mockReturnValue(true),
  authStore:       { subscribe: vi.fn() },
}));

vi.mock('./audioRecorder', () => ({
  AudioRecorder: vi.fn(),
  getSupportedMimeType: vi.fn().mockReturnValue('audio/webm'),
}));
vi.mock('./nativeAudioRecorder', () => ({ NativeAudioRecorder: vi.fn() }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { enqueue: vi.fn(), } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn() }));
vi.mock('$lib/platform', () => ({ isNative: () => false }));

import { recorderStore } from './recorderStore';

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  return {
    local_session_id:     'local-1',
    remote_session_id:    null,
    knowledge_session_id: null,
    room_id:              null,
    device_id:            null,
    title:                'Note',
    session_type:         'voice_note',
    mode:                 'offline',
    subject:              '',
    agenda:               '',
    participants:         [],
    location_label:       null,
    created_at:           '2026-01-01T00:00:00Z',
    started_at:           '2026-01-01T00:00:00Z',
    ended_at:             null,
    duration_ms:          12_000,
    status:               'stopped_local',
    metadata:             { recorded_offline: true, device_name: 'iPhone' },
    ...overrides,
  };
}

function makeChunk(overrides: Partial<AudioChunkMetadata> = {}): AudioChunkMetadata {
  return {
    local_chunk_id:   'chunk-1',
    local_session_id: 'local-1',
    chunk_index:      0,
    start_ms:         0,
    end_ms:           5000,
    mime_type:        'audio/webm',
    size_bytes:       1000,
    saved_at:         '2026-01-01T00:00:00Z',
    uploaded_at:      null,
    status:           'saved',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetChunkBlob.mockResolvedValue(new Blob(['x']));
  mockUploadChunk.mockResolvedValue(undefined);
});

// ── Half-flushed session: resume skips creation + already-uploaded chunks ──

describe('mockUpload — resuming a half-flushed session', () => {
  it('skips startNowKnowledgeSession and registerDevice when backend context already exists', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
      room_id:                'room-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([makeChunk()]);
    mockStop.mockResolvedValue(undefined);

    await recorderStore.mockUpload('local-1');

    expect(mockStartNow).not.toHaveBeenCalled();
    expect(mockRegisterDevice).not.toHaveBeenCalled();
    expect(get(recorderStore).state).toBe('synced');
  });

  it('does not re-upload a chunk already marked uploaded', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([
      makeChunk({ local_chunk_id: 'c1', status: 'uploaded' }),
      makeChunk({ local_chunk_id: 'c2', status: 'saved' }),
    ]);
    mockStop.mockResolvedValue(undefined);

    await recorderStore.mockUpload('local-1');

    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
    expect(mockGetChunkBlob).toHaveBeenCalledWith('c2');
    expect(mockGetChunkBlob).not.toHaveBeenCalledWith('c1');
    expect(get(recorderStore).state).toBe('synced');
  });

  it('still creates the session from scratch when nothing was flushed before', async () => {
    mockGetSession.mockResolvedValue(makeSession()); // no knowledge_session_id / device_id
    mockGetChunksMeta.mockResolvedValue([]);
    mockStartNow.mockResolvedValue({ id: 'ks-new', room_id: 'room-new' });
    mockRegisterDevice.mockResolvedValue({ id: 'dev-new' });
    mockStop.mockResolvedValue(undefined);

    await recorderStore.mockUpload('local-1');

    expect(mockStartNow).toHaveBeenCalledTimes(1);
    expect(mockRegisterDevice).toHaveBeenCalledWith('ks-new', {});
    expect(get(recorderStore).state).toBe('synced');
  });
});

// ── 409 on device-stop: session already terminal (CLOSED) is a success ────
//
// Confirmed server-side in eigenvertex/.../knowledge_sessions.py:
// _ensure_session_access(write=True) 409s with "This knowledge session is
// terminal and cannot be changed" once status reaches CLOSED — a retry after
// a dropped response whose first attempt actually succeeded lands exactly
// here, and must read as success, not failure.

describe('mockUpload — device-stop returns 409 (session already terminal)', () => {
  it('treats 409 as success and still reaches "synced"', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([]);
    mockStop.mockRejectedValueOnce(new ApiError(409, 'This knowledge session is terminal and cannot be changed.', false));

    await recorderStore.mockUpload('local-1');

    expect(get(recorderStore).state).toBe('synced');
    expect(mockStop).toHaveBeenCalledTimes(1); // no pointless retry after a definitive 409
  });

  it('stops by DEVICE, not by the deprecated meeting-level call', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([]);
    mockStop.mockResolvedValue(undefined);

    await recorderStore.mockUpload('local-1');

    expect(mockStop).toHaveBeenCalledWith('ks-existing', 'dev-existing');
  });
});

// ── Timeout on /stop: retried, and failure after exhausting retries is real ─

describe('mockUpload — /stop times out', () => {
  it('retries a retriable failure (timeout) and succeeds once the server catches up', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([]);
    mockStop
      .mockRejectedValueOnce(new ApiError(0, 'Request timed out.', true))
      .mockResolvedValueOnce(undefined);

    await recorderStore.mockUpload('local-1');

    expect(mockStop).toHaveBeenCalledTimes(2);
    expect(get(recorderStore).state).toBe('synced');
  });

  it('gives up after 3 attempts and surfaces a real error — never a silent "synced"', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([]);
    mockStop.mockRejectedValue(new ApiError(0, 'Request timed out.', true));

    await recorderStore.mockUpload('local-1');

    expect(mockStop).toHaveBeenCalledTimes(3);
    const s = get(recorderStore);
    expect(s.state).toBe('error');
    expect(s.errorMessage).toContain('stop session');
  });

  it('does not retry a non-retriable failure (e.g. 400) — fails fast', async () => {
    mockGetSession.mockResolvedValue(makeSession({
      knowledge_session_id: 'ks-existing',
      device_id:             'dev-existing',
    }));
    mockGetChunksMeta.mockResolvedValue([]);
    mockStop.mockRejectedValue(new ApiError(400, 'Bad request', false));

    await recorderStore.mockUpload('local-1');

    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(get(recorderStore).state).toBe('error');
  });
});
