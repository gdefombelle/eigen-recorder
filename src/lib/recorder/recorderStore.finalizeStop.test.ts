/**
 * Tests for _stopSessionBackend() — the device-stop-vs-deprecated-fallback
 * decision used by _finalizeStop() (the live online stop-at-recording-end
 * path), exported test-only because _finalizeStop() itself sits behind
 * enough native/PCM/MediaRecorder machinery that exercising it end-to-end
 * would mock far more than this decision warrants.
 *
 * Verified (not guessed — see recorderStore.ts's doc comment on
 * _stopSessionBackend): device_id is guaranteed present whenever a session
 * is created online+authed, EXCEPT one narrow, real case — a planned
 * session selected while online, then Start tapped the instant the user
 * goes offline or signs out. That's exactly what the fallback below covers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '$lib/auth/api';
import type { LocalKnowledgeSession } from './types';

const mockStopDevice = vi.fn();
const mockStopLegacy = vi.fn();
vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          vi.fn(),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    vi.fn(),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              (...a: unknown[]) => mockStopLegacy(...a),
  stopRecordingDevice:               (...a: unknown[]) => mockStopDevice(...a),
  uploadAudioChunk:                  vi.fn(),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('./offlineStorage', () => ({ offlineStorage: {
  getSession: vi.fn(), saveSession: vi.fn().mockResolvedValue(undefined),
  getChunksMeta: vi.fn(), getChunkBlob: vi.fn(), updateChunkStatus: vi.fn(),
  getAllSessions: vi.fn().mockResolvedValue([]), getTotalStorageBytes: vi.fn().mockResolvedValue(0),
} }));
vi.mock('$lib/auth/auth', () => ({
  getUser: vi.fn(), isAuthenticated: vi.fn().mockReturnValue(true), authStore: { subscribe: vi.fn() },
}));
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./nativeAudioRecorder', () => ({ NativeAudioRecorder: vi.fn() }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: {} }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn() }));
vi.mock('$lib/platform', () => ({ isNative: () => false }));

import { _stopSessionBackend } from './recorderStore';

function makeSession(overrides: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  return {
    local_session_id: 'local-1', remote_session_id: null,
    knowledge_session_id: 'ks-1', room_id: 'room-1', device_id: 'dev-1',
    title: 'Note', session_type: 'voice_note', mode: 'online',
    subject: '', agenda: '', participants: [], location_label: null,
    created_at: '2026-01-01T00:00:00Z', started_at: '2026-01-01T00:00:00Z', ended_at: null,
    duration_ms: 0, status: 'recording_offline',
    metadata: { recorded_offline: false, device_name: 'iPhone' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('_stopSessionBackend — device_id present', () => {
  it('calls the device endpoint, not the deprecated one', async () => {
    await _stopSessionBackend(makeSession({ device_id: 'dev-1' }), 'ks-1', 'stream');

    expect(mockStopDevice).toHaveBeenCalledWith('ks-1', 'dev-1');
    expect(mockStopLegacy).not.toHaveBeenCalled();
  });
});

describe('_stopSessionBackend — device_id absent (the verified edge case)', () => {
  it('falls back to the deprecated endpoint with an explicit warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await _stopSessionBackend(makeSession({ device_id: null }), 'ks-1', 'stream');

    expect(mockStopLegacy).toHaveBeenCalledWith('ks-1');
    expect(mockStopDevice).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no device_id'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('local-1'));
  });
});

describe('_stopSessionBackend — 409 (session already terminal)', () => {
  it('treats 409 as success, no retry', async () => {
    mockStopDevice.mockRejectedValueOnce(new ApiError(409, 'This knowledge session is terminal and cannot be changed.', false));

    await expect(_stopSessionBackend(makeSession(), 'ks-1', 'stream')).resolves.toBeUndefined();

    expect(mockStopDevice).toHaveBeenCalledTimes(1);
  });
});

describe('_stopSessionBackend — timeout then success', () => {
  it('retries a retriable failure and succeeds on the second attempt', async () => {
    mockStopDevice
      .mockRejectedValueOnce(new ApiError(0, 'Request timed out.', true))
      .mockResolvedValueOnce(undefined);

    await expect(_stopSessionBackend(makeSession(), 'ks-1', 'stream')).resolves.toBeUndefined();

    expect(mockStopDevice).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts and throws', async () => {
    mockStopDevice.mockRejectedValue(new ApiError(0, 'Request timed out.', true));

    await expect(_stopSessionBackend(makeSession(), 'ks-1', 'stream')).rejects.toThrow('Request timed out.');
    expect(mockStopDevice).toHaveBeenCalledTimes(3);
  });
});
