// attachmentQueue — persistent, retrying upload queue for record attachments.
//
// Everything needed to (re)send an attachment is persisted at add() time — file,
// UUID, offset, title — so the queue survives going offline and app restarts.
// Nothing here runs in the background on iOS: the queue works while the app is
// open and resumes on start(), on reconnection and after the audio share.
//
// Rules (agreed with the product owner):
//  • Retry with backoff ONLY for network failures, 5xx and 429. Any other
//    error is a final "failed" state with a manual Retry button — no loop.
//  • "Local only" mode: the backend session does not exist yet when the user adds
//    a photo offline. The queue never stores a server id: it looks it up
//    (knowledge_session_id) on every attempt, so items simply wait until sharing
//    the audio creates the session, then leave with the right id.
//  • A closed session accepts uploads. A cancelled one answers 409
//    session_cancelled: the session's unsent items are abandoned and the user is told.
//  • Delete: unsent → dropped locally; on the server → DELETE; mid-upload → abort,
//    then DELETE by client_attachment_id in case the server created it anyway.
//  • One UUID per file, reused on every retry (the server dedups on it).

import { offlineStorage } from '../offlineStorage';
import { AttachmentTooLargeError, classifyAttachmentError, getAttachmentApi } from './attachmentApi';
import {
  MAX_ATTACHMENT_BYTES,
  type AttachmentApiContract,
  type AttachmentKind,
  type ClassifiedAttachmentError,
} from './types';
import type { LocalAttachment } from './localTypes';

// ── Dependencies (injected so the queue is testable without IndexedDB or network) ──

export interface AttachmentStorage {
  putAttachment(meta: LocalAttachment, blob?: Blob): Promise<void>;
  getAttachment(id: string): Promise<LocalAttachment | undefined>;
  getAttachmentsBySession(localSessionId: string): Promise<LocalAttachment[]>;
  getAllAttachments(): Promise<LocalAttachment[]>;
  getAttachmentBlob(id: string): Promise<Blob | undefined>;
  deleteAttachment(id: string): Promise<void>;
}

export interface QueueDeps {
  storage:            AttachmentStorage;
  getApi:             () => Promise<AttachmentApiContract>;
  /** Backend id of the record's session, or null while it only exists locally. */
  getRemoteSessionId: (localSessionId: string) => Promise<string | null>;
  isOnline:           () => boolean;
  now:                () => number;
  uuid:               () => string;
  random:             () => number;
  setTimer:           (fn: () => void, ms: number) => unknown;
  clearTimer:         (handle: unknown) => void;
  subscribeOnline?:   (onChange: (online: boolean) => void) => () => void;
}

export type AttachmentQueueEvent =
  | { type: 'changed';           localSessionId: string }
  | { type: 'progress';          id: string; fraction: number }
  | { type: 'session_cancelled'; localSessionId: string; abandoned: number }
  | { type: 'delete_failed';     id: string; message: string };

export interface AddAttachmentInput {
  localSessionId: string;
  /** Final bytes to send (photos already resized/encoded by imagePrep). */
  file:           Blob;
  filename:       string;
  mimeType?:      string;
  kind:           AttachmentKind;
  startOffsetMs:  number;
  endOffsetMs?:   number | null;
  sha256:         string;
  title:          string;
}

// ── Backoff ────────────────────────────────────────────────────────────────

export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS  = 300_000;

/** Exponential 2 s, 4 s, 8 s … capped at 5 min, ±20 % jitter. `attempts` is the number of failures so far (≥ 1). */
export function backoffDelayMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS);
  return Math.round(exp * (0.8 + 0.4 * random()));
}

// ── Queue ──────────────────────────────────────────────────────────────────

export function createAttachmentQueue(deps: QueueDeps) {
  const { storage } = deps;
  const listeners = new Set<(e: AttachmentQueueEvent) => void>();
  const inflight = new Map<string, AbortController>();
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: unknown = null;
  let unsubscribeOnline: (() => void) | null = null;

  const emit = (e: AttachmentQueueEvent) => { for (const l of listeners) l(e); };

  async function patch(id: string, changes: Partial<LocalAttachment>): Promise<LocalAttachment | undefined> {
    const cur = await storage.getAttachment(id);
    if (!cur) return undefined;
    const next = { ...cur, ...changes };
    await storage.putAttachment(next);
    emit({ type: 'changed', localSessionId: next.local_session_id });
    return next;
  }

  async function dropLocal(att: LocalAttachment): Promise<void> {
    await storage.deleteAttachment(att.local_attachment_id);
    emit({ type: 'changed', localSessionId: att.local_session_id });
  }

  const failure = (c: ClassifiedAttachmentError) => ({ kind: c.kind, status: c.status, message: c.message });

  function backoffPatch(att: LocalAttachment, c: ClassifiedAttachmentError): Partial<LocalAttachment> {
    const attempts = att.attempts + 1;
    return {
      attempts,
      next_attempt_at: deps.now() + backoffDelayMs(attempts, deps.random),
      last_error: failure(c),
    };
  }

  async function abandonSession(localSessionId: string): Promise<void> {
    let abandoned = 0;
    for (const a of await storage.getAttachmentsBySession(localSessionId)) {
      if (a.pending_delete) { await dropLocal(a); continue; }
      if (a.state === 'uploaded' || a.state === 'abandoned') continue;
      await patch(a.local_attachment_id, { state: 'abandoned', next_attempt_at: null });
      abandoned++;
    }
    emit({ type: 'session_cancelled', localSessionId, abandoned });
  }

  async function processDelete(att: LocalAttachment): Promise<void> {
    const remote = await deps.getRemoteSessionId(att.local_session_id);
    // No backend session ⇒ no request can have carried this UUID: nothing to delete remotely.
    if (!remote) { await dropLocal(att); return; }
    try {
      const api = await deps.getApi();
      await api.remove(remote, att.server_attachment_id ?? att.local_attachment_id);
      await dropLocal(att);
    } catch (e) {
      const c = classifyAttachmentError(e);
      if (c.kind === 'transient') {
        await patch(att.local_attachment_id, backoffPatch(att, c));
      } else if (c.status === 404 || c.kind === 'session_cancelled') {
        await dropLocal(att);            // never created, already gone, or session cancelled: nothing more to do
      } else {
        await dropLocal(att);            // cannot be deleted remotely; don't leave an undeletable ghost on screen
        emit({ type: 'delete_failed', id: att.local_attachment_id, message: c.message });
      }
    }
  }

  async function processTitle(att: LocalAttachment): Promise<void> {
    const remote = await deps.getRemoteSessionId(att.local_session_id);
    if (!remote || !att.server_attachment_id) return;
    const sent = att.title;
    try {
      const api = await deps.getApi();
      await api.update(remote, att.server_attachment_id, { title: sent });
      const fresh = await storage.getAttachment(att.local_attachment_id);
      await patch(att.local_attachment_id, { title_dirty: fresh?.title !== sent, attempts: 0, next_attempt_at: null });
    } catch (e) {
      const c = classifyAttachmentError(e);
      if (c.kind === 'transient') await patch(att.local_attachment_id, backoffPatch(att, c));
      else await patch(att.local_attachment_id, { title_dirty: false, last_error: failure(c) });
    }
  }

  async function processUpload(att: LocalAttachment): Promise<void> {
    const id = att.local_attachment_id;
    const remote = await deps.getRemoteSessionId(att.local_session_id);
    if (!remote) return;                 // "Local only": waits for the audio share to create the session

    const blob = await storage.getAttachmentBlob(id);
    if (!blob) {
      await patch(id, { state: 'failed', last_error: { kind: 'permanent', status: 0, message: 'Local file missing' } });
      return;
    }

    const controller = new AbortController();
    inflight.set(id, controller);
    await patch(id, { state: 'uploading', upload_started: true });
    try {
      const api = await deps.getApi();
      const rec = await api.upload(
        {
          sessionId: remote, file: blob, filename: att.filename, clientAttachmentId: id,
          startOffsetMs: att.start_offset_ms, endOffsetMs: att.end_offset_ms,
          sha256: att.sha256, title: att.title,
        },
        { signal: controller.signal, onProgress: (fraction) => emit({ type: 'progress', id, fraction }) },
      );
      const fresh = await storage.getAttachment(id);
      await patch(id, {
        state: 'uploaded',
        server_attachment_id: rec.attachment_id,
        server_status: rec.status,
        attempts: 0, next_attempt_at: null, last_error: null,
        // the user may have renamed it while it was in flight
        title_dirty: !!fresh && fresh.title !== att.title,
      });
    } catch (e) {
      const c = classifyAttachmentError(e);
      if (c.kind === 'aborted') await patch(id, { state: 'queued' });
      else if (c.kind === 'transient') await patch(id, { state: 'queued', ...backoffPatch(att, c) });
      else if (c.kind === 'session_cancelled') await abandonSession(att.local_session_id);
      else await patch(id, { state: 'failed', last_error: failure(c) });
    } finally {
      inflight.delete(id);
    }
    // A delete requested while in flight is left to the next pass (remove() already
    // asked for one): the server may or may not have created it, and DELETE settles it.
  }

  async function pass(): Promise<void> {
    for (const row of await storage.getAllAttachments()) {
      if (!deps.isOnline()) return;
      const att = await storage.getAttachment(row.local_attachment_id);
      if (!att) continue;
      const due = (att.next_attempt_at ?? 0) <= deps.now();
      if (att.pending_delete) { if (due) await processDelete(att); continue; }
      if (att.state === 'uploading' && !inflight.has(att.local_attachment_id)) {
        await patch(att.local_attachment_id, { state: 'queued' });   // left over from a killed app
        if (due) await processUpload({ ...att, state: 'queued' });
        continue;
      }
      if (att.state === 'queued' && due) await processUpload(att);
      else if (att.state === 'uploaded' && att.title_dirty && due) await processTitle(att);
    }
  }

  async function scheduleNext(): Promise<void> {
    if (timer !== null) { deps.clearTimer(timer); timer = null; }
    if (!deps.isOnline()) return;       // the online event re-kicks
    const now = deps.now();
    let soonest: number | null = null;
    for (const a of await storage.getAllAttachments()) {
      const waiting = a.pending_delete || a.state === 'queued' || (a.state === 'uploaded' && a.title_dirty);
      if (waiting && a.next_attempt_at !== null && a.next_attempt_at > now) {
        soonest = soonest === null ? a.next_attempt_at : Math.min(soonest, a.next_attempt_at);
      }
    }
    if (soonest !== null) timer = deps.setTimer(() => { timer = null; void kick(); }, soonest - now);
  }

  /** Run a pass now (single-flight). Calls made during a pass trigger one more pass afterwards. */
  function kick(): Promise<void> {
    if (running) { rerun = true; return running; }
    running = (async () => {
      try {
        do { rerun = false; await pass(); } while (rerun);
      } finally {
        running = null;
      }
      await scheduleNext();
    })();
    return running;
  }

  return {
    subscribe(fn: (e: AttachmentQueueEvent) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Persist then queue. Resolves once the file is safely stored — upload happens later. */
    async add(input: AddAttachmentInput): Promise<LocalAttachment> {
      if (input.file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(input.file.size);
      const att: LocalAttachment = {
        local_attachment_id: deps.uuid(),
        local_session_id:    input.localSessionId,
        kind:                input.kind,
        filename:            input.filename,
        mime_type:           input.mimeType ?? (input.file.type || 'application/octet-stream'),
        size_bytes:          input.file.size,
        sha256:              input.sha256,
        title:               input.title,
        start_offset_ms:     Math.max(0, Math.round(input.startOffsetMs)),
        end_offset_ms:       input.endOffsetMs == null ? null : Math.round(input.endOffsetMs),
        created_at:          new Date(deps.now()).toISOString(),
        state:               'queued',
        server_attachment_id: null,
        server_status:       null,
        attempts:            0,
        next_attempt_at:     null,
        last_error:          null,
        upload_started:      false,
        pending_delete:      false,
        title_dirty:         false,
      };
      await storage.putAttachment(att, input.file);
      emit({ type: 'changed', localSessionId: att.local_session_id });
      void kick();
      return att;
    },

    /** Multi-selection: one UUID per file, same offset. */
    async addMany(common: Omit<AddAttachmentInput, 'file' | 'filename' | 'sha256' | 'title'>,
                  files: Array<Pick<AddAttachmentInput, 'file' | 'filename' | 'sha256' | 'title'>>): Promise<LocalAttachment[]> {
      const out: LocalAttachment[] = [];
      for (const f of files) out.push(await this.add({ ...common, ...f }));
      return out;
    },

    async remove(id: string): Promise<void> {
      const att = await storage.getAttachment(id);
      if (!att) return;
      if (!att.server_attachment_id && !att.upload_started) { await dropLocal(att); return; }
      await patch(id, { pending_delete: true, next_attempt_at: null });
      inflight.get(id)?.abort();
      void kick();
    },

    async rename(id: string, title: string): Promise<void> {
      const att = await storage.getAttachment(id);
      if (!att) return;
      await patch(id, { title, title_dirty: !!att.server_attachment_id || att.state === 'uploading' });
      void kick();
    },

    /**
     * Manual "Retry". On the server with status failed → POST /retry (server-side re-ingestion);
     * otherwise the full file is sent again with the same UUID.
     */
    async retry(id: string): Promise<void> {
      const att = await storage.getAttachment(id);
      if (!att || att.pending_delete || att.state === 'abandoned') return;
      const remote = await deps.getRemoteSessionId(att.local_session_id);
      if (att.server_attachment_id && att.server_status === 'failed' && remote) {
        try {
          const rec = await (await deps.getApi()).retry(remote, att.server_attachment_id);
          await patch(id, { server_status: rec.status, last_error: null });
        } catch (e) {
          await patch(id, { last_error: failure(classifyAttachmentError(e)) });
        }
        return;
      }
      if (att.state === 'queued' || att.state === 'failed') {
        await patch(id, { state: 'queued', attempts: 0, next_attempt_at: null, last_error: null });
        void kick();
      }
    },

    /**
     * The end-of-record "Retry" button: re-send every failed attachment of the record and skip the
     * backoff wait of queued ones (the user is looking at the screen — a retry NOW is what they asked for).
     */
    async retryAll(localSessionId: string): Promise<void> {
      for (const a of await storage.getAttachmentsBySession(localSessionId)) {
        if (a.pending_delete || a.state === 'abandoned') continue;
        if (a.state === 'failed' || (a.state === 'uploaded' && a.server_status === 'failed')) await this.retry(a.local_attachment_id);
        else if (a.state === 'queued' && a.next_attempt_at !== null) await patch(a.local_attachment_id, { next_attempt_at: null });
      }
      await kick();
    },

    /** Pull server-side statuses (processing → ready/failed) for a record's attachments. Best effort. */
    async refreshStatuses(localSessionId: string): Promise<void> {
      const remote = await deps.getRemoteSessionId(localSessionId);
      if (!remote || !deps.isOnline()) return;
      try {
        const list = await (await deps.getApi()).list(remote);
        for (const a of await storage.getAttachmentsBySession(localSessionId)) {
          const s = list.find((r) => r.client_attachment_id === a.local_attachment_id);
          if (s && a.state === 'uploaded' && s.status !== a.server_status) {
            await patch(a.local_attachment_id, { server_status: s.status, server_attachment_id: s.attachment_id });
          }
        }
      } catch { /* status is cosmetic; the next refresh will catch up */ }
    },

    /** App (re)start: an 'uploading' row with no request in flight means the app died mid-upload. */
    async recover(): Promise<void> {
      for (const a of await storage.getAllAttachments()) {
        if (a.state === 'uploading' && !inflight.has(a.local_attachment_id)) {
          await patch(a.local_attachment_id, { state: 'queued' });
        }
      }
    },

    async start(): Promise<void> {
      await this.recover();
      unsubscribeOnline?.();
      unsubscribeOnline = deps.subscribeOnline?.((online) => { if (online) void kick(); }) ?? null;
      void kick();
    },

    stop(): void {
      unsubscribeOnline?.(); unsubscribeOnline = null;
      if (timer !== null) { deps.clearTimer(timer); timer = null; }
    },

    kick,
    /** Resolves when the current pass (if any) is finished. */
    whenIdle(): Promise<void> { return running ?? Promise.resolve(); },
  };
}

// ── App singleton ──────────────────────────────────────────────────────────

export const attachmentQueue = createAttachmentQueue({
  storage: offlineStorage,
  getApi: getAttachmentApi,
  getRemoteSessionId: async (localSessionId) =>
    (await offlineStorage.getSession(localSessionId))?.knowledge_session_id ?? null,
  // navigator.onLine directly: the networkStatus store is never init()-ed, so it would stay frozen at its boot value.
  isOnline:   () => typeof navigator === 'undefined' || navigator.onLine,
  now:        () => Date.now(),
  uuid:       () => crypto.randomUUID(),
  random:     () => Math.random(),
  setTimer:   (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  subscribeOnline: (cb) => {
    if (typeof window === 'undefined') return () => {};
    const on = () => cb(true), off = () => cb(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  },
});
