// ===== EIGEN RECORDER — TYPES =====

export type KnowledgeSessionType =
  | 'project_meeting'
  | 'expert_interview'
  | 'client_interview'
  | 'workshop'
  | 'field_visit'
  | 'audit_session'
  | 'follow_up'
  | 'free_recording'
  | 'other';

export const SESSION_TYPE_LABELS: Record<KnowledgeSessionType, string> = {
  project_meeting:  'Project Meeting',
  expert_interview: 'Expert Interview',
  client_interview: 'Client Interview',
  workshop:         'Workshop',
  field_visit:      'Field Visit',
  audit_session:    'Audit Session',
  follow_up:        'Follow-Up',
  free_recording:   'Free Recording',
  other:            'Other',
};

export type SessionMode = 'online' | 'offline' | 'hybrid';

export interface RecordableKnowledgeSession {
  id:                   string;
  title:                string;
  session_type:         KnowledgeSessionType;
  status:               string;
  mode:                 SessionMode;
  subject:              string;
  agenda:               string;
  location_label:       string | null;
  workspace_name:       string | null;
  project_id?:          string | null;
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
  device_id:            string | null;  // returned by POST /knowledge-sessions/{id}/devices
  title: string;
  session_type: KnowledgeSessionType;
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
  | 'error';          // upload failed

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
  session_type: KnowledgeSessionType;
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
  // Recorder-captured geolocation — source of truth at Start time, takes
  // precedence over any location previously entered in the app for a planned session.
  geo_lat?:             number | null;
  geo_lng?:             number | null;
  // Carried through from a picked planned session, when the backend provides one.
  project_id?:          string | null;
  knowledge_session_id: string | null;
  // Which recorder surface produced this session — feeds metadata_json.recorder_surface.
  recorder_surface?:    'new_session_form' | 'existing_session_form' | 'record_now';
}

export interface RecorderApiContract {
  createRemoteSession(session: LocalKnowledgeSession): Promise<string>;
  uploadChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void>;
  finalizeSession(sessionId: string, manifest: OfflineManifest): Promise<void>;
}
