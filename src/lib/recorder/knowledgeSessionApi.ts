// knowledgeSessionApi — real backend contract for EigenVertex KnowledgeSession.
//
// Flow at Start Session — recorder form + recorder geolocation are the
// source of truth at the moment of Start (they always win over whatever was
// pre-entered in the app for a planned session):
//   Case A (planned session): recorderSync(reconcile) → registerDevice → startSession
//   Case B (free session):    createSession           → registerDevice → startSession
//   Case C (Record now):      createSession (minimal) → registerDevice → startSession
//
// All calls use the shared request() wrapper from auth/api.ts (JWT, base URL config).

import { request } from '$lib/auth/api';
import { isNative } from '$lib/platform';
import { getSupportedMimeType } from './audioRecorder';

// ── Payloads & responses ───────────────────────────────────────────────────

export type KnowledgeSessionType =
  | 'project_meeting' | 'expert_interview' | 'client_interview'
  | 'workshop' | 'field_visit' | 'audit_session' | 'follow_up'
  | 'free_recording' | 'other';

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

export interface CreateKnowledgeSessionPayload {
  project_id?:     string | null;
  title:           string;
  session_type:    KnowledgeSessionType;
  mode:            KnowledgeSessionMode;
  subject?:        string | null;
  agenda?:         string | null;
  location_label?: string | null;
  geo_lat?:        number | null;
  geo_lng?:        number | null;
  participants?:   ParticipantPayload[];
  metadata_json?:  Record<string, unknown>;
}

/**
 * Payload for POST /v1/knowledge-sessions/{id}/recorder-sync.
 * Backend MERGES metadata_json rather than overwriting it — safe to send
 * only the recorder-known subset on every sync.
 */
export interface RecorderSyncPayload {
  project_id?:     string | null;
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
  session_type: KnowledgeSessionType;
  mode:         KnowledgeSessionMode;
  status:       string;
  created_at:   string;
}

export interface DeviceCapabilities {
  platform:      string;
  app_version:   string;
  sample_rate:   number;
  codec:         string;
  channels:      number;
  capture_type:  'native_avaudiorecorder' | 'web_mediarecorder';
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
 *
 * AUDIO_ENDPOINT_TBD — the exact path must be confirmed with the backend team.
 * Candidates (do not hardcode until validated):
 *   POST /v1/knowledge-sessions/{id}/audio-chunks
 *   POST /v1/knowledge-sessions/{id}/devices/{device_id}/audio-chunks
 *
 * The function is fully wired with the correct metadata. Swap the commented
 * placeholder below with the real path once confirmed, without changing the
 * call signature anywhere in the codebase.
 */
export async function uploadAudioChunk(params: AudioChunkUploadParams): Promise<void> {
  const { knowledge_session_id, device_id, blob, ...meta } = params;

  const form = new FormData();
  form.append('audio', blob, `chunk_${String(meta.chunk_index).padStart(4, '0')}.${_extForMime(meta.mime_type)}`);
  form.append('device_id',    device_id);
  form.append('chunk_index',  String(meta.chunk_index));
  form.append('start_ms',     String(meta.start_ms));
  form.append('end_ms',       String(meta.end_ms));
  form.append('mime_type',    meta.mime_type);
  form.append('size_bytes',   String(meta.size_bytes));
  form.append('local_session_id', meta.local_session_id);

  // ── AUDIO_ENDPOINT_TBD ──────────────────────────────────────────────────
  // Replace the path below when the backend audio-chunk endpoint is confirmed.
  // Do NOT use /recording-sessions — that sub-entity does not exist.
  // ──────────────────────────────────────────────────────────────────────────
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

// ── API calls ──────────────────────────────────────────────────────────────

/** Case B/C — create a new KnowledgeSession from the recorder form (or a minimal "Record now" payload) */
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
 * whatever was entered earlier in the app, so they are always sent here
 * (never skipped just because the planned session already had a location).
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

/** Mark the session as started on the backend */
export async function startKnowledgeSession(sessionId: string): Promise<void> {
  await request(`/knowledge-sessions/${sessionId}/start`, { method: 'POST' });
}

// ── Device payload builder ─────────────────────────────────────────────────

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
    sample_rate:  48000,
    codec:        native ? 'audio/mp4' : (codec || 'audio/webm'),
    channels:     native ? 2 : 1,
    capture_type: native ? 'native_avaudiorecorder' : 'web_mediarecorder',
    is_native:    native,
    user_agent:   ua.slice(0, 120), // truncate for payload size
  };

  return {
    device_name:       platform || (native ? 'iPhone' : 'Browser'),
    device_type:       deviceType,
    client_type:       clientType,
    capabilities_json: capabilities,
  };
}
