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

export type LocalSessionStatus =
  | 'draft'
  | 'ready'
  | 'recording_offline'
  | 'paused'
  | 'stopped_local'
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
  recorded_offline: boolean;
  device_name: string;
  browser?: string;
  platform?: string;
  chunk_duration_ms?: number;
  mime_type?: string;
  [key: string]: unknown;
}

export interface LocalKnowledgeSession {
  local_session_id: string;
  remote_session_id: string | null;
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

export type AudioChunkStatus = 'saved' | 'uploading' | 'uploaded' | 'error';

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

export interface RecorderStoreState {
  state: RecorderState;
  currentSession: LocalKnowledgeSession | null;
  chunks: AudioChunkMetadata[];
  elapsedMs: number;
  isOnline: boolean;
  micLevel: number;
  micLevelL: number;
  micLevelR: number;
  errorMessage: string | null;
  totalSizeBytes: number;
  chunkDurationMs: number;
  syncMode: SyncMode;       // chosen before REC
  streamedCount: number;    // chunks successfully sent during stream
  streamPulse: boolean;     // true briefly when a chunk is sent (triggers animation)
}

export interface CreateSessionParams {
  title: string;
  session_type: KnowledgeSessionType;
  subject: string;
  agenda: string;
  participants: string[];
  location_label: string | null;
}

export interface RecorderApiContract {
  createRemoteSession(session: LocalKnowledgeSession): Promise<string>;
  uploadChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void>;
  finalizeSession(sessionId: string, manifest: OfflineManifest): Promise<void>;
}
