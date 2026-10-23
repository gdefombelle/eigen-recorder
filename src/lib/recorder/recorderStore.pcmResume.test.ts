/**
 * Tests for PCM stream-mode pause/resume.
 *
 * Gabriel's on-device report: with an account signed in (syncMode defaults
 * to 'stream'), Pause then Resume loses the transcript for everything after
 * the Resume. Root cause: PcmCapture.resume() called `ctx.resume()` without
 * awaiting it and swallowed any failure with `.catch(() => {})` — if iOS
 * declined to actually resume the AudioContext (an interruption the WebAudio
 * path has no observer for, or the resume landing outside the tap's
 * user-gesture window), the worklet kept producing zero frames while the UI
 * showed a live, running recording. No new frames reach the WebSocket, so
 * the backend has nothing to transcribe from that point on.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { LocalKnowledgeSession } from './types';

vi.mock('$lib/platform', () => ({ isNative: () => false }));

vi.mock('./offlineStorage', () => ({
  offlineStorage: {
    getSession:           vi.fn(),
    saveSession:          vi.fn().mockResolvedValue(undefined),
    getChunksMeta:        vi.fn().mockResolvedValue([]),
    getChunkBlob:         vi.fn(),
    updateChunkStatus:    vi.fn(),
    getAllSessions:       vi.fn().mockResolvedValue([]),
    getSessionStats:      vi.fn().mockResolvedValue({ chunkCount: 0, totalBytes: 0 }),
    getTotalStorageBytes: vi.fn().mockResolvedValue(0),
  },
}));

vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          vi.fn(),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    vi.fn(),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              vi.fn(),
  stopRecordingDevice:               vi.fn().mockResolvedValue(undefined),
  uploadAudioChunk:                  vi.fn().mockResolvedValue(undefined),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('$lib/auth/auth', () => ({
  getUser: vi.fn(), isAuthenticated: vi.fn().mockReturnValue(true), authStore: { subscribe: vi.fn() },
}));

const mockResume = vi.fn().mockResolvedValue(undefined);
vi.mock('./pcmCapture', () => {
  class MockPcmCapture {
    onFrame?: unknown; onLevel?: unknown; onError?: unknown;
    amplifiedStream = null;
    start        = vi.fn().mockResolvedValue(undefined);
    pause        = vi.fn().mockResolvedValue(undefined);
    resume       = (...a: unknown[]) => mockResume(...a);
    stop         = vi.fn();
    getElapsedMs = vi.fn().mockReturnValue(1000);
  }
  return { PcmCapture: MockPcmCapture };
});

vi.mock('./liveStreamClient', () => {
  class MockLiveStreamClient {
    onStateChange?: unknown; onFatal?: unknown; onStats?: unknown;
    droppedFrames = 0;
    connect        = vi.fn().mockResolvedValue(undefined);
    sendFrame      = vi.fn();
    commitAndClose = vi.fn().mockResolvedValue(undefined);
    close          = vi.fn();
  }
  return { LiveStreamClient: MockLiveStreamClient };
});

vi.mock('./nativeAudioRecorder', () => ({ NativeAudioRecorder: vi.fn() }));
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { init: vi.fn() } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn().mockReturnValue('native') }));

async function loadStore() {
  vi.resetModules();
  vi.stubGlobal('navigator', { onLine: true, platform: 'test', userAgent: 'vitest' });
  const mod = await import('./recorderStore');
  return mod.recorderStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResume.mockReset().mockResolvedValue(undefined);
});

function makeReadySession(): LocalKnowledgeSession {
  return {
    local_session_id: 'local-1', remote_session_id: null,
    knowledge_session_id: 'ks-1', room_id: 'room-1', device_id: 'dev-1',
    title: 'Note', session_type: 'voice_note', mode: 'online',
    subject: '', agenda: '', participants: [], location_label: null,
    created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null,
    duration_ms: 0, status: 'ready',
    metadata: { recorded_offline: false, device_name: 'iPhone' },
  };
}

async function readyAndStreaming(store: Awaited<ReturnType<typeof loadStore>>) {
  const { offlineStorage } = await import('./offlineStorage');
  (offlineStorage.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeReadySession());
  await store.loadSession('local-1');
  store.setSyncMode('stream');
  await store.startRecording();
}

describe('pauseRecording()/resumeRecording() — PCM stream mode', () => {
  it('resumes cleanly and returns to recording_offline when the AudioContext actually resumes', async () => {
    const store = await loadStore();
    await readyAndStreaming(store);
    expect(get(store).state).toBe('recording_offline');

    await store.pauseRecording();
    expect(get(store).state).toBe('paused');

    await store.resumeRecording();
    expect(mockResume).toHaveBeenCalledTimes(1);
    expect(get(store).state).toBe('recording_offline');
    expect(get(store).errorMessage).toBeNull();
  });

  it('surfaces an error and stays paused when the AudioContext declines to resume', async () => {
    const store = await loadStore();
    await readyAndStreaming(store);

    await store.pauseRecording();
    mockResume.mockRejectedValueOnce(new Error('Audio context did not resume — recording is not capturing.'));

    await store.resumeRecording();

    // Must NOT silently claim an active recording over a dead stream.
    expect(get(store).state).not.toBe('recording_offline');
    expect(get(store).errorMessage).toContain('resume');
  });
});
