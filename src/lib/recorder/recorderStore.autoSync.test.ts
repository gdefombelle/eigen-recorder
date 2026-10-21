/**
 * Tests for recorderStore.autoSyncPending() — automatic background sync of
 * pending local sessions once backend access is recovered (network back
 * online, app foreground resume, or sign-in just completed), with no user
 * action. Local-first recording must keep working fully with no account at
 * all; this is strictly additive for a signed-in user whose sessions queued
 * up while offline — never forces sync, never forces sign-in.
 *
 * Deliberately does NOT call recorderStore.init() or dispatch window
 * 'online'/'offline' events: init() registers global listeners with no
 * guard against being called twice, and those listeners themselves call
 * autoSyncPending() — doing both in the same test file would mean every
 * test leaks a listener into the next and risks an un-awaited background
 * sweep racing the test's own explicit call. Each test instead loads a
 * fresh module copy (same pattern as offlineStorage.test.ts) with
 * navigator.onLine stubbed before import, so the gate under test is set via
 * the store's actual INITIAL state rather than through init()'s wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import type { LocalKnowledgeSession, AudioChunkMetadata } from './types';

const mockGetAllSessions    = vi.fn();
const mockGetSessionStats   = vi.fn();
const mockGetSession        = vi.fn();
const mockGetChunksMeta     = vi.fn();
const mockGetChunkBlob      = vi.fn();
const mockSaveSession       = vi.fn().mockResolvedValue(undefined);
const mockUpdateChunkStatus = vi.fn().mockResolvedValue(undefined);
vi.mock('./offlineStorage', () => ({
  offlineStorage: {
    getAllSessions:       (...a: unknown[]) => mockGetAllSessions(...a),
    getSessionStats:      (...a: unknown[]) => mockGetSessionStats(...a),
    getSession:           (...a: unknown[]) => mockGetSession(...a),
    getChunksMeta:        (...a: unknown[]) => mockGetChunksMeta(...a),
    getChunkBlob:         (...a: unknown[]) => mockGetChunkBlob(...a),
    saveSession:          (...a: unknown[]) => mockSaveSession(...a),
    updateChunkStatus:    (...a: unknown[]) => mockUpdateChunkStatus(...a),
    getTotalStorageBytes: vi.fn().mockResolvedValue(0),
  },
}));

const mockStartNow       = vi.fn();
const mockRegisterDevice = vi.fn();
const mockUploadChunk    = vi.fn().mockResolvedValue(undefined);
const mockStopDevice     = vi.fn().mockResolvedValue(undefined);
vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          (...a: unknown[]) => mockStartNow(...a),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    (...a: unknown[]) => mockRegisterDevice(...a),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              vi.fn(),
  stopRecordingDevice:               (...a: unknown[]) => mockStopDevice(...a),
  uploadAudioChunk:                  (...a: unknown[]) => mockUploadChunk(...a),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

let _authed = true;
vi.mock('$lib/auth/auth', () => ({
  getUser:         vi.fn().mockReturnValue({ token: 't' }),
  isAuthenticated: () => _authed,
  authStore:       { subscribe: vi.fn() },
}));

const mockAudioRecorderInstance = () => ({
  onChunk: undefined, onError: undefined, onStop: undefined,
  start:          vi.fn().mockResolvedValue(undefined),
  pause:          vi.fn(), resume: vi.fn(), stop: vi.fn(),
  getElapsedMs:   vi.fn().mockReturnValue(0),
  state:          'recording',
});
vi.mock('./audioRecorder', () => ({
  AudioRecorder: vi.fn().mockImplementation(mockAudioRecorderInstance),
  getSupportedMimeType: vi.fn().mockReturnValue('audio/webm'),
}));
vi.mock('./nativeAudioRecorder', () => ({ NativeAudioRecorder: vi.fn() }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { init: vi.fn() } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn() }));
vi.mock('$lib/platform', () => ({ isNative: () => false }));

function makeSession(overrides: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  return {
    local_session_id:     overrides.local_session_id ?? 'local-1',
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
    ended_at:             '2026-01-01T00:05:00Z',
    duration_ms:          300_000,
    status:               'stopped_local',
    metadata:             { recorded_offline: true, device_name: 'iPhone' },
    ...overrides,
  };
}

function makeChunk(sessionId: string): AudioChunkMetadata {
  return {
    local_chunk_id: `chunk-${sessionId}`, local_session_id: sessionId,
    chunk_index: 0, start_ms: 0, end_ms: 5000, mime_type: 'audio/webm',
    size_bytes: 1000, saved_at: '2026-01-01T00:00:00Z', uploaded_at: null, status: 'saved',
  };
}

/** Fresh module copy with navigator.onLine stubbed BEFORE import, so the
 *  store's INITIAL isOnline reflects it — no init(), no window events. */
async function loadStore(online: boolean) {
  vi.resetModules();
  vi.stubGlobal('navigator', { onLine: online, platform: 'test', userAgent: 'vitest' });
  const mod = await import('./recorderStore');
  return mod.recorderStore;
}

beforeEach(() => {
  vi.clearAllMocks();
  _authed = true;
  mockGetChunkBlob.mockResolvedValue(new Blob(['x']));
  mockStartNow.mockResolvedValue({ id: 'ks-new', room_id: 'room-new' });
  mockRegisterDevice.mockResolvedValue({ id: 'dev-new' });
});

describe('autoSyncPending — gating', () => {
  it('does nothing for an anonymous user, even online with pending sessions', async () => {
    const store = await loadStore(true);
    _authed = false;
    mockGetAllSessions.mockResolvedValue([makeSession()]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 1, totalBytes: 1000 });

    await store.autoSyncPending();

    expect(mockGetAllSessions).not.toHaveBeenCalled();
    expect(mockStartNow).not.toHaveBeenCalled();
  });

  it('does nothing while offline, even when authenticated', async () => {
    const store = await loadStore(false);
    mockGetAllSessions.mockResolvedValue([makeSession()]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 1, totalBytes: 1000 });

    await store.autoSyncPending();

    expect(mockGetAllSessions).not.toHaveBeenCalled();
  });
});

describe('autoSyncPending — sweeping pending sessions', () => {
  it('syncs a syncable session and skips an already-synced one', async () => {
    const store = await loadStore(true);
    mockGetAllSessions.mockResolvedValue([
      makeSession({ local_session_id: 'pending-1', status: 'stopped_local' }),
      makeSession({ local_session_id: 'already-synced', status: 'synced' }),
    ]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 1, totalBytes: 1000 });
    mockGetSession.mockImplementation(async (id: string) =>
      makeSession({ local_session_id: id, status: id === 'pending-1' ? 'stopped_local' : 'synced' }));
    mockGetChunksMeta.mockImplementation(async (id: string) => [makeChunk(id)]);

    await store.autoSyncPending();

    // Only the syncable one reaches mockUpload's backend calls.
    expect(mockStartNow).toHaveBeenCalledTimes(1);
    expect(mockStopDevice).toHaveBeenCalledTimes(1);
  });

  it('skips a session with zero recorded chunks', async () => {
    const store = await loadStore(true);
    mockGetAllSessions.mockResolvedValue([makeSession({ local_session_id: 'empty-1' })]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 0, totalBytes: 0 });

    await store.autoSyncPending();

    expect(mockStartNow).not.toHaveBeenCalled();
  });

  it('never touches the session currently open for live recording', async () => {
    const store = await loadStore(true);

    // Land a session in 'ready' with no network dance (offline/unauthed at
    // creation time keeps this test focused on the exclusion logic, not
    // createSession()'s own online branch — that has its own tests).
    _authed = false;
    const liveId = await store.createSession({
      title: 'Live one', session_type: 'voice_note', subject: '', agenda: '',
      participants: [], location_label: null,
    } as never);
    store.setSyncMode('local');
    await store.startRecording();
    expect(get(store).state).toBe('recording_offline');

    _authed = true; // the sweep itself requires an account
    mockGetAllSessions.mockResolvedValue([
      makeSession({ local_session_id: liveId, status: 'recording_offline' }),
      makeSession({ local_session_id: 'other-pending', status: 'stopped_local' }),
    ]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 1, totalBytes: 1000 });
    mockGetSession.mockImplementation(async (id: string) =>
      makeSession({ local_session_id: id, status: id === liveId ? 'recording_offline' : 'stopped_local' }));
    mockGetChunksMeta.mockImplementation(async (id: string) => [makeChunk(id)]);

    await store.autoSyncPending();

    // Exactly one startNow call: the live session, matching currentSession
    // while its state is still 'recording_offline', must have been skipped.
    expect(mockStartNow).toHaveBeenCalledTimes(1);
  });
});

describe('autoSyncPending — does not overlap itself', () => {
  it('a second call while one is in flight is a no-op', async () => {
    const store = await loadStore(true);
    mockGetAllSessions.mockResolvedValue([makeSession({ local_session_id: 'slow-1' })]);
    mockGetSessionStats.mockResolvedValue({ chunkCount: 1, totalBytes: 1000 });
    mockGetSession.mockResolvedValue(makeSession({ local_session_id: 'slow-1' }));
    mockGetChunksMeta.mockResolvedValue([makeChunk('slow-1')]);

    let release: (() => void) | null = null;
    mockStartNow.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ id: 'ks-new', room_id: null });
    }));

    const first  = store.autoSyncPending();
    const second = store.autoSyncPending(); // must see _autoSyncing already true and return immediately

    await vi.waitFor(() => { if (!release) throw new Error('startNow not called yet'); });
    release!();
    await Promise.all([first, second]);

    expect(mockGetAllSessions).toHaveBeenCalledTimes(1);
  });
});
