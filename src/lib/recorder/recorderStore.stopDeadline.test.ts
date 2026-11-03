/**
 * The end of a record must never wait on the server forever.
 *
 * Reported: a 01:37 record sat on "Finalisation…" and the note stayed "Local" in Sessions. That label is the wait
 * for POST /devices/{id}/stop; there was no overall bound, and the reason for a failed stop was kept nowhere.
 *
 * Contract under test:
 *  • after BACKEND_STOP_DEADLINE_MS (45 s) the end screen is shown — status 'stopped_local', warning flag set;
 *  • the reason (timeout / HTTP error / offline) is stored in the session metadata;
 *  • the stop is retried automatically; a request that lands late is honoured (→ 'synced');
 *  • the sweep must not create a second backend session for such a record (isSessionSyncable skips it on purpose).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import type { LocalKnowledgeSession } from './types';

const sessions = new Map<string, LocalKnowledgeSession>();
vi.mock('./offlineStorage', () => ({
  offlineStorage: {
    getSession:           vi.fn(async (id: string) => sessions.get(id)),
    saveSession:          vi.fn(async (s: LocalKnowledgeSession) => { sessions.set(s.local_session_id, structuredClone(s)); }),
    getChunksMeta:        vi.fn().mockResolvedValue([]),
    getChunkBlob:         vi.fn(),
    updateChunkStatus:    vi.fn(),
    getAllSessions:       vi.fn(async () => [...sessions.values()]),
    getSessionStats:      vi.fn().mockResolvedValue({ chunkCount: 1, totalBytes: 10 }),
    getTotalStorageBytes: vi.fn().mockResolvedValue(0),
  },
}));

const mockStopDevice = vi.fn();
const mockStartNow   = vi.fn();
vi.mock('./knowledgeSessionApi', () => ({
  startNowKnowledgeSession:          (...a: unknown[]) => mockStartNow(...a),
  syncKnowledgeSessionFromRecorder:  vi.fn(),
  registerKnowledgeSessionDevice:    vi.fn(),
  startKnowledgeSession:             vi.fn(),
  resumeKnowledgeSession:            vi.fn(),
  stopKnowledgeSession:              vi.fn(),
  stopRecordingDevice:               (...a: unknown[]) => mockStopDevice(...a),
  uploadAudioChunk:                  vi.fn(),
  buildDevicePayload:                vi.fn().mockReturnValue({}),
  toParticipantPayload:              vi.fn().mockReturnValue(undefined),
  audioRecovery:                     vi.fn(),
}));

vi.mock('$lib/auth/auth', () => ({
  getUser: vi.fn(), isAuthenticated: vi.fn().mockReturnValue(true), authStore: { subscribe: vi.fn() },
}));

vi.mock('./nativeAudioRecorder', () => {
  class MockNativeAudioRecorder {
    onChunk?: unknown; onError?: unknown; onInterrupted?: unknown;
    onAutoResumed?: unknown; onInterruptionEnded?: unknown;
    start        = vi.fn().mockResolvedValue(undefined);
    pause        = vi.fn();
    resume       = vi.fn();
    stop         = vi.fn().mockResolvedValue(undefined);
    getElapsedMs = vi.fn().mockReturnValue(97_000);
    getMicLevel  = vi.fn().mockReturnValue(0);
  }
  return { NativeAudioRecorder: MockNativeAudioRecorder };
});
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { init: vi.fn() } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn().mockReturnValue('native') }));

// vi.resetModules() in loadStore() gives the store its own copy of ApiError: errors must come from THAT copy
// or its `instanceof ApiError` checks (retriable? status?) see a stranger.
async function apiError(status: number, message: string, retriable: boolean) {
  const { ApiError } = await import('$lib/auth/api');
  return new ApiError(status, message, retriable);
}

type Store = Awaited<ReturnType<typeof loadStore>>;
async function loadStore(online = true) {
  vi.resetModules();
  vi.stubGlobal('navigator', { onLine: online, platform: 'test', userAgent: 'vitest' });
  const mod = await import('./recorderStore');
  return { store: mod.recorderStore, mod };
}

function makeSession(over: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  return {
    local_session_id: 'local-1', remote_session_id: null,
    knowledge_session_id: 'ks-1', room_id: 'room-1', device_id: 'dev-1',
    title: 'Note', session_type: 'voice_note', mode: 'online',
    subject: '', agenda: '', participants: [], location_label: null,
    created_at: '2026-01-01T00:00:00Z', started_at: null, ended_at: null,
    duration_ms: 0, status: 'ready',
    metadata: { recorded_offline: false, device_name: 'iPhone' },
    ...over,
  };
}

/** Record, then stop in 'stream' sync mode (as in savingStep.test.ts: 'local' to take the native path at start). */
async function recordUntilStop(s: Store) {
  sessions.set('local-1', makeSession());
  await s.store.loadSession('local-1');
  s.store.setSyncMode('local');
  await s.store.startRecording();
  s.store.setSyncMode('stream');
}

beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
  mockStopDevice.mockReset();
  mockStartNow.mockReset();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

const stored = () => sessions.get('local-1')!;

describe('server stop that never answers', () => {
  it('keeps "finalizing" for 45 s, then shows the end screen with the warning flag and the reason stored', async () => {
    mockStopDevice.mockImplementation(() => new Promise(() => {}));            // the server never answers
    const s = await loadStore();
    await recordUntilStop(s);

    let done = false;
    const stopping = s.store.stopRecording().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(44_900);
    expect(done).toBe(false);
    expect(get(s.store)).toMatchObject({ state: 'stopping', savingStep: 'finalizing' });

    await vi.advanceTimersByTimeAsync(200);
    await stopping;

    expect(get(s.store)).toMatchObject({ state: 'stopped_local', savingStep: null });
    expect(stored()).toMatchObject({ status: 'stopped_local' });
    expect(stored().ended_at).toBeTruthy();
    expect(stored().metadata).toMatchObject({
      backend_stopped: false,
      backend_stop_pending: true,
      backend_stop_issue: { kind: 'timeout', status: null, attempts: 1, message: expect.stringContaining('45 s') },
    });
  });

  it('a stop that lands AFTER the deadline is honoured: the note becomes synced and the warning goes away', async () => {
    let resolveStop!: () => void;
    mockStopDevice.mockImplementation(() => new Promise<void>((r) => { resolveStop = r; }));
    const s = await loadStore();
    await recordUntilStop(s);
    const stopping = s.store.stopRecording();
    await vi.advanceTimersByTimeAsync(45_100);
    await stopping;
    expect(stored().status).toBe('stopped_local');

    resolveStop();
    await vi.advanceTimersByTimeAsync(0);

    expect(stored()).toMatchObject({ status: 'synced' });
    expect(stored().metadata).toMatchObject({ backend_stopped: true, backend_stop_pending: false });
    expect(stored().metadata.backend_stop_issue).toBeUndefined();
    expect(get(s.store).state).toBe('synced');
  });
});

describe('server stop that fails fast', () => {
  it('stores the HTTP status and message, ends on the end screen, and retries automatically', async () => {
    const s = await loadStore();
    mockStopDevice.mockRejectedValue(await apiError(500, 'boom', true));
    await recordUntilStop(s);

    await s.store.stopRecording();

    expect(mockStopDevice).toHaveBeenCalledTimes(3);                            // existing 3-attempt policy, unchanged
    expect(get(s.store)).toMatchObject({ state: 'stopped_local', savingStep: null, errorMessage: 'Backend stop failed: boom' });
    expect(stored().metadata).toMatchObject({
      backend_stop_pending: true,
      backend_stop_issue: { kind: 'error', status: 500, message: 'boom', attempts: 1 },
    });

    // The server recovers: the scheduled retry (20 s) confirms the stop.
    mockStopDevice.mockReset().mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(mockStopDevice).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ status: 'synced' });
    expect(stored().metadata.backend_stop_pending).toBe(false);
  });

  it('keeps counting attempts in the stored reason while it keeps failing', async () => {
    const s = await loadStore();
    mockStopDevice.mockRejectedValue(await apiError(503, 'still down', true));
    await recordUntilStop(s);
    await s.store.stopRecording();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(stored().metadata.backend_stop_issue).toMatchObject({ kind: 'error', status: 503, attempts: 2 });
    expect(stored().status).toBe('stopped_local');
  });
});

describe('offline at the end of the record', () => {
  it('no request is made; the reason says offline and a retry is pending', async () => {
    const s = await loadStore(false);
    await recordUntilStop(s);

    await s.store.stopRecording();

    expect(mockStopDevice).not.toHaveBeenCalled();
    expect(stored().metadata).toMatchObject({ backend_stop_pending: true, backend_stop_issue: { kind: 'offline' } });
  });
});

describe('server stop that succeeds', () => {
  it('is unchanged: synced, no warning flag, no stored reason, no retry scheduled', async () => {
    mockStopDevice.mockResolvedValue(undefined);
    const s = await loadStore();
    await recordUntilStop(s);

    await s.store.stopRecording();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(stored()).toMatchObject({ status: 'synced' });
    expect(stored().metadata).toMatchObject({ backend_stopped: true, backend_stop_pending: false });
    expect(stored().metadata.backend_stop_issue).toBeUndefined();
    expect(mockStopDevice).toHaveBeenCalledTimes(1);
  });
});

describe('retry of an unconfirmed stop from the sweep (reconnection / foreground / launch)', () => {
  const pending = () => makeSession({
    status: 'stopped_local', ended_at: '2026-01-01T00:05:00Z',
    metadata: { recorded_offline: false, device_name: 'iPhone', backend_stopped: false, backend_stop_pending: true,
                backend_stop_issue: { kind: 'timeout', message: 'x', status: null, at: '2026-01-01T00:05:00Z', attempts: 1 } },
  });

  it('confirms the stop WITHOUT creating a second backend session (the old sweep skips this record on purpose)', async () => {
    mockStopDevice.mockResolvedValue(undefined);
    sessions.set('local-1', pending());
    const s = await loadStore();

    await s.store.autoSyncPending();

    expect(mockStopDevice).toHaveBeenCalledWith('ks-1', 'dev-1');
    expect(mockStartNow).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ status: 'synced' });
    expect(stored().metadata.backend_stop_pending).toBe(false);
  });

  it('a failed retry keeps the record pending and bumps the attempt count', async () => {
    sessions.set('local-1', pending());
    const s = await loadStore();
    mockStopDevice.mockRejectedValue(await apiError(500, 'nope', false));

    await s.store.autoSyncPending();

    expect(stored().status).toBe('stopped_local');
    expect(stored().metadata.backend_stop_issue).toMatchObject({ kind: 'error', status: 500, attempts: 2 });
  });

  it('does not touch a session whose stop was never marked pending', async () => {
    sessions.set('local-1', makeSession({ status: 'stopped_local', metadata: { recorded_offline: false, device_name: 'iPhone' } }));
    const s = await loadStore();

    await s.store.autoSyncPending();

    expect(mockStopDevice).not.toHaveBeenCalled();
  });
});
