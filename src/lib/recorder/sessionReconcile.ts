// sessionReconcile — has the server already ended this record?
//
// Server lifecycle (eigenvertex KnowledgeSessionStatus): draft, ready, recording, paused, processing_live,
// processing_offline, completed, cancelled, closed. The device stop queues finalization in the background:
// the session sets `ended_at` and ends in `completed`. `processing_live` ALSO exists while a record is live,
// so only `ended_at` proves that the end was received.

import type { KnowledgeSessionServerState } from './knowledgeSessionApi';

/** At most this many sessions are checked per run (the most recent first). */
export const RECONCILE_MAX_SESSIONS = 20;
/** A session checked less than this long ago is not asked about again (opening Sessions repeatedly must not hammer the server). */
export const RECONCILE_MIN_INTERVAL_MS = 60_000;
export const RECONCILE_CONCURRENCY = 3;

export function isEndedOnServer(state: KnowledgeSessionServerState): boolean {
  switch (state.status) {
    case 'completed':
    case 'closed':
      return true;
    case 'processing_live':
    case 'processing_offline':
      return state.ended_at !== null;     // finalization may still be running — the end itself was received
    default:
      return false;                        // draft, ready, recording, paused, and cancelled (never "sent")
  }
}
