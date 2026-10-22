/**
 * Tests for Voice Processing I/O's default and the switch that overrides it.
 *
 * Default ON for solo Dictaphone Mode (session_type 'voice_note') on iOS
 * only; off otherwise, including on web where AVAudioSession doesn't exist.
 * Built for one dominant voice — its AGC working against a second speaker is
 * exactly why this must stay off by default for Interview-shaped sessions.
 *
 * Deliberately loads a fresh module per test (same pattern as
 * offlineStorage.test.ts / recorderStore.autoSync.test.ts): isNative() is
 * read once by createSession()/loadSession() through a module-level import,
 * and a fresh module per test is the simplest way to flip it reliably
 * without leaking state across tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { LocalKnowledgeSession } from './types';

let _native = false;
vi.mock('$lib/platform', () => ({ isNative: () => _native }));

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
  stopRecordingDevice:               vi.fn(),
  uploadAudioChunk:                  vi.fn(),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('$lib/auth/auth', () => ({
  getUser:         vi.fn(),
  isAuthenticated: vi.fn().mockReturnValue(true),
  authStore:       { subscribe: vi.fn() },
}));

const mockNativeStart = vi.fn().mockResolvedValue(undefined);
vi.mock('./nativeAudioRecorder', () => ({
  NativeAudioRecorder: vi.fn().mockImplementation(() => ({
    onChunk: undefined, onError: undefined, onInterrupted: undefined,
    onAutoResumed: undefined, onInterruptionEnded: undefined,
    start:        (...a: unknown[]) => mockNativeStart(...a),
    pause:        vi.fn(), resume: vi.fn(), stop: vi.fn(),
    getElapsedMs: vi.fn().mockReturnValue(0),
  })),
}));
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { init: vi.fn() } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn().mockReturnValue('native') }));

function makeSession(overrides: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  return {
    local_session_id: 'local-1', remote_session_id: null,
    knowledge_session_id: null, room_id: null, device_id: null,
    title: 'Note', session_type: 'voice_note', mode: 'offline',
    subject: '', agenda: '', participants: [], location_label: null,
    created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null,
    duration_ms: 0, status: 'ready',
    metadata: { recorded_offline: true, device_name: 'iPhone' },
    ...overrides,
  };
}

async function loadStore() {
  vi.resetModules();
  const mod = await import('./recorderStore');
  return mod.recorderStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  _native = false;
  mockNativeStart.mockReset().mockResolvedValue(undefined);
});

describe('createSession() — Voice Processing default', () => {
  it('defaults ON for session_type voice_note on iOS', async () => {
    _native = true;
    const store = await loadStore();

    await store.createSession({
      title: 'Note', session_type: 'voice_note', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);

    expect(get(store).voiceProcessingEnabled).toBe(true);
  });

  it('defaults OFF for a non-voice_note session_type (e.g. interview) on iOS', async () => {
    _native = true;
    const store = await loadStore();

    await store.createSession({
      title: 'Interview', session_type: 'interview', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);

    expect(get(store).voiceProcessingEnabled).toBe(false);
  });

  it('defaults OFF for voice_note on web — AVAudioSession does not exist there', async () => {
    _native = false;
    const store = await loadStore();

    await store.createSession({
      title: 'Note', session_type: 'voice_note', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);

    expect(get(store).voiceProcessingEnabled).toBe(false);
  });
});

describe('setVoiceProcessing() — user override', () => {
  it('overrides the computed default in either direction', async () => {
    _native = true;
    const store = await loadStore();
    await store.createSession({
      title: 'Note', session_type: 'voice_note', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);
    expect(get(store).voiceProcessingEnabled).toBe(true);

    store.setVoiceProcessing(false);
    expect(get(store).voiceProcessingEnabled).toBe(false);

    store.setVoiceProcessing(true);
    expect(get(store).voiceProcessingEnabled).toBe(true);
  });
});

describe('loadSession() — Voice Processing default from the stored session', () => {
  it('recomputes the default from the loaded session\'s session_type', async () => {
    _native = true;
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    (offlineStorage.getSession as ReturnType<typeof vi.fn>)
      .mockResolvedValue(makeSession({ session_type: 'voice_note', status: 'ready' }));

    await store.loadSession('local-1');

    expect(get(store).voiceProcessingEnabled).toBe(true);
  });
});

describe('startRecording() — passes the flag through to the native recorder', () => {
  it('forwards voiceProcessingEnabled as start()\'s third argument', async () => {
    _native = true;
    const store = await loadStore();
    await store.createSession({
      title: 'Note', session_type: 'voice_note', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);
    store.setSyncMode('local');
    expect(get(store).voiceProcessingEnabled).toBe(true);

    const localId = get(store).currentSession?.local_session_id;
    await store.startRecording();

    expect(mockNativeStart).toHaveBeenCalledWith(localId, expect.any(Number), true);
  });
});
