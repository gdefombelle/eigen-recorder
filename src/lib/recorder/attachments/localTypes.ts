// Local (on-device) representation of an attachment, persisted in IndexedDB
// (offlineStorage: attachments_meta + attachments_data).

import type { AttachmentKind, ServerAttachmentStatus, AttachmentErrorKind } from './types';

/**
 *   queued     waiting to be sent (no network, no backend session yet, or backing off)
 *   uploading  a request is in flight (a persisted 'uploading' found at startup means the app died mid-upload)
 *   uploaded   the server has it — see server_status for its own processing lifecycle
 *   failed     permanent error: manual retry only
 *   abandoned  the session was cancelled server-side: never sent, the user has been told
 */
export type LocalAttachmentState = 'queued' | 'uploading' | 'uploaded' | 'failed' | 'abandoned';

export interface LocalAttachment {
  /** Also the server's client_attachment_id — generated once, reused on every retry. */
  local_attachment_id:  string;
  local_session_id:     string;
  kind:                 AttachmentKind;
  filename:             string;
  mime_type:            string;
  size_bytes:           number;
  /** SHA-256 of the exact bytes stored/sent. */
  sha256:               string;
  title:                string;
  /** Audio-timeline position, pauses excluded. */
  start_offset_ms:      number;
  end_offset_ms:        number | null;
  created_at:           string;

  state:                LocalAttachmentState;
  server_attachment_id: string | null;
  server_status:        ServerAttachmentStatus | null;
  attempts:             number;
  /** Epoch ms before which an automatic retry must not happen. */
  next_attempt_at:      number | null;
  last_error:           { kind: AttachmentErrorKind; status: number; message: string } | null;
  /** True once a request carrying this UUID has left the device — the server may hold a copy even if we never saw the answer. */
  upload_started:       boolean;
  /** User deleted it while a server copy might exist; the queue must DELETE before dropping the row. */
  pending_delete:       boolean;
  /** Title edited locally after the server stored it; PATCH still owed. */
  title_dirty:          boolean;
}

export interface LocalAttachmentData {
  local_attachment_id: string;
  blob:                Blob;
}
