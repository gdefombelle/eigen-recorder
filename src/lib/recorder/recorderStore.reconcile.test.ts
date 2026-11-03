/**
 * Reconciliation with the server.
 *
 * Reported: Note 17:43 was ENDED server-side (summary generated, 2 attachments received) but the app kept
 * showing "LOCAL" because the stop response never reached it. Opening Sessions (or launching / foregrounding the
 * app) now asks the server and marks such a record "Envoyée" — without sending any audio.
 *
 * Scope decided with the product owner: ONLY 'stopped_local' records that have a backend id. 'recording_offline'
 * (an interrupted recording) is never touched: its local audio can be longer than what the server received.
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
    // newest first, like the real implementation
    getAllSessions:       vi.fn(async () => [...sessions.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))),
    getSessionStats:      vi.fn().mockResolvedValue({ chunkCount: 1, totalBytes: 10 }),
    getTotalStorageBytes: vi.fn().mockResolvedValue(0),
  },
}));

const mockServerState = vi.fn();
const mockStopDevice = vi.fn();
const mockStartNow = vi.fn();
const mockUploadChunk = vi.fn();
vi.mock('./knowledgeSessionApi', () => ({
  getKnowledgeSessionServerState:    (...a: unknown[]) => mockServerState(...a),
  startNowKnowledgeSession:          (...a: unknown[]) => mockStartNow(...a),
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

let authed = true;
vi.mock('$lib/auth/auth', () => ({
  getUser: vi.fn(), isAuthenticated: () => authed, authStore: { subscribe: vi.fn() },
}));
vi.mock('./nativeAudioRecorder', () => ({ NativeAudioRecorder: vi.fn() }));
vi.mock('./audioRecorder', () => ({ AudioRecorder: vi.fn(), getSupportedMimeType: vi.fn().mockReturnValue('audio/webm') }));
vi.mock('./pcmCapture', () => ({ PcmCapture: vi.fn() }));
vi.mock('./liveStreamClient', () => ({ LiveStreamClient: vi.fn() }));
vi.mock('./chunkQueue', () => ({ chunkQueue: { init: vi.fn() } }));
vi.mock('./mockRecorderApi', () => ({ mockRecorderApi: {} }));
vi.mock('./audioEngine', () => ({ getAudioEngine: vi.fn() }));
vi.mock('$lib/platform', () => ({ isNative: () => false }));

async function loadStore(online = true) {
  vi.resetModules();
  vi.stubGlobal('navigator', { onLine: online, platform: 'test', userAgent: 'vitest' });
  return (await import('./recorderStore')).recorderStore;
}

let n = 0;
function makeSession(over: Partial<LocalKnowledgeSession> = {}): LocalKnowledgeSession {
  const id = over.local_session_id ?? `local-${++n}`;
  return {
    local_session_id: id, remote_session_id: null,
    knowledge_session_id: `ks-${id}`, room_id: 'room-1', device_id: 'dev-1',
    title: 'Note 17:43', session_type: 'voice_note', mode: 'online',
    subject: '', agenda: '', participants: [], location_label: null,
    created_at: `2026-11-03T17:${String(10 + n).padStart(2, '0')}:00Z`, started_at: '2026-11-03T17:43:00Z', ended_at: null,
    duration_ms: 97_000, status: 'stopped_local',
    metadata: { recorded_offline: false, device_name: 'iPhone', backend_stopped: false },
    ...over,
  };
}
const put = (s: LocalKnowledgeSession) => { sessions.set(s.local_session_id, s); return s; };
const get1 = (id: string) => sessions.get(id)!;

beforeEach(() => {
  sessions.clear(); n = 0; authed = true;
  vi.clearAllMocks();
  mockServerState.mockReset(); mockStopDevice.mockReset(); mockStartNow.mockReset(); mockUploadChunk.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-03T18:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

const noAudioSent = () => {
  expect(mockUploadChunk).not.toHaveBeenCalled();
  expect(mockStartNow).not.toHaveBeenCalled();
  expect(mockStopDevice).not.toHaveBeenCalled();
};

describe('a record the server has ended', () => {
  it('Note 17:43: stopped_local + server completed → synced, and NO audio / session / stop request is made', async () => {
    const note = put(makeSession({ local_session_id: 'n1743', metadata: {
      recorded_offline: false, device_name: 'iPhone', backend_stopped: false, backend_stop_pending: true,
      backend_stop_issue: { kind: 'timeout', message: 'x', status: null, at: '', attempts: 1 },
    } }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });
    const store = await loadStore();

    const changed = await store.reconcileWithServer();

    expect(changed).toBe(1);
    expect(mockServerState).toHaveBeenCalledWith(note.knowledge_session_id);
    expect(get1('n1743')).toMatchObject({ status: 'synced', ended_at: '2026-11-03T17:45:00Z' });
    expect(get1('n1743').metadata).toMatchObject({
      backend_stopped: true, backend_stop_pending: false,
      reconciled: { server_status: 'completed', server_ended_at: '2026-11-03T17:45:00Z' },
    });
    expect(get1('n1743').metadata.backend_stop_issue).toBeUndefined();
    noAudioSent();
  });

  it('keeps a local ended_at and the local audio metadata as they were', async () => {
    put(makeSession({ local_session_id: 'a', ended_at: '2026-11-03T17:44:00Z', duration_ms: 97_000 }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });
    await (await loadStore()).reconcileWithServer();
    expect(get1('a')).toMatchObject({ status: 'synced', ended_at: '2026-11-03T17:44:00Z', duration_ms: 97_000 });
  });

  it('processing_live WITH ended_at counts as ended (decision C)', async () => {
    put(makeSession({ local_session_id: 'a' }));
    mockServerState.mockResolvedValue({ status: 'processing_live', ended_at: '2026-11-03T17:45:00Z' });
    expect(await (await loadStore()).reconcileWithServer()).toBe(1);
    expect(get1('a').status).toBe('synced');
  });

  it('the record open on screen flips to "synced" immediately', async () => {
    const s = put(makeSession({ local_session_id: 'open' }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    await store.loadSession(s.local_session_id);
    expect(offlineStorage.getSession).toHaveBeenCalled();
    expect(get(store).state).toBe('stopped_local');

    await store.reconcileWithServer();

    expect(get(store)).toMatchObject({ state: 'synced' });
    expect(get(store).currentSession?.status).toBe('synced');
  });
});

describe('what must NOT be reconciled', () => {
  it('recording_offline + server completed → NO change, and the server is not even asked (decision A)', async () => {
    put(makeSession({ local_session_id: 'crashed', status: 'recording_offline' }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });

    const changed = await (await loadStore()).reconcileWithServer();

    expect(changed).toBe(0);
    expect(get1('crashed').status).toBe('recording_offline');
    expect(mockServerState).not.toHaveBeenCalled();
    noAudioSent();
  });

  it.each([
    ['recording', null], ['paused', null], ['draft', null], ['ready', null],
    ['processing_live', null], ['processing_offline', null],               // processing without ended_at: still live / not ended
    ['cancelled', '2026-11-03T17:45:00Z'],                                 // never "sent"
  ])('server %s (ended_at %s) → unchanged', async (status, ended_at) => {
    put(makeSession({ local_session_id: 'a' }));
    mockServerState.mockResolvedValue({ status, ended_at });
    expect(await (await loadStore()).reconcileWithServer()).toBe(0);
    expect(get1('a').status).toBe('stopped_local');
  });

  it('a stopped_local record with no backend id is not asked about', async () => {
    put(makeSession({ local_session_id: 'a', knowledge_session_id: null }));
    await (await loadStore()).reconcileWithServer();
    expect(mockServerState).not.toHaveBeenCalled();
  });

  it('an already synced record is not asked about', async () => {
    put(makeSession({ local_session_id: 'a', status: 'synced' }));
    await (await loadStore()).reconcileWithServer();
    expect(mockServerState).not.toHaveBeenCalled();
  });

  it.each([[404], [401], [500], [0]])('server error %i → record unchanged, nothing thrown', async (status) => {
    put(makeSession({ local_session_id: 'a' }));
    const store = await loadStore();
    const { ApiError } = await import('$lib/auth/api');
    mockServerState.mockRejectedValue(new ApiError(status, 'nope', status === 0 || status >= 500));
    await expect(store.reconcileWithServer()).resolves.toBe(0);
    expect(get1('a').status).toBe('stopped_local');
  });

  it('signed out or offline → no request at all', async () => {
    put(makeSession({ local_session_id: 'a' }));
    authed = false;
    await (await loadStore()).reconcileWithServer();
    authed = true;
    await (await loadStore(false)).reconcileWithServer();
    expect(mockServerState).not.toHaveBeenCalled();
  });

  it('a record whose stop request is still in flight (after the 45 s deadline) is left to that request', async () => {
    mockStopDevice.mockImplementation(() => new Promise(() => {}));        // never answers
    const store = await loadStore();
    // The in-flight stop is produced by the retry worker: its request never answers, so it outlives the 45 s deadline.
    put(makeSession({ local_session_id: 'p', metadata: { recorded_offline: false, device_name: 'iPhone', backend_stop_pending: true,
      backend_stop_issue: { kind: 'timeout', message: 'x', status: null, at: '', attempts: 1 } } }));
    mockServerState.mockResolvedValue({ status: 'recording', ended_at: null });
    const sweep = store.autoSyncPending();                                  // retry worker starts a stop that never answers
    await vi.advanceTimersByTimeAsync(45_100);
    await sweep;
    mockServerState.mockClear();
    vi.setSystemTime(new Date('2026-11-03T18:05:00Z'));                    // past the 60 s throttle

    await store.reconcileWithServer();

    expect(mockServerState).not.toHaveBeenCalledWith('ks-p');
  });
});

describe('limits', () => {
  it('asks about at most 20 records per run, newest first', async () => {
    for (let i = 0; i < 25; i++) put(makeSession({ local_session_id: `s${String(i).padStart(2, '0')}`, created_at: `2026-11-03T17:${String(i).padStart(2, '0')}:00Z` }));
    mockServerState.mockResolvedValue({ status: 'recording', ended_at: null });

    await (await loadStore()).reconcileWithServer();

    expect(mockServerState).toHaveBeenCalledTimes(20);
    const asked = mockServerState.mock.calls.map((c) => c[0]);
    expect(asked).toContain('ks-s24');                                      // newest
    expect(asked).not.toContain('ks-s00');                                  // oldest are left out
  });

  it('runs at most 3 requests at a time', async () => {
    for (let i = 0; i < 9; i++) put(makeSession({ local_session_id: `s${i}` }));
    let running = 0, peak = 0;
    mockServerState.mockImplementation(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
      return { status: 'recording', ended_at: null };
    });
    const p = (await loadStore()).reconcileWithServer();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(mockServerState).toHaveBeenCalledTimes(9);
    expect(peak).toBe(3);
  });

  it('does not ask again within 60 s (opening Sessions repeatedly), then does', async () => {
    put(makeSession({ local_session_id: 'a' }));
    mockServerState.mockResolvedValue({ status: 'recording', ended_at: null });
    const store = await loadStore();

    await store.reconcileWithServer();
    await vi.advanceTimersByTimeAsync(30_000);
    await store.reconcileWithServer();
    expect(mockServerState).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(31_000);
    await store.reconcileWithServer();
    expect(mockServerState).toHaveBeenCalledTimes(2);
  });

  it('a failed check also counts toward the 60 s (a down server is not hammered)', async () => {
    put(makeSession({ local_session_id: 'a' }));
    mockServerState.mockRejectedValue(new Error('down'));
    const store = await loadStore();
    await store.reconcileWithServer();
    await store.reconcileWithServer();
    expect(mockServerState).toHaveBeenCalledTimes(1);
  });

  it('single-flight: two simultaneous calls make one round of requests', async () => {
    put(makeSession({ local_session_id: 'a' }));
    mockServerState.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 10)); return { status: 'recording', ended_at: null }; });
    const store = await loadStore();
    const [p1, p2] = [store.reconcileWithServer(), store.reconcileWithServer()];
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([p1, p2]);
    expect(mockServerState).toHaveBeenCalledTimes(1);
  });
});

describe('with the automatic sync sweep (launch / foreground / reconnection)', () => {
  it('a half-flushed record the server already ended is NOT re-uploaded (no duplicate)', async () => {
    // recorded offline, partially flushed, backend session exists: isSessionSyncable() alone would re-send its audio
    put(makeSession({ local_session_id: 'half', metadata: { recorded_offline: true, device_name: 'iPhone', backend_stopped: false } }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    (offlineStorage.getChunksMeta as ReturnType<typeof vi.fn>).mockResolvedValue([
      { local_chunk_id: 'c1', local_session_id: 'half', chunk_index: 0, start_ms: 0, end_ms: 5000, mime_type: 'audio/webm', size_bytes: 10, saved_at: '', uploaded_at: null, status: 'saved' },
    ]);
    (offlineStorage.getChunkBlob as ReturnType<typeof vi.fn>).mockResolvedValue(new Blob(['x']));

    await store.autoSyncPending();

    expect(get1('half').status).toBe('synced');
    noAudioSent();
  });

  it('the same record, when the server has NOT ended it, is still re-sent as before (behaviour preserved)', async () => {
    put(makeSession({ local_session_id: 'half', metadata: { recorded_offline: true, device_name: 'iPhone', backend_stopped: false } }));
    mockServerState.mockResolvedValue({ status: 'recording', ended_at: null });
    mockStopDevice.mockResolvedValue(undefined);
    mockUploadChunk.mockResolvedValue(undefined);
    const store = await loadStore();
    const { offlineStorage } = await import('./offlineStorage');
    (offlineStorage.getChunksMeta as ReturnType<typeof vi.fn>).mockResolvedValue([
      { local_chunk_id: 'c1', local_session_id: 'half', chunk_index: 0, start_ms: 0, end_ms: 5000, mime_type: 'audio/webm', size_bytes: 10, saved_at: '', uploaded_at: null, status: 'saved' },
    ]);
    (offlineStorage.getChunkBlob as ReturnType<typeof vi.fn>).mockResolvedValue(new Blob(['x']));

    await store.autoSyncPending();

    expect(mockUploadChunk).toHaveBeenCalledTimes(1);
  });

  it('a pending-stop record the server ended is reconciled BEFORE any stop retry', async () => {
    put(makeSession({ local_session_id: 'p', metadata: { recorded_offline: false, device_name: 'iPhone', backend_stop_pending: true,
      backend_stop_issue: { kind: 'timeout', message: 'x', status: null, at: '', attempts: 1 } } }));
    mockServerState.mockResolvedValue({ status: 'completed', ended_at: '2026-11-03T17:45:00Z' });

    await (await loadStore()).autoSyncPending();

    expect(get1('p').status).toBe('synced');
    expect(mockStopDevice).not.toHaveBeenCalled();
  });
});
