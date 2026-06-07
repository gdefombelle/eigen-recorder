// recorderStore — single source of truth for the active recording session.
// Owns the state machine, coordinates audio capture + storage + streaming.
//
// Two recording paths, ONE live-stream transport:
//
//   syncMode='stream' + ksId + devId + online
//     → PcmCapture (AudioWorklet, mono 16 kHz) + LiveStreamClient (WebSocket PCM16)
//     → no local WebM chunks; all audio streamed to EigenVertex in realtime
//
//   syncMode='local' (or stream without backend context)
//     → AudioRecorder (web MediaRecorder, WebM) or NativeAudioRecorder (iOS)
//     → chunks saved to IndexedDB; batch-upload / share later

import { writable, get } from 'svelte/store';
import type {
  RecorderStoreState,
  RecorderState,
  CreateSessionParams,
  LocalKnowledgeSession,
  AudioChunkMetadata,
  LiveStreamState,
} from './types';
import { AudioRecorder, getSupportedMimeType } from './audioRecorder';
import { NativeAudioRecorder } from './nativeAudioRecorder';
import { PcmCapture } from './pcmCapture';
import { LiveStreamClient } from './liveStreamClient';
import { offlineStorage } from './offlineStorage';
import { chunkQueue } from './chunkQueue';
import { mockRecorderApi } from './mockRecorderApi';
import { generateLocalId, getBrowserName } from './utils';
import { isNative } from '$lib/platform';
import {
  createKnowledgeSession,
  syncKnowledgeSessionFromRecorder,
  registerKnowledgeSessionDevice,
  startKnowledgeSession,
  stopKnowledgeSession,
  uploadAudioChunk,
  buildDevicePayload,
  toParticipantPayload,
} from './knowledgeSessionApi';
import { getUser, isAuthenticated, authStore } from '$lib/auth/auth';

const DEFAULT_CHUNK_MS = 5000;

const INITIAL: RecorderStoreState = {
  state:            'idle',
  currentSession:   null,
  chunks:           [],
  elapsedMs:        0,
  isOnline:         typeof navigator !== 'undefined' ? navigator.onLine : true,
  micLevel:         0,
  errorMessage:     null,
  totalSizeBytes:   0,
  chunkDurationMs:  DEFAULT_CHUNK_MS,
  syncMode:         'local',
  liveStreamState:  'idle',
  framesStreamed:   0,
  streamPulse:      false,
};

// ── Internal mutable state ───────────────────────────────────

// Local-mode recorder (web MediaRecorder or iOS native)
let recorder: AudioRecorder | NativeAudioRecorder | null = null;

// PCM stream-mode capture + WebSocket client
let pcmCapture: PcmCapture | null = null;
let liveClient: LiveStreamClient | null = null;

// Local backup MediaRecorder — runs on the same stream as PcmCapture.
// Saves a local WebM copy to IndexedDB so Share Audio works in stream mode.
let localBackupMR: MediaRecorder | null = null;
let localBackupBlobs: Blob[] = [];
let localBackupMimeType = '';

let timerInterval: ReturnType<typeof setInterval> | null = null;
let _creating = false; // idempotence guard

// Tracks upload promises (local mode) so _finalizeStop can flush before POST /stop
const _inflightUploads = new Map<string, Promise<void>>();

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
// Handles both PCM (live) and MediaRecorder (local) modes.

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (pcmCapture) {
      // PCM mode — elapsed from capture; level updated via onLevel callback
      update((s) => ({ ...s, elapsedMs: pcmCapture!.getElapsedMs() }));
    } else if (recorder) {
      // Local mode — elapsed + mic level from recorder
      const level = recorder.getMicLevel();
      update((s) => ({
        ...s,
        elapsedMs: recorder!.getElapsedMs(),
        micLevel:  level,
      }));
    }
  }, 100);
}

function stopTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
}

// ── Local-mode chunk handler ─────────────────────────────────
// Called by AudioRecorder / NativeAudioRecorder. Not used in PCM stream mode.

async function handleChunk(
  blob: Blob,
  chunkIndex: number,
  startMs: number,
  endMs: number
) {
  const { currentSession, chunkDurationMs } = get(recorderStore);
  if (!currentSession) return;

  const meta: AudioChunkMetadata = {
    local_chunk_id:   generateLocalId(),
    local_session_id: currentSession.local_session_id,
    chunk_index:      chunkIndex,
    start_ms:         startMs,
    end_ms:           endMs,
    mime_type:        recorder?.mimeType ?? '',
    size_bytes:       blob.size,
    saved_at:         new Date().toISOString(),
    uploaded_at:      null,
    status:           'saved',
  };

  // Persist first — never lose audio
  await offlineStorage.saveChunk(meta, blob);

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

  // Streaming upload (local mode + stream syncMode)
  const { syncMode, isOnline, currentSession: sess } = get(recorderStore);
  if (syncMode === 'stream' && isOnline) {
    const ksId  = sess?.knowledge_session_id;
    const devId = sess?.device_id;
    if (!ksId || !devId) {
      await offlineStorage.updateChunkStatus(meta.local_chunk_id, 'pending_sync');
      update((s) => ({
        ...s,
        chunks: s.chunks.map((c) =>
          c.local_chunk_id === meta.local_chunk_id
            ? { ...c, status: 'pending_sync' as const }
            : c
        ),
      }));
      return;
    }

    const uploadPromise = uploadAudioChunk({
      knowledge_session_id: ksId,
      device_id:            devId,
      local_session_id:     meta.local_session_id,
      chunk_index:          meta.chunk_index,
      start_ms:             meta.start_ms,
      end_ms:               meta.end_ms,
      mime_type:            meta.mime_type,
      size_bytes:           meta.size_bytes,
      blob,
    })
      .then(async () => {
        const uploadedAt = new Date().toISOString();
        await offlineStorage.updateChunkStatus(meta.local_chunk_id, 'uploaded', uploadedAt);
        update((s) => ({
          ...s,
          framesStreamed: s.framesStreamed + 1,
          chunks: s.chunks.map((c) =>
            c.local_chunk_id === meta.local_chunk_id
              ? { ...c, status: 'uploaded' as const, uploaded_at: uploadedAt }
              : c
          ),
        }));
      })
      .catch(() => {
        // Stays 'saved' — _flushUploads will retry on stop
      })
      .finally(() => {
        _inflightUploads.delete(meta.local_chunk_id);
      });
    _inflightUploads.set(meta.local_chunk_id, uploadPromise);
  }
}

// ── Flush helper (local mode) ────────────────────────────────
// Waits for in-flight chunk uploads and retries any still-pending.
// Skipped in PCM stream mode (no local chunks).

async function _flushUploads(session: LocalKnowledgeSession): Promise<void> {
  if (_inflightUploads.size > 0) {
    await Promise.allSettled([..._inflightUploads.values()]);
  }

  const ksId  = session.knowledge_session_id;
  const devId = session.device_id;
  if (!ksId || !devId) return;

  const allChunks = await offlineStorage.getChunksMeta(session.local_session_id);
  const toRetry   = allChunks.filter(
    (c) => c.status === 'saved' || c.status === 'pending_sync'
  );
  if (toRetry.length === 0) return;

  await Promise.allSettled(
    toRetry.map(async (chunk) => {
      const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
      if (!blob) return;
      try {
        await uploadAudioChunk({
          knowledge_session_id: ksId,
          device_id:            devId,
          local_session_id:     chunk.local_session_id,
          chunk_index:          chunk.chunk_index,
          start_ms:             chunk.start_ms,
          end_ms:               chunk.end_ms,
          mime_type:            chunk.mime_type,
          size_bytes:           chunk.size_bytes,
          blob,
        });
        const uploadedAt = new Date().toISOString();
        await offlineStorage.updateChunkStatus(chunk.local_chunk_id, 'uploaded', uploadedAt);
        update((s) => ({
          ...s,
          framesStreamed: s.framesStreamed + 1,
          chunks: s.chunks.map((c) =>
            c.local_chunk_id === chunk.local_chunk_id
              ? { ...c, status: 'uploaded' as const, uploaded_at: uploadedAt }
              : c
          ),
        }));
      } catch {
        // Stays 'saved' for manual retry later
      }
    })
  );
}

// ── Stop helper ──────────────────────────────────────────────
// Shared final step for both recording paths.

async function _finalizeStop(
  session: LocalKnowledgeSession,
  finalMs: number
): Promise<void> {
  const { syncMode, isOnline } = get(recorderStore);
  const ksId = session.knowledge_session_id;

  // Local mode: flush any pending chunk uploads before POST /stop
  if (ksId && isOnline && syncMode !== 'local') {
    await _flushUploads(session);
  }

  let backendStopped = false;

  if (ksId && isOnline && syncMode !== 'local') {
    try {
      await stopKnowledgeSession(ksId);
      backendStopped = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      update((s) => ({ ...s, errorMessage: `Backend stop failed: ${msg}` }));
    }
  }

  const finalStatus = backendStopped ? 'synced' : 'stopped_local';

  const updatedSession: LocalKnowledgeSession = {
    ...session,
    status:      finalStatus,
    ended_at:    new Date().toISOString(),
    duration_ms: finalMs,
    metadata: {
      ...session.metadata,
      backend_stopped: backendStopped,
    },
  };
  await offlineStorage.saveSession(updatedSession);

  update((s) => ({
    ...s,
    state:            'stopped_local',
    liveStreamState:  'idle',
    currentSession:   updatedSession,
    elapsedMs:        finalMs,
    micLevel:         0,
  }));
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

    const defaultMode: import('./types').SyncMode = isAuthenticated() ? 'stream' : 'local';
    update((s) => ({ ...s, syncMode: defaultMode }));

    if (typeof window !== 'undefined') {
      authStore.subscribe((user) => {
        update((s) => ({ ...s, syncMode: user ? 'stream' : 'local' }));
      });
    }
  },

  setChunkDuration(ms: number) {
    update((s) => ({ ...s, chunkDurationMs: ms }));
  },

  setSyncMode(mode: import('./types').SyncMode) {
    update((s) => ({ ...s, syncMode: mode, framesStreamed: 0, streamPulse: false }));
  },

  // ── Session lifecycle ──────────────────────────────────────

  async createSession(params: CreateSessionParams): Promise<string> {
    if (_creating) throw new Error('Session creation already in progress');
    _creating = true;
    try {
      transition('creating_local_session');

      const now        = new Date().toISOString();
      const online     = get(recorderStore).isOnline;
      const authed     = isAuthenticated();
      const shouldSync = authed && online;

      const draft: LocalKnowledgeSession = {
        local_session_id:     generateLocalId(),
        remote_session_id:    null,
        knowledge_session_id: params.knowledge_session_id ?? null,
        device_id:            null,
        title:                params.title.trim() || 'Untitled Session',
        session_type:         params.session_type,
        mode:                 shouldSync ? 'online' : 'offline',
        subject:              params.subject,
        agenda:               params.agenda,
        participants:         params.participants,
        location_label:       params.location_label,
        created_at:           now,
        started_at:           null,
        ended_at:             null,
        duration_ms:          0,
        status:               'draft',
        metadata: {
          recorded_offline: !shouldSync,
          device_name:      navigator?.platform ?? 'unknown',
          browser:          getBrowserName(),
        },
      };

      await offlineStorage.saveSession(draft);

      if (shouldSync) {
        let knowledgeSessionId = params.knowledge_session_id ?? null;

        // Recorder geolocation is the source of truth at Start time — it always
        // wins over any location previously entered in the app for a planned session.
        const geoLat   = params.geo_lat ?? null;
        const geoLng   = params.geo_lng ?? null;
        const surface  = params.recorder_surface
          ?? (knowledgeSessionId ? 'existing_session_form'
              : draft.session_type === 'free_recording' ? 'record_now' : 'new_session_form');
        const metadataJson = {
          recorder_surface: surface,
          location_source:  geoLat !== null && geoLng !== null ? 'recorder_geolocation'
                            : draft.location_label ? 'manual_entry' : 'unavailable',
        };

        try {
          if (knowledgeSessionId) {
            // Flow A — reconcile the pre-existing planned session with the
            // recorder's current form state + geolocation before starting it.
            await syncKnowledgeSessionFromRecorder(knowledgeSessionId, {
              project_id:     params.project_id ?? null,
              title:          draft.title,
              session_type:   draft.session_type,
              mode:           'online',
              subject:        draft.subject || null,
              agenda:         draft.agenda  || null,
              location_label: draft.location_label,
              geo_lat:        geoLat,
              geo_lng:        geoLng,
              participants:   toParticipantPayload(draft.participants),
              metadata_json:  metadataJson,
            });
          } else {
            // Flow B (full form) / Flow C (Record now) — create the backend
            // KnowledgeSession from the recorder form (Record now uses a
            // minimal payload but still creates a real session).
            const created = await createKnowledgeSession({
              project_id:     params.project_id ?? null,
              title:          draft.title,
              session_type:   draft.session_type,
              mode:           'online',
              subject:        draft.subject || null,
              agenda:         draft.agenda  || null,
              location_label: draft.location_label,
              geo_lat:        geoLat,
              geo_lng:        geoLng,
              participants:   toParticipantPayload(draft.participants),
              metadata_json:  metadataJson,
            });
            knowledgeSessionId = created.id;
          }

          const deviceRes = await registerKnowledgeSessionDevice(
            knowledgeSessionId,
            buildDevicePayload()
          );

          const withDevice: LocalKnowledgeSession = {
            ...draft,
            knowledge_session_id: knowledgeSessionId,
            device_id:            deviceRes.id,
            mode:                 'online',
            status:               'draft',
            metadata: { ...draft.metadata, recorded_offline: false },
          };
          await offlineStorage.saveSession(withDevice);

          await startKnowledgeSession(knowledgeSessionId);

          const synced: LocalKnowledgeSession = { ...withDevice, status: 'ready' };
          await offlineStorage.saveSession(synced);

          transition('ready', {
            currentSession: synced,
            chunks:         [],
            elapsedMs:      0,
            totalSizeBytes: 0,
          });

          return synced.local_session_id;

        } catch (err) {
          const fallback: LocalKnowledgeSession = {
            ...draft,
            knowledge_session_id: params.knowledge_session_id ?? null,
            mode:                 'offline',
            status:               'draft',
            metadata: { ...draft.metadata, recorded_offline: true },
          };
          await offlineStorage.saveSession(fallback);
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Backend unavailable — ${msg}`);
        }
      }

      const ready = { ...draft, status: 'ready' as const };
      await offlineStorage.saveSession(ready);
      transition('ready', { currentSession: ready, chunks: [], elapsedMs: 0, totalSizeBytes: 0 });
      return ready.local_session_id;

    } finally {
      _creating = false;
    }
  },

  async loadSession(localSessionId: string): Promise<void> {
    const session = await offlineStorage.getSession(localSessionId);
    if (!session) throw new Error(`Session not found: ${localSessionId}`);

    const chunks = await offlineStorage.getChunksMeta(localSessionId);
    const totalSizeBytes = chunks.reduce((acc, c) => acc + c.size_bytes, 0);

    const stateMap: Partial<Record<string, RecorderState>> = {
      draft:             'ready',
      ready:             'ready',
      recording_offline: 'stopped_local',
      paused:            'stopped_local',
      stopped_local:     'stopped_local',
      synced:            'mock_synced',
      mock_uploading:    'stopped_local',
      mock_synced:       'mock_synced',
      error:             'error',
    };

    const uiState: RecorderState = stateMap[session.status] ?? 'stopped_local';

    update((s) => ({
      ...s,
      state:          uiState,
      currentSession: session,
      chunks,
      totalSizeBytes,
      elapsedMs:      session.duration_ms,
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
    const { currentSession, state, chunkDurationMs, syncMode, isOnline } = get(recorderStore);
    if (!currentSession) return;
    if (state !== 'ready') return;

    const ksId  = currentSession.knowledge_session_id;
    const devId = currentSession.device_id;

    // ── PCM STREAM MODE ────────────────────────────────────────────────────
    // Conditions: authenticated stream mode + backend session context available
    if (syncMode === 'stream' && isOnline && ksId && devId) {
      const capture = new PcmCapture();
      const client  = new LiveStreamClient(ksId, devId);

      // Forward WebSocket state changes to store
      client.onStateChange = (liveState: LiveStreamState) => {
        update((s) => ({ ...s, liveStreamState: liveState }));
      };

      // Mic level (from AudioWorklet RMS) → store
      capture.onLevel = (level: number) => {
        update((s) => ({ ...s, micLevel: level }));
      };

      // PCM frame → WebSocket
      capture.onFrame = (pcm: ArrayBuffer, frameIndex: number, startMs: number, endMs: number) => {
        client.sendFrame(pcm, { frameIndex, startMs, endMs });
        // Brief pulse animation
        update((s) => ({ ...s, streamPulse: true, framesStreamed: s.framesStreamed + 1 }));
        setTimeout(() => update((s) => ({ ...s, streamPulse: false })), 400);
      };

      capture.onError = (err: Error) => {
        setError(`PCM capture error: ${err.message}`);
      };

      try {
        // Connect first; resolves when WebSocket is open and hello is sent
        await client.connect();
        // Then start the audio capture
        await capture.start();
      } catch (err) {
        capture.stop();
        client.close();
        setError(`Live stream failed to start: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      pcmCapture = capture;
      liveClient = client;

      // Start local backup recorder on the same stream for Share Audio support.
      // This is a local-only MediaRecorder — no second backend path.
      const backupMime = getSupportedMimeType();
      if (backupMime && capture.stream) {
        try {
          const mr = new MediaRecorder(capture.stream, { audioBitsPerSecond: 64_000, mimeType: backupMime });
          localBackupBlobs     = [];
          localBackupMimeType  = mr.mimeType || backupMime;
          mr.ondataavailable   = (ev) => { if (ev.data?.size > 0) localBackupBlobs.push(ev.data); };
          mr.start(10_000);
          localBackupMR = mr;
        } catch {
          // Backup recorder failed — share will be unavailable but streaming continues
        }
      }

      const now = new Date().toISOString();
      const updatedSession: LocalKnowledgeSession = {
        ...currentSession,
        started_at: currentSession.started_at ?? now,
        status:     'recording_offline',
      };
      await offlineStorage.saveSession(updatedSession);

      transition('recording_offline', {
        currentSession: updatedSession,
        framesStreamed: 0,
        liveStreamState: 'streaming',
      });
      startTimer();
      return;
    }

    // ── LOCAL / OFFLINE MODE ───────────────────────────────────────────────

    if (isNative()) {
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

    if (pcmCapture) {
      // PCM stream mode — suspend AudioContext (worklet stops, WS stays open)
      pcmCapture.pause();
      if (localBackupMR?.state === 'recording') {
        localBackupMR.requestData();
        localBackupMR.pause();
      }
    } else {
      recorder?.pause();
    }

    stopTimer();
    update((s) => ({ ...s, state: 'paused', micLevel: 0 }));
  },

  resumeRecording() {
    if (get(recorderStore).state !== 'paused') return;

    if (pcmCapture) {
      pcmCapture.resume();
      if (localBackupMR?.state === 'paused') localBackupMR.resume();
    } else {
      recorder?.resume();
    }

    transition('recording_offline');
    startTimer();
  },

  async stopRecording(): Promise<void> {
    const { currentSession } = get(recorderStore);
    if (!currentSession) return;

    transition('stopping');
    stopTimer();

    // ── PCM STREAM MODE ────────────────────────────────────────────────────
    if (pcmCapture && liveClient) {
      const finalMs = pcmCapture.getElapsedMs();

      // Stop audio capture first (no more frames)
      pcmCapture.stop();
      pcmCapture = null;

      // Signal backend end-of-recording via WebSocket before closing
      liveClient.commit();
      liveClient.close();
      liveClient = null;

      // Stop backup recorder and save local copy for Share Audio
      if (localBackupMR && localBackupMR.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          localBackupMR!.onstop = () => resolve();
          if (localBackupMR!.state === 'paused') localBackupMR!.resume();
          localBackupMR!.stop();
        });
      }
      if (localBackupBlobs.length > 0) {
        const merged = new Blob(localBackupBlobs, { type: localBackupMimeType || 'audio/webm' });
        const meta: AudioChunkMetadata = {
          local_chunk_id:   generateLocalId(),
          local_session_id: currentSession.local_session_id,
          chunk_index:      0,
          start_ms:         0,
          end_ms:           finalMs,
          mime_type:        localBackupMimeType || 'audio/webm',
          size_bytes:       merged.size,
          saved_at:         new Date().toISOString(),
          uploaded_at:      null,
          status:           'saved',
        };
        await offlineStorage.saveChunk(meta, merged);
        const sessionWithMime: LocalKnowledgeSession = {
          ...currentSession,
          metadata: { ...currentSession.metadata, mime_type: meta.mime_type, chunk_duration_ms: finalMs },
        };
        await offlineStorage.saveSession(sessionWithMime);
        update((s) => ({ ...s, chunks: [meta], totalSizeBytes: merged.size, currentSession: sessionWithMime }));
      }
      localBackupMR    = null;
      localBackupBlobs = [];

      await _finalizeStop(get(recorderStore).currentSession ?? currentSession, finalMs);
      return;
    }

    // ── NATIVE PATH ────────────────────────────────────────────────────────
    if (recorder instanceof NativeAudioRecorder) {
      const finalMs = recorder.getElapsedMs();
      await recorder.stop();
      recorder = null;
      await _finalizeStop(currentSession, finalMs);
      return;
    }

    // ── WEB (MediaRecorder) PATH ───────────────────────────────────────────
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
    recorder = null;
    await _finalizeStop(currentSession, finalMs);
  },

  // ── Mock upload (local mode post-recording) ───────────────

  async mockUpload(sessionId?: string): Promise<void> {
    const { currentSession } = get(recorderStore);
    const targetId = sessionId ?? currentSession?.local_session_id;
    if (!targetId) return;

    transition('mock_uploading');

    const api     = mockRecorderApi;
    const session = await offlineStorage.getSession(targetId);
    if (!session) return;

    try {
      const remoteId = await api.createRemoteSession(session);

      const chunks = await offlineStorage.getChunksMeta(targetId);
      const now    = new Date().toISOString();

      for (const chunk of chunks) {
        const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
        if (blob) await api.uploadChunk(chunk, blob);
        await offlineStorage.updateChunkStatus(chunk.local_chunk_id, 'uploaded', now);
      }

      const manifest = await offlineStorage.generateManifest(targetId);
      if (manifest) await api.finalizeSession(targetId, manifest);

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
    pcmCapture?.stop();
    pcmCapture = null;
    liveClient?.close();
    liveClient = null;
    if (localBackupMR && localBackupMR.state !== 'inactive') localBackupMR.stop();
    localBackupMR    = null;
    localBackupBlobs = [];
    recorder?.release();
    recorder = null;
    set(INITIAL);
  },
};
