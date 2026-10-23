/**
 * Tests for savingStep — granular progress during the 'stopping' state.
 *
 * Gabriel's feedback after the Note 17:30 test: "Sauvegarde en cours…" felt
 * long with zero indication of what was actually happening. This doesn't
 * change the underlying timing (unmeasured — see recorderStore.ts's commit
 * history for the discipline of not touching timing without a measurement);
 * it makes the existing wait legible, which also means a genuinely slow step
 * is now visible AS a specific step, not just "it felt slow" next time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { LocalKnowledgeSession } from './types';

vi.mock('$lib/platform', () => ({ isNative: () => true }));

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

const mockUploadChunk = vi.fn().mockResolvedValue(undefined);
const mockStopDevice  = vi.fn().mockResolvedValue(undefined);
vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          vi.fn(),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    vi.fn(),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              vi.fn(),
  stopRecordingDevice:               (...a: unknown[]) => mockStopDevice(...a),
  uploadAudioChunk:                  (...a: unknown[]) => mockUploadChunk(...a),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('$lib/auth/auth', () => ({
  getUser: vi.fn(), isAuthenticated: vi.fn().mockReturnValue(true), authStore: { subscribe: vi.fn() },
}));

const mockNativeStop = vi.fn().mockResolvedValue(undefined);
vi.mock('./nativeAudioRecorder', () => {
  // A real class, not mockImplementation(() => ({...})): the latter makes
  // `new NativeAudioRecorder()` return that plain object (constructors that
  // explicitly return an object override `this`), so `recorder instanceof
  // NativeAudioRecorder` is false in stopRecording() and it silently falls
  // through to the web MediaRecorder path, which then hangs forever waiting
  // on an onstop callback nothing ever calls.
  class MockNativeAudioRecorder {
    onChunk?: unknown; onError?: unknown; onInterrupted?: unknown;
    onAutoResumed?: unknown; onInterruptionEnded?: unknown;
    start        = vi.fn().mockResolvedValue(undefined);
    pause        = vi.fn();
    resume       = vi.fn();
    stop         = (...a: unknown[]) => mockNativeStop(...a);
    getElapsedMs = vi.fn().mockReturnValue(1000);
  }
  return { NativeAudioRecorder: MockNativeAudioRecorder };
});
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
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
  mockUploadChunk.mockReset().mockResolvedValue(undefined);
  mockStopDevice.mockReset().mockResolvedValue(undefined);
  mockNativeStop.mockReset().mockResolvedValue(undefined);
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

describe('stopRecording() — savingStep progression', () => {
  it('passes through uploading then finalizing before landing on null', async () => {
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    (offlineStorage.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeReadySession());
    await store.loadSession('local-1');

    // 'local' so startRecording() takes the NativeAudioRecorder path, not the
    // PCM/WebSocket one (too heavy to mock realistically here) — then switch
    // back to 'stream' before stopping, which is what _finalizeStop actually
    // gates its backend call on. Exercises the narrow real case documented on
    // _stopSessionBackend: syncMode can legitimately differ between the start
    // and stop of a single recording.
    store.setSyncMode('local');
    await store.startRecording();
    store.setSyncMode('stream');

    const seen: Array<'uploading' | 'finalizing' | null> = [];
    const unsubscribe = store.subscribe((s) => {
      if (seen[seen.length - 1] !== s.savingStep) seen.push(s.savingStep);
    });

    await store.stopRecording();
    unsubscribe();

    const uploadingIdx  = seen.indexOf('uploading');
    const finalizingIdx = seen.indexOf('finalizing');
    expect(uploadingIdx).toBeGreaterThanOrEqual(0);
    expect(finalizingIdx).toBeGreaterThan(uploadingIdx);
    expect(seen[seen.length - 1]).toBeNull();
  });

  it('stays null throughout in local-only sync mode — no backend call, nothing to report', async () => {
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    (offlineStorage.getSession as ReturnType<typeof vi.fn>).mockResolvedValue(makeReadySession());
    await store.loadSession('local-1');

    store.setSyncMode('local');
    await store.startRecording();
    // syncMode stays 'local' through stop — _finalizeStop's backend block never runs.

    const seen: Array<'uploading' | 'finalizing' | null> = [];
    const unsubscribe = store.subscribe((s) => {
      if (seen[seen.length - 1] !== s.savingStep) seen.push(s.savingStep);
    });

    await store.stopRecording();
    unsubscribe();

    expect(seen.every((v) => v === null)).toBe(true);
    expect(mockStopDevice).not.toHaveBeenCalled();
  });
});
