// knowledgeSessionApi — real backend contract for EigenVertex KnowledgeSession.
//
// Session start flows:
//   Flow A (planned session): recorderSync(reconcile) → devices → start (only if not already live)
//   Flow B/C (new capture):   startNow() → devices
//     startNow() creates the session, Room and recording state atomically.
//     Do NOT call POST /start after startNow() — the session is already recording.
//
// All calls use the shared request() wrapper from auth/api.ts (JWT, base URL config).

import { request } from '$lib/auth/api';
import { isNative } from '$lib/platform';
import { getSupportedMimeType } from './audioRecorder';

// ── Payloads & responses ───────────────────────────────────────────────────

export type KnowledgeSessionType =
  | 'meeting'
  | 'interview'
  | 'event'
  | 'media_capture'
  | 'field_visit'
  | 'voice_note';

export type KnowledgeSessionMode = 'online' | 'offline' | 'hybrid';

/** A participant as sent on the wire — backend expects display_name objects, not bare strings. */
export interface ParticipantPayload {
  display_name: string;
}

/** Convert local participant name list → wire format. Returns undefined when empty (omit field). */
export function toParticipantPayload(names: string[]): ParticipantPayload[] | undefined {
  const list = names.map((n) => n.trim()).filter(Boolean).map((display_name) => ({ display_name }));
  return list.length ? list : undefined;
}

// ── POST /v1/knowledge-sessions/start-now ─────────────────────────────────
//
// Preferred path for all new captures (Flow B/C). Creates the KnowledgeSession,
// Room and recording state in a single atomic call. After this call:
//   • session.status === 'recording' — do NOT call POST /start again
//   • room.id is the canonical Room — persist it, never fabricate it locally
//
// request_id: client-generated idempotency key. Include on every call so that
// a retry after network loss doesn't create a second session. The backend may
// not yet honor this field — if it doesn't, the client must use GET /recordable
// to search for the session before retrying.

export interface StartNowPayload {
  title?:              string | null;
  session_type?:       KnowledgeSessionType;
  interaction_subtype?: string | null;
  business_context?:   string | null;
  knowledge_intent?:   string;
  target_type?:        string;
  workspace_id?:       string | null;
  thread_id?:          string | null;
  project_id?:         string | null;
  target_corpus_id?:   string | null;
  subject?:            string | null;
  agenda?:             string | null;
  location_label?:     string | null;
  geo_lat?:            number | null;
  geo_lng?:            number | null;
  participants?:       ParticipantPayload[];
  metadata_json?:      Record<string, unknown>;
  request_id?:         string;  // idempotency key — send always; backend may not honor yet
}

/**
 * Response from POST /v1/knowledge-sessions/start-now.
 * The exact JSON shape depends on the backend implementation. If the backend
 * wraps session and room in nested objects, adjust the field mapping in
 * startNowKnowledgeSession() accordingly rather than changing this type.
 */
export interface StartNowResponse {
  id:      string;   // knowledge session UUID
  room_id: string | null;   // canonical Room UUID (may be null if Room creation is deferred)
  status:  string;
  title:   string;
}

interface StartNowWireResponse {
  session: {
    id: string;
    status: string;
    title: string;
  };
  room: {
    id: string;
  } | null;
}

export async function startNowKnowledgeSession(
  payload: StartNowPayload
): Promise<StartNowResponse> {
  const response = await request<StartNowWireResponse>('/knowledge-sessions/start-now', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!response.session?.id) {
    throw new Error('Invalid start-now response: missing session id');
  }

  return {
    id: response.session.id,
    room_id: response.room?.id ?? null,
    status: response.session.status,
    title: response.session.title,
  };
}

// ── POST /v1/knowledge-sessions (Flow A — planned session creation fallback) ──
// Used only when creating a NEW session via the full form AND the backend does
// not yet support start-now with the full payload. Prefer startNowKnowledgeSession.

export interface CreateKnowledgeSessionPayload {
  workspace_id?:   string | null;
  thread_id?:      string | null;
  project_id?:     string | null;
  target_corpus_id?: string | null;
  title:           string;
  session_type:    KnowledgeSessionType;
  mode:            KnowledgeSessionMode;
  subject?:        string | null;
  agenda?:         string | null;
  location_label?: string | null;
  geo_lat?:        number | null;
  geo_lng?:        number | null;
  participants?:   ParticipantPayload[];
  knowledge_intent?: 'operate_project' | 'collect_knowledge' | 'personal_note' | 'undecided';
  target_type?: 'project' | 'corpus' | 'inbox';
  interaction_subtype?: string | null;
  business_context?: string | null;
  metadata_json?:  Record<string, unknown>;
}

/**
 * Payload for POST /v1/knowledge-sessions/{id}/recorder-sync.
 * Backend MERGES metadata_json rather than overwriting it — safe to send
 * only the recorder-known subset on every sync.
 */
export interface RecorderSyncPayload {
  thread_id?:       string | null;
  target_corpus_id?: string | null;
  project_id?:     string | null;
  interaction_subtype?: string | null;
  business_context?: string | null;
  title?:          string | null;
  session_type?:   KnowledgeSessionType;
  mode?:           KnowledgeSessionMode;
  subject?:        string | null;
  agenda?:         string | null;
  location_label?: string | null;
  geo_lat?:        number | null;
  geo_lng?:        number | null;
  participants?:   ParticipantPayload[];
  metadata_json?:  Record<string, unknown>;
}

export interface KnowledgeSessionResponse {
  id:           string;
  title:        string;
  session_type: string;
  mode:         KnowledgeSessionMode;
  status:       string;
  created_at:   string;
}

// ── Device capabilities ────────────────────────────────────────────────────
//
// Two-level capture_profile schema (§3.C of the start-contract):
//   session.metadata_json.capture_profile  = 'microphone_only' | 'system_audio_only' | 'system_and_microphone'
//   device.capabilities_json.source        = 'microphone' | 'system_audio'
//
// `mode=online` (session field) describes network connectivity, not audio source — never use it
// to signal that system audio is being captured.

export interface DeviceCapabilities {
  platform:      string;
  app_version:   string;
  sample_rate:   number;
  codec:         string;
  channels:      number;
  /** Audio source for this device: 'microphone' for all Recorder captures. */
  source:        'microphone' | 'system_audio';
  encoding:      string;       // 'pcm_s16le' for stream mode; matches WebSocket handshake
  is_native:     boolean;
  user_agent?:   string;
}

export interface RegisterDevicePayload {
  device_name:       string;
  device_type:       'mobile' | 'laptop' | 'tablet' | 'desktop';
  client_type:       'capacitor_ios' | 'capacitor_android' | 'pwa' | 'web';
  capabilities_json: DeviceCapabilities;
}

export interface RegisterDeviceResponse {
  id:          string;
  device_name: string;
  device_type: string;
}

// ── Audio chunk upload ─────────────────────────────────────────────────────

export interface AudioChunkUploadParams {
  knowledge_session_id: string;
  device_id:            string;
  local_session_id:     string;
  chunk_index:          number;
  start_ms:             number;
  end_ms:               number;
  mime_type:            string;
  size_bytes:           number;
  blob:                 Blob;
}

/**
 * Upload a single audio chunk to EigenVertex.
 * Batch fallback path — used when WebSocket realtime is unavailable.
 * Chunk assembly on the backend is byte-concatenation (not ffmpeg), so
 * chunks MUST be raw PCM or a single compatible stream, never independent
 * containers (.m4a, .webm) that can't be safely concatenated.
 */
export async function uploadAudioChunk(params: AudioChunkUploadParams): Promise<void> {
  const { knowledge_session_id, device_id, blob, ...meta } = params;

  const form = new FormData();
  form.append('audio', blob, `chunk_${String(meta.chunk_index).padStart(4, '0')}.${_extForMime(meta.mime_type)}`);
  // Integer fields must be truncated to whole numbers — NativeAudioRecorder (iOS)
  // returns timestamps as Swift Double, which can produce fractional milliseconds
  // (e.g. 5001.5). String("5001.5") fails FastAPI's integer validator.
  form.append('device_id',    device_id);
  form.append('chunk_index',  String(Math.round(meta.chunk_index)));
  form.append('start_ms',     String(Math.round(meta.start_ms)));
  form.append('end_ms',       String(Math.round(meta.end_ms)));
  form.append('mime_type',    meta.mime_type);
  form.append('size_bytes',   String(Math.round(meta.size_bytes)));
  form.append('local_session_id', meta.local_session_id);

  await request(`/knowledge-sessions/${knowledge_session_id}/audio-chunks`, {
    method:  'POST',
    body:    form,
    headers: {}, // let fetch set multipart/form-data boundary automatically
  });
}

function _extForMime(mime: string): string {
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav'))  return 'wav';
  if (mime.includes('ogg'))  return 'ogg';
  return 'webm';
}

// ── Session stop ───────────────────────────────────────────────────────────

/** Canonically stop a session on the backend — POST /v1/knowledge-sessions/{id}/stop */
export async function stopKnowledgeSession(sessionId: string): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/stop`, { method: 'POST' });
}

// ── Audio recovery ─────────────────────────────────────────────────────────
//
// POST /v1/knowledge-sessions/{session_id}/audio-recovery
//
// Called when the realtime WebSocket stream failed (e.g. fatal
// "realtime_resume_unavailable") and the full local backup must be uploaded to
// repair the session server-side. The server reassembles the audio and
// re-triggers transcription.
//
// Never called automatically — only triggered after a confirmed fatal error
// from the WebSocket transport.

export async function audioRecovery(
  sessionId:  string,
  deviceId:   string,
  recoveryId: string,   // stable UUID per session — use local_session_id for idempotent retries
  durationMs: number,
  blob:       Blob,
  mimeType:   string,
): Promise<void> {
  const form = new FormData();
  form.append('audio',       blob, `recovery.${_extForMime(mimeType)}`);
  form.append('mime_type',   mimeType);
  form.append('device_id',   deviceId);
  form.append('recovery_id', recoveryId);
  form.append('duration_ms', String(Math.round(durationMs)));
  await request(`/knowledge-sessions/${sessionId}/audio-recovery`, {
    method:  'POST',
    body:    form,
    headers: {},
  });
}

// ── Live Room share ────────────────────────────────────────────────────────
//
// POST /v1/knowledge-sessions/{session_id}/live-share
//
// Creates (or retrieves an existing) public share link for this session's Live Room.
// The call is idempotent server-side: a repeated call on the same session returns
// the same share as long as it has not been revoked or expired.
//
// CRITICAL: share_url is constructed server-side and must be used verbatim — never
// reconstruct it from the token, session id, or title. Always copy the string from
// the server response all the way to the open/share action.
//
// DELETE /v1/knowledge-sessions/{session_id}/live-share
// Revokes the share. Only call after the user explicitly confirms revocation.
// Never clear the local cache before the DELETE is confirmed by the server.

export interface LiveShareResponse {
  room_id:    string;
  session_id: string;
  share_url:  string;   // ← canonical URL to open — never reconstruct it locally
  expires_at: string;   // ISO datetime; used for display only, not for cache invalidation
}

/**
 * Create (or retrieve) a public share link for a session's Live Room.
 * Idempotent server-side. Returns share_url — the only URL to open or share.
 */
export async function createLiveShare(sessionId: string): Promise<LiveShareResponse> {
  return request<LiveShareResponse>(`/knowledge-sessions/${sessionId}/live-share`, {
    method: 'POST',
  });
}

/**
 * Revoke the Live Room share for a session.
 * Only call after explicit user confirmation, and only clear local cache on success.
 */
export async function revokeLiveShare(sessionId: string): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/live-share`, { method: 'DELETE' });
}

// ── GET /v1/knowledge-sessions/{id}/live-state ─────────────────────────────
//
// Authenticated read-only route — safe for any session state (recording, stopped,
// finalized). Returns the current live/finalized view URL for the session.
// Never calls POST /live-share — no side effects.
//
// Use this instead of POST /live-share for stopped or synced sessions.

export interface LiveStateParticipant {
  display_name: string;
}

export interface LiveStateResponse {
  status:        string;
  title?:        string | null;
  transcript?:   string | null;
  summary?:      string | null;
  action_items?: string[] | null;
  participants?: LiveStateParticipant[] | null;
  started_at?:   string | null;
  ended_at?:     string | null;
  duration_ms?:  number | null;
}

/**
 * Read the finalized state of a session — transcript, summary, participants, etc.
 * Read-only, no side effects. Safe for any session state (recording, stopped, finalized).
 * Never returns a public share URL — use GET /live-share route for that (active sessions only).
 */
export async function getLiveState(sessionId: string): Promise<LiveStateResponse> {
  return request<LiveStateResponse>(`/knowledge-sessions/${sessionId}/live-state`);
}

// ── API calls ──────────────────────────────────────────────────────────────

/** Case B/C — create a new KnowledgeSession from the recorder form.
 *  @deprecated Prefer startNowKnowledgeSession() which is atomic and avoids orphan draft sessions.
 *  Keep this for backends that don't yet support /start-now with full metadata.
 */
export async function createKnowledgeSession(
  payload: CreateKnowledgeSessionPayload
): Promise<KnowledgeSessionResponse> {
  return request<KnowledgeSessionResponse>('/knowledge-sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Case A — reconcile a pre-existing planned session with the recorder's own
 * form state and geolocation right before Start. The recorder is the source
 * of truth at this moment: its location_label/geo_lat/geo_lng must win over
 * whatever was entered earlier in the app, so they are always sent here.
 */
export async function syncKnowledgeSessionFromRecorder(
  sessionId: string,
  payload: RecorderSyncPayload
): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/recorder-sync`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Register the current device as a participant in the session */
export async function registerKnowledgeSessionDevice(
  sessionId: string,
  payload: RegisterDevicePayload
): Promise<RegisterDeviceResponse> {
  return request<RegisterDeviceResponse>(
    `/knowledge-sessions/${sessionId}/devices`,
    { method: 'POST', body: JSON.stringify(payload) }
  );
}

/** Mark the session as started on the backend.
 *  Only call for Flow A (planned session) when status is 'draft' or 'ready'.
 *  startNow() already returns a recording session — never call start after startNow.
 *  Skip if status is already 'recording'; use resumeKnowledgeSession() for 'paused'. */
export async function startKnowledgeSession(sessionId: string): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/start`, { method: 'POST' });
}

/**
 * Resume a paused session — Flow A only, when planned session status === 'paused'.
 * Reuses the same device_id and resumes with a monotone frame_index.
 * Do NOT call start() on a paused session — that may create a state conflict.
 */
export async function resumeKnowledgeSession(sessionId: string): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/resume`, { method: 'POST' });
}

// ── Device payload builder ─────────────────────────────────────────────────

/**
 * Build the device registration payload for the current environment.
 * Eigen Recorder always captures microphone audio (source: 'microphone').
 * For system audio, Eigen Companion must be used instead.
 */
export function buildDevicePayload(): RegisterDevicePayload {
  const native    = isNative();
  const codec     = getSupportedMimeType();
  const ua        = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const platform  = typeof navigator !== 'undefined' ? (navigator.platform ?? 'unknown') : 'unknown';
  const isPwa     = typeof window !== 'undefined' &&
                    window.matchMedia('(display-mode: standalone)').matches;

  const deviceType: RegisterDevicePayload['device_type'] =
    native ? 'mobile' :
    (typeof window !== 'undefined' && window.innerWidth < 1024 ? 'mobile' : 'laptop');

  const clientType: RegisterDevicePayload['client_type'] =
    native ? 'capacitor_ios' :
    isPwa  ? 'pwa'           : 'web';

  const capabilities: DeviceCapabilities = {
    platform:     native ? 'ios' : platform,
    app_version:  '0.2.0',
    sample_rate:  native ? 48000 : 16000,  // PCM stream mode is 16 kHz; native uses 48 kHz
    codec:        native ? 'audio/mp4' : (codec || 'audio/webm'),
    channels:     native ? 2 : 1,
    source:       'microphone',  // Recorder always captures microphone; system audio → Companion
    encoding:     'pcm_s16le',   // WebSocket realtime format (matches session_hello handshake)
    is_native:    native,
    user_agent:   ua.slice(0, 120),
  };

  return {
    device_name:       platform || (native ? 'iPhone' : 'Browser'),
    device_type:       deviceType,
    client_type:       clientType,
    capabilities_json: capabilities,
  };
}
