// attachmentStore — a readable list of one record's attachments, kept in sync with the queue.

import { readable, type Readable } from 'svelte/store';
import { offlineStorage } from '../offlineStorage';
import { attachmentQueue } from './attachmentQueue';
import { visibleViews, type AttachmentView } from './attachmentView';
import type { LocalAttachment } from './localTypes';

const STATUS_POLL_MS = 5_000;

/**
 * Subscribing loads the record's attachments and keeps them fresh: persisted
 * changes from the queue reload the list, upload progress only re-maps it (no
 * storage read per tick), and while something is still being processed
 * server-side the server status is polled.
 */
export function attachmentsFor(localSessionId: string): Readable<AttachmentView[]> {
  return readable<AttachmentView[]>([], (set) => {
    let rows: LocalAttachment[] = [];
    let hasRemote = false;
    let online = typeof navigator === 'undefined' || navigator.onLine;
    const progress = new Map<string, number>();
    let disposed = false;

    const emit = () => {
      if (disposed) return;
      set(visibleViews(rows, (a) => ({ progress: progress.get(a.local_attachment_id), hasRemoteSession: hasRemote, online })));
    };

    const reload = async () => {
      const [list, session] = await Promise.all([
        offlineStorage.getAttachmentsBySession(localSessionId),
        offlineStorage.getSession(localSessionId),
      ]);
      rows = list;
      hasRemote = !!session?.knowledge_session_id;
      for (const id of [...progress.keys()]) if (!rows.some((r) => r.local_attachment_id === id && r.state === 'uploading')) progress.delete(id);
      emit();
    };

    void reload().catch(() => { /* an unreadable DB shows an empty strip rather than breaking the screen */ });

    const unsub = attachmentQueue.subscribe((e) => {
      if (e.type === 'changed' && e.localSessionId === localSessionId) void reload().catch(() => {});
      else if (e.type === 'progress') { progress.set(e.id, e.fraction); emit(); }
    });

    const setOnline = (v: boolean) => () => { online = v; emit(); };
    const goOnline = setOnline(true), goOffline = setOnline(false);
    if (typeof window !== 'undefined') {
      window.addEventListener('online', goOnline);
      window.addEventListener('offline', goOffline);
    }

    const poll = setInterval(() => {
      if (rows.some((r) => r.state === 'uploaded' && r.server_status === 'processing')) {
        void attachmentQueue.refreshStatuses(localSessionId);
      }
    }, STATUS_POLL_MS);

    return () => {
      disposed = true; unsub(); clearInterval(poll);
      if (typeof window !== 'undefined') { window.removeEventListener('online', goOnline); window.removeEventListener('offline', goOffline); }
    };
  });
}
