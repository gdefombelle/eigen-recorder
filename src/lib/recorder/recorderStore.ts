// recorderStore — single source of truth for the active recording session.
// Owns the state machine, coordinates AudioRecorder + OfflineStorage + ChunkQueue.

import { writable, get } from 'svelte/store';
import type {
  RecorderStoreState,
  RecorderState,
  CreateSessionParams,
  LocalKnowledgeSession,
  AudioChunkMetadata,
} from './types';
import { AudioRecorder } from './audioRecorder';
import { NativeAudioRecorder } from './nativeAudioRecorder';
import { offlineStorage } from './offlineStorage';
import { chunkQueue } from './chunkQueue';
import { mockRecorderApi } from './mockRecorderApi';
import { generateLocalId, getBrowserName } from './utils';
import { isNative } from '$lib/platform';

const DEFAULT_CHUNK_MS = 5000;

const INITIAL: RecorderStoreState = {
  state:           'idle',
  currentSession:  null,
  chunks:          [],
  elapsedMs:       0,
  isOnline:        typeof navigator !== 'undefined' ? navigator.onLine : true,
  micLevel:        0,
  micLevelL:       0,
  micLevelR:       0,
  errorMessage:    null,
  totalSizeBytes:  0,
  chunkDurationMs: DEFAULT_CHUNK_MS,
  syncMode:        'local',
  streamedCount:   0,
  streamPulse:     false,
};

// ── Internal mutable state ───────────────────────────────────

let recorder: AudioRecorder | NativeAudioRecorder | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;

// ── Store ────────────────────────────────────────────────────

const { subscribe, update, set } = writable<RecorderStoreState>(INITIAL);

function transition(newState: RecorderState, extra: Partial<RecorderStoreState> = {}) {
  update((s) => ({ ...s, state: newState, errorMessage: null, ...extra }));
}

function setError(msg: string) {
  stopTimer();
  update((s) => ({ ...s, state: 'error', errorMessage: msg }));
}

// ── Timer ────────────────────────────────────────────────────

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (!recorder) return;
    const [l, r] = recorder.getMicLevels();
    update((s) => ({
      ...s,
      elapsedMs:  recorder!.getElapsedMs(),
      micLevelL:  l,
      micLevelR:  r,
      micLevel:   (l + r) / 2,
    }));
  }, 100);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

// ── Chunk handler ────────────────────────────────────────────

async function handleChunk(
  blob: Blob,
  chunkIndex: number,
  startMs: number,
  endMs: number
) {
  const { currentSession, chunkDurationMs } = get(recorderStore);
  if (!currentSession) return;

  const meta: AudioChunkMetadata = {
    local_chunk_id:    generateLocalId(),
    local_session_id:  currentSession.local_session_id,
    chunk_index:       chunkIndex,
    start_ms:          startMs,
    end_ms:            endMs,
    mime_type:         recorder?.mimeType ?? '',
    size_bytes:        blob.size,
    saved_at:          new Date().toISOString(),
    uploaded_at:       null,
    status:            'saved',
  };

  // Save immediately — never lose audio.
  await offlineStorage.saveChunk(meta, blob);

  // Update session metadata
  const updatedSession: LocalKnowledgeSession = {
    ...currentSession,
    metadata: {
      ...currentSession.metadata,
      chunk_duration_ms: chunkDurationMs,
      mime_type: meta.mime_type,
    },
  };
  await offlineStorage.saveSession(updatedSession);

  update((s) => ({
    ...s,
    chunks:         [...s.chunks, meta],
    totalSizeBytes: s.totalSizeBytes + blob.size,
    currentSession: updatedSession,
  }));

  // ── Streaming upload ─────────────────────────────────────
  // If syncMode === 'stream' and online: upload chunk immediately via mock API
  const { syncMode, isOnline } = get(recorderStore);
  if (syncMode === 'stream' && isOnline) {
    // Pulse animation
    update((s) => ({ ...s, streamPulse: true }));
    setTimeout(() => update((s) => ({ ...s, streamPulse: false })), 600);

    // Upload (mock for now — swap with real API when backend is ready)
    mockRecorderApi.uploadChunk(meta, blob)
      .then(async () => {
        await offlineStorage.updateChunkStatus(meta.local_chunk_id, 'uploaded', new Date().toISOString());
        update((s) => ({
          ...s,
          streamedCount: s.streamedCount + 1,
          chunks: s.chunks.map((c) =>
            c.local_chunk_id === meta.local_chunk_id
              ? { ...c, status: 'uploaded' as const, uploaded_at: new Date().toISOString() }
              : c
          ),
        }));
      })
      .catch(() => { /* silent — chunk is safely saved locally */ });
  }
}

// ── Public store API ─────────────────────────────────────────

export const recorderStore = {
  subscribe,

  // ── Init ──────────────────────────────────────────────────

  init() {
    chunkQueue.init(mockRecorderApi);

    if (typeof window !== 'undefined') {
      window.addEventListener('online',  () => update((s) => ({ ...s, isOnline: true })));
      window.addEventListener('offline', () => update((s) => ({ ...s, isOnline: false })));
    }
  },

  setChunkDuration(ms: number) {
    update((s) => ({ ...s, chunkDurationMs: ms }));
  },

  setSyncMode(mode: import('./types').SyncMode) {
    update((s) => ({ ...s, syncMode: mode, streamedCount: 0, streamPulse: false }));
  },

  // ── Session lifecycle ──────────────────────────────────────

  async createSession(params: CreateSessionParams): Promise<string> {
    transition('creating_local_session');

    const now = new Date().toISOString();
    const session: LocalKnowledgeSession = {
      local_session_id:  generateLocalId(),
      remote_session_id: null,
      title:             params.title.trim() || 'Untitled Session',
      session_type:      params.session_type,
      mode:              'offline',
      subject:           params.subject,
      agenda:            params.agenda,
      participants:      params.participants,
      location_label:    params.location_label,
      created_at:        now,
      started_at:        null,
      ended_at:          null,
      duration_ms:       0,
      status:            'draft',
      metadata: {
        recorded_offline: true,
        device_name:      navigator?.platform ?? 'unknown',
        browser:          getBrowserName(),
      },
    };

    await offlineStorage.saveSession(session);

    transition('ready', {
      currentSession:  session,
      chunks:          [],
      elapsedMs:       0,
      totalSizeBytes:  0,
    });

    return session.local_session_id;
  },

  async loadSession(localSessionId: string): Promise<void> {
    const session = await offlineStorage.getSession(localSessionId);
    if (!session) throw new Error(`Session not found: ${localSessionId}`);

    const chunks = await offlineStorage.getChunksMeta(localSessionId);
    const totalSizeBytes = chunks.reduce((acc, c) => acc + c.size_bytes, 0);

    // Map persisted session status to UI state
    const stateMap: Partial<Record<string, RecorderState>> = {
      draft:             'ready',
      ready:             'ready',
      recording_offline: 'stopped_local', // was interrupted — treat as stopped
      paused:            'stopped_local',
      stopped_local:     'stopped_local',
      mock_uploading:    'stopped_local',
      mock_synced:       'mock_synced',
      error:             'error',
    };

    const uiState: RecorderState = stateMap[session.status] ?? 'stopped_local';

    update((s) => ({
      ...s,
      state:           uiState,
      currentSession:  session,
      chunks,
      totalSizeBytes,
      elapsedMs:       session.duration_ms,
    }));
  },

  // ── Microphone ────────────────────────────────────────────

  async requestMicrophone(): Promise<void> {
    transition('mic_permission_required');

    const r = isNative() ? new NativeAudioRecorder() : new AudioRecorder();

    if (!isNative() && (typeof navigator === 'undefined' || !navigator.mediaDevices)) {
      update((s) => ({ ...s, state: 'mic_permission_denied', errorMessage: 'Microphone not available in this browser.' }));
      return;
    }

    const result = await r.requestPermission();

    if (result === 'granted') {
      transition('ready');
    } else if (result === 'denied') {
      update((s) => ({
        ...s,
        state: 'mic_permission_denied',
        errorMessage: 'Microphone permission denied. Please allow mic access in browser settings.',
      }));
    } else {
      update((s) => ({
        ...s,
        state: 'mic_permission_denied',
        errorMessage: 'MediaRecorder is not supported in this browser.',
      }));
    }
  },

  // ── Recording controls ────────────────────────────────────

  async startRecording(): Promise<void> {
    const { currentSession, state, chunkDurationMs } = get(recorderStore);
    if (!currentSession) return;
    if (state !== 'ready') return;

    if (isNative()) {
      // ── Native path (Capacitor + EigenAudioPlugin) ──────────
      const native = new NativeAudioRecorder();
      native.onChunk = handleChunk;
      native.onError = (err) => setError(err.message);
      recorder = native;
      try {
        await native.start(currentSession.local_session_id, chunkDurationMs);
      } catch (err) {
        setError(`Native recording failed: ${err instanceof Error ? err.message : String(err)}`);
        recorder = null;
        return;
      }
    } else {
      // ── Web path (MediaRecorder) ─────────────────────────────
      const web = new AudioRecorder();
      web.onChunk = handleChunk;
      web.onError = (err) => setError(err.message);
      recorder = web;
      try {
        await web.start(chunkDurationMs);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Permission') || msg.includes('NotAllowed') || msg.includes('denied')) {
          update((s) => ({ ...s, state: 'mic_permission_denied', errorMessage: 'Microphone permission denied.' }));
        } else {
          setError(`Could not start recording: ${msg}`);
        }
        recorder = null;
        return;
      }
    }

    const now = new Date().toISOString();
    const updatedSession: LocalKnowledgeSession = {
      ...currentSession,
      started_at: currentSession.started_at ?? now,
      status:     'recording_offline',
    };
    await offlineStorage.saveSession(updatedSession);

    transition('recording_offline', { currentSession: updatedSession });
    startTimer();
  },

  pauseRecording() {
    if (get(recorderStore).state !== 'recording_offline') return;
    recorder?.pause();
    stopTimer();
    update((s) => ({
      ...s,
      state:    'paused',
      micLevel: 0,
    }));
  },

  resumeRecording() {
    if (get(recorderStore).state !== 'paused') return;
    recorder?.resume();
    transition('recording_offline');
    startTimer();
  },

  async stopRecording(): Promise<void> {
    const { currentSession } = get(recorderStore);
    if (!currentSession) return;

    transition('stopping');
    stopTimer();

    if (recorder instanceof NativeAudioRecorder) {
      // Native: stop() is fully async, chunks arrive via onChunk callbacks during stop()
      const finalMs = recorder.getElapsedMs();
      await recorder.stop(); // fires all onChunk + onStop internally
      recorder = null;

      const updatedSession: LocalKnowledgeSession = {
        ...currentSession,
        status:      'stopped_local',
        ended_at:    new Date().toISOString(),
        duration_ms: finalMs,
      };
      await offlineStorage.saveSession(updatedSession);
      update((s) => ({
        ...s,
        state:          'stopped_local',
        currentSession: updatedSession,
        elapsedMs:      finalMs,
        micLevel: 0, micLevelL: 0, micLevelR: 0,
      }));
      return;
    }

    // Web: stop fires ondataavailable for the last chunk, then onstop
    await new Promise<void>((resolve) => {
      if (recorder) {
        const prev = recorder.onStop;
        recorder.onStop = () => { prev?.(); resolve(); };
        (recorder as AudioRecorder).stop();
      } else {
        resolve();
      }
    });

    const { elapsedMs: elapsed } = get(recorderStore);
    const finalMs = recorder?.getElapsedMs() ?? elapsed;

    const updatedSession: LocalKnowledgeSession = {
      ...currentSession,
      status:     'stopped_local',
      ended_at:   new Date().toISOString(),
      duration_ms: finalMs,
    };
    await offlineStorage.saveSession(updatedSession);

    recorder = null;

    update((s) => ({
      ...s,
      state:           'stopped_local',
      currentSession:  updatedSession,
      elapsedMs:       finalMs,
      micLevel:        0,
    }));
  },

  // ── Mock upload ───────────────────────────────────────────

  async mockUpload(sessionId?: string): Promise<void> {
    const { currentSession } = get(recorderStore);
    const targetId = sessionId ?? currentSession?.local_session_id;
    if (!targetId) return;

    transition('mock_uploading');

    const api = mockRecorderApi;
    const session = await offlineStorage.getSession(targetId);
    if (!session) return;

    try {
      // Step 1: create remote session
      const remoteId = await api.createRemoteSession(session);

      // Step 2: upload each chunk
      const chunks = await offlineStorage.getChunksMeta(targetId);
      const now = new Date().toISOString();

      for (const chunk of chunks) {
        const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
        if (blob) await api.uploadChunk(chunk, blob);
        await offlineStorage.updateChunkStatus(chunk.local_chunk_id, 'uploaded', now);
      }

      // Step 3: finalize
      const manifest = await offlineStorage.generateManifest(targetId);
      if (manifest) await api.finalizeSession(targetId, manifest);

      // Step 4: persist mock_synced
      const syncedSession: LocalKnowledgeSession = {
        ...session,
        status:            'mock_synced',
        remote_session_id: remoteId,
        mode:              'hybrid',
      };
      await offlineStorage.saveSession(syncedSession);

      update((s) => ({
        ...s,
        state:          'mock_synced',
        currentSession: syncedSession,
        chunks:         s.chunks.map((c) =>
          c.local_session_id === targetId
            ? { ...c, status: 'uploaded', uploaded_at: now }
            : c
        ),
      }));
    } catch (err) {
      setError(`Mock upload failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },

  // ── Misc ──────────────────────────────────────────────────

  clearError() {
    update((s) => ({ ...s, state: s.state === 'error' ? 'idle' : s.state, errorMessage: null }));
  },

  reset() {
    stopTimer();
    recorder?.release();
    recorder = null;
    set(INITIAL);
  },
};
