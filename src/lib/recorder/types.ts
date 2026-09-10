// ===== EIGEN MEETING — TYPES =====

// ── Canonical backend session types (6 values — maps to KnowledgeSessionCanonicalType enum) ──
// These are the only values the EigenVertex backend accepts. Any other value → 422.
export type KnowledgeSessionType =
  | 'meeting'
  | 'interview'
  | 'event'
  | 'media_capture'
  | 'field_visit'
  | 'voice_note';

// Display labels for backend-returned canonical types (planned sessions picker, session detail).
export const SESSION_TYPE_LABELS: Record<string, string> = {
  meeting:       'Meeting',
  interview:     'Interview',
  event:         'Event',
  media_capture: 'Media Capture',
  field_visit:   'Field Visit',
  voice_note:    'Voice Note',
  // Legacy local values — kept so old local sessions still display gracefully
  project_meeting:  'Project Meeting',
  expert_interview: 'Expert Interview',
  client_interview: 'Client Interview',
  workshop:         'Workshop',
  audit_session:    'Audit Session',
  follow_up:        'Follow-Up',
  free_recording:   'Free Recording',
  other:            'Other',
};

// ── Capture profiles (9 UI profiles → canonical backend fields) ──
// These are interface constructs, NOT backend types. The form shows these profiles;
// submit() derives session_type, interaction_subtype, business_context, knowledge_intent.
export interface CaptureProfile {
  id:                    string;
  icon:                  string;
  label:                 string;
  labelFr:               string;
  session_type:          KnowledgeSessionType;
  interaction_subtype?:  string;
  business_context?:     string;
  knowledge_intent?:     'operate_project' | 'collect_knowledge' | 'personal_note' | 'undecided';
  /** Whether this profile implies possible online/system audio content (shows Companion check). */
  requires_companion_check?: boolean;
}

export const CAPTURE_PROFILES: CaptureProfile[] = [
  {
    id: 'notes', icon: '📝', label: 'Notes', labelFr: 'Notes',
    session_type: 'voice_note',
    knowledge_intent: 'personal_note',
  },
  {
    id: 'candidate_interview', icon: '👤', label: 'Candidate interview', labelFr: 'Entretien candidat',
    session_type: 'interview',
    interaction_subtype: 'candidate',
  },
  {
    id: 'expert_interview', icon: '🎓', label: 'Expert interview', labelFr: 'Interview expert',
    session_type: 'interview',
    interaction_subtype: 'expert',
  },
  {
    id: 'client_call', icon: '📞', label: 'Client call', labelFr: 'Call client',
    session_type: 'interview',
    interaction_subtype: 'client',
    requires_companion_check: true,
  },
  {
    id: 'webinar', icon: '🖥', label: 'Webinar', labelFr: 'Webinaire',
    session_type: 'event',
    interaction_subtype: 'webinar',
    requires_companion_check: true,
  },
  {
    id: 'conference', icon: '🏛', label: 'Conference', labelFr: 'Conférence',
    session_type: 'event',
    interaction_subtype: 'conference',
    requires_companion_check: true,
  },
  {
    id: 'podcast', icon: '🎙', label: 'Podcast', labelFr: 'Podcast',
    session_type: 'media_capture',
    interaction_subtype: 'podcast',
    requires_companion_check: true,
  },
  {
    id: 'field_visit', icon: '🏢', label: 'Field visit', labelFr: 'Visite terrain',
    session_type: 'field_visit',
  },
  {
    id: 'workshop', icon: '👥', label: 'Workshop', labelFr: 'Atelier',
    session_type: 'meeting',
    interaction_subtype: 'workshop',
  },
];

// ── Audio source (capture_profile two-level schema per §3.C of the contract) ──
// Describes where the audio comes from. Independent of session.mode (network mode).
// Stored in session.metadata_json.capture_profile and device.capabilities_json.source.
export type AudioSource = 'microphone_only' | 'system_audio_only' | 'system_and_microphone';

export type SessionMode = 'online' | 'offline' | 'hybrid';

export interface RecordableKnowledgeSession {
  id:                   string;
  title:                string;
  session_type:         string;   // string, not narrow type — backend may return any canonical value
  status:               string;
  mode:                 SessionMode;
  subject:              string;
  agenda:               string;
  location_label:       string | null;
  workspace_name:       string | null;
  project_id?:          string | null;
  workspace_id?:        string | null;
  target_corpus_id?:    string | null;
  knowledge_intent?:    'operate_project' | 'collect_knowledge' | 'personal_note' | 'undecided';
  target_type?:         'project' | 'corpus' | 'inbox';
  interaction_subtype?: string | null;
  business_context?:    string | null;
  can_resume_recording: boolean;
  is_live:              boolean;
  participants?:        string[];
}

export type LocalSessionStatus =
  | 'draft'
  | 'ready'
  | 'recording_offline'
  | 'paused'
  | 'stopped_local'     // recorded locally, not yet sent to backend
  | 'synced'            // backend confirmed stop (POST /stop succeeded)
  | 'mock_uploading'
  | 'mock_synced'
  | 'error';

// Client-side recorder state machine (independent of backend session status).
// Backend statuses (recording/paused/processing_offline/completed) are never
// assigned directly here — they must stay in separate vocabulary.
export type RecorderState =
  | 'idle'
  | 'creating_local_session'
  | 'ready'
  | 'mic_permission_required'
  | 'mic_permission_denied'
  | 'recording_offline'
  | 'paused'
  | 'stopping'
  | 'stopped_local'
  | 'synced'
  | 'mock_uploading'
  | 'mock_synced'
  | 'error';

export interface SessionMetadata {
  recorded_offline:  boolean;
  device_name:       string;
  browser?:          string;
  platform?:         string;
  chunk_duration_ms?: number;
  mime_type?:        string;
  backend_stopped?:  boolean; // true when POST /stop confirmed by backend
  [key: string]: unknown;
}

export interface LocalKnowledgeSession {
  local_session_id:     string;
  remote_session_id:    string | null;  // kept for backward compat (mock sync)
  knowledge_session_id: string | null;  // canonical EigenVertex backend ID
  room_id:              string | null;  // EigenVertex Room ID (from start-now or existing session)
  device_id:            string | null;  // returned by POST /knowledge-sessions/{id}/devices
  title: string;
  session_type: string;   // canonical KnowledgeSessionType as stored/returned by backend
  mode: SessionMode;
  subject: string;
  agenda: string;
  participants: string[];
  location_label: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
  status: LocalSessionStatus;
  metadata: SessionMetadata;
}

export type AudioChunkStatus =
  | 'saved'           // persisted locally, not yet uploaded
  | 'pending_sync'    // no backend session context yet (missing knowledge_session_id or device_id)
  | 'uploading'       // upload in progress
  | 'uploaded'        // confirmed by backend
  | 'error'           // upload failed
  | 'backup_only';    // stream-mode local backup — audio already sent via WebSocket, kept for Share Audio only; never auto-uploaded

export interface AudioChunkMetadata {
  local_chunk_id: string;
  local_session_id: string;
  chunk_index: number;
  start_ms: number;
  end_ms: number;
  mime_type: string;
  size_bytes: number;
  sha256?: string;
  saved_at: string;
  uploaded_at: string | null;
  status: AudioChunkStatus;
}

export interface AudioChunkData {
  local_chunk_id: string;
  blob: Blob;
}

export interface OfflineManifest {
  local_session_id: string;
  remote_session_id: string | null;
  title: string;
  session_type: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  chunks: Array<{
    chunk_index: number;
    start_ms: number;
    end_ms: number;
    mime_type: string;
    size_bytes: number;
    sha256?: string;
  }>;
  metadata: SessionMetadata;
}

export type SyncMode = 'local' | 'stream';

// State of the live PCM16 WebSocket stream (stream mode only)
export type LiveStreamState = 'idle' | 'connecting' | 'streaming' | 'reconnecting' | 'failed';

export interface RecorderStoreState {
  state: RecorderState;
  currentSession: LocalKnowledgeSession | null;
  chunks: AudioChunkMetadata[];       // populated in local mode only
  elapsedMs: number;
  isOnline: boolean;
  micLevel: number;                   // single mono level 0..1
  errorMessage: string | null;
  totalSizeBytes: number;
  chunkDurationMs: number;
  syncMode: SyncMode;
  liveStreamState: LiveStreamState;   // PCM WebSocket state (stream mode)
  framesStreamed: number;             // PCM frames successfully sent
  streamPulse: boolean;               // true briefly on each frame sent (animation)
}

export interface CreateSessionParams {
  title:                string;
  session_type:         KnowledgeSessionType;
  subject:              string;
  agenda:               string;
  participants:         string[];
  location_label:       string | null;
  // Recorder-captured geolocation — source of truth at Start time.
  geo_lat?:             number | null;
  geo_lng?:             number | null;
  // Derived from CaptureProfile selection
  interaction_subtype?: string | null;
  business_context?:    string | null;
  capture_profile_id?:  string;        // the profile.id chosen in the UI (for metadata)
  // Audio source (two-level: capture_profile in metadata, source in device capabilities)
  audio_source?:        AudioSource;
  // Remote participants flag (stored in metadata_json)
  remote_participants?: boolean | null;  // null = 'not sure'
  // Workspace / project / corpus routing
  project_id?:          string | null;
  workspace_id?:        string | null;
  target_corpus_id?:    string | null;
  knowledge_intent?:    'operate_project' | 'collect_knowledge' | 'personal_note' | 'undecided';
  target_type?:         'project' | 'corpus' | 'inbox';
  // Pre-existing planned session (flow A — keeps its own session_id)
  knowledge_session_id: string | null;

  // ── Flow A only (planned session) ──────────────────────────────────────
  // Backend status of the planned session at the moment the user taps Start.
  // Drives the conditional start/resume/skip logic in recorderStore flow A:
  //   'recording' → skip POST /start (already live)
  //   'paused'    → POST /resume (not /start — avoids state conflict)
  //   other       → POST /start (normal path for 'draft' / 'ready')
  planned_session_status?: string;

  // Set of field names the recorder actually modified from the planned session's values.
  // Fields absent from this set are omitted from recorder-sync so Studio data is preserved.
  // Location (location_label, geo_lat, geo_lng) is always sent regardless — recorder owns it.
  // Undefined (absent) = new capture (flow B/C); all fields are recorder-owned.
  recorder_modified_fields?: Set<'title' | 'subject' | 'agenda' | 'participants'>;

  // Which recorder surface produced this session — feeds metadata_json.recorder_surface.
  recorder_surface?:    'new_session_form' | 'existing_session_form' | 'record_now';
}

export interface RecorderApiContract {
  createRemoteSession(session: LocalKnowledgeSession): Promise<string>;
  uploadChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void>;
  finalizeSession(sessionId: string, manifest: OfflineManifest): Promise<void>;
}
