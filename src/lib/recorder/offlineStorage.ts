import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  LocalKnowledgeSession,
  AudioChunkMetadata,
  AudioChunkData,
  AudioChunkStatus,
  OfflineManifest,
} from './types';

interface EigenMeetingDB extends DBSchema {
  sessions: {
    key: string;
    value: LocalKnowledgeSession;
    indexes: { 'by-status': string };
  };
  chunks_meta: {
    key: string;
    value: AudioChunkMetadata;
    indexes: { 'by-session': string };
  };
  chunks_data: {
    key: string;
    value: AudioChunkData;
  };
}

const DB_NAME    = 'eigen-recorder';
const DB_VERSION = 1;

// The connection is cached as a PROMISE, not a resolved handle, so concurrent
// first callers share one openDB() instead of each opening their own.
let _dbPromise: Promise<IDBPDatabase<EigenMeetingDB>> | null = null;
let _reopenCount = 0;

/** How many times a dead connection was replaced this app session (diagnostics). */
export function dbReopenCount(): number { return _reopenCount; }

function openConnection(): Promise<IDBPDatabase<EigenMeetingDB>> {
  return openDB<EigenMeetingDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'local_session_id' });
      sessions.createIndex('by-status', 'status');

      const meta = db.createObjectStore('chunks_meta', { keyPath: 'local_chunk_id' });
      meta.createIndex('by-session', 'local_session_id');

      db.createObjectStore('chunks_data', { keyPath: 'local_chunk_id' });
    },
    blocked() {
      console.warn('[EigenMeeting] IndexedDB blocked — another tab may have an older version open.');
    },
    blocking() {
      dropConnection();
    },
    // The browser closed the connection on its own — on iOS, WebKit does this
    // when the app has been suspended for a while. Without this the cached
    // handle stays dead and every later access throws until a full app restart.
    terminated() {
      _dbPromise = null;
    },
  });
}

function getDb(): Promise<IDBPDatabase<EigenMeetingDB>> {
  if (!_dbPromise) {
    _dbPromise = openConnection().catch((e) => {
      _dbPromise = null; // a failed open must not poison every later call
      throw e;
    });
  }
  return _dbPromise;
}

function dropConnection(): void {
  const stale = _dbPromise;
  _dbPromise = null;
  stale?.then((db) => db.close()).catch(() => { /* already gone */ });
}

/**
 * WebKit reports a connection it has closed as InvalidStateError ("The database
 * connection is closing") — and it does not reliably fire the `close` event
 * first, so terminated() alone can't be trusted to have cleared the cache.
 */
function isStaleConnection(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return err?.name === 'InvalidStateError'
    || /database connection is closing/i.test(err?.message ?? '');
}

/**
 * Run a database operation, reopening the connection once if the browser has
 * closed it underneath us.
 *
 * Retrying is safe: this error is raised when the transaction cannot even be
 * created, so nothing has been written yet. That matters for saveChunk() —
 * losing recorded audio to a dead handle is the failure worth guarding.
 * Any other error is thrown as-is.
 */
async function withDb<T>(run: (db: IDBPDatabase<EigenMeetingDB>) => Promise<T>): Promise<T> {
  try {
    return await run(await getDb());
  } catch (e) {
    if (!isStaleConnection(e)) throw e;
    console.warn('[EigenMeeting] IndexedDB connection was closed by the OS — reopening.');
    _reopenCount++;
    dropConnection();
    return await run(await getDb());
  }
}

export const offlineStorage = {
  // ── Sessions ──────────────────────────────────────────────

  async saveSession(session: LocalKnowledgeSession): Promise<void> {
    await withDb((db) => db.put('sessions', session));
  },

  async getSession(id: string): Promise<LocalKnowledgeSession | undefined> {
    return withDb((db) => db.get('sessions', id));
  },

  async getAllSessions(): Promise<LocalKnowledgeSession[]> {
    const sessions = await withDb((db) => db.getAll('sessions'));
    return sessions.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  },

  async deleteSession(sessionId: string): Promise<void> {
    const chunks = await this.getChunksMeta(sessionId);

    await withDb(async (db) => {
      const tx = db.transaction(['sessions', 'chunks_meta', 'chunks_data'], 'readwrite');
      await tx.objectStore('sessions').delete(sessionId);
      for (const c of chunks) {
        await tx.objectStore('chunks_meta').delete(c.local_chunk_id);
        await tx.objectStore('chunks_data').delete(c.local_chunk_id);
      }
      await tx.done;
    });
  },

  /**
   * Purge audio blobs for a session — frees storage while keeping session metadata,
   * chunk metadata, and transport history intact.
   *
   * Per D-02: audio deletion is always explicit and user-initiated. This method
   * deletes only chunks_data (blobs); chunks_meta rows are preserved for audit.
   * `getChunkBlob` will return undefined after purge — callers must handle that.
   */
  async purgeAudio(sessionId: string): Promise<void> {
    const chunks = await this.getChunksMeta(sessionId);
    await withDb(async (db) => {
      const tx = db.transaction(['chunks_data'], 'readwrite');
      for (const c of chunks) {
        await tx.objectStore('chunks_data').delete(c.local_chunk_id);
      }
      await tx.done;
    });
  },

  // ── Chunks ────────────────────────────────────────────────

  async saveChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void> {
    await withDb(async (db) => {
      const tx = db.transaction(['chunks_meta', 'chunks_data'], 'readwrite');
      await tx.objectStore('chunks_meta').put(meta);
      await tx.objectStore('chunks_data').put({ local_chunk_id: meta.local_chunk_id, blob });
      await tx.done;
    });
  },

  async getChunksMeta(sessionId: string): Promise<AudioChunkMetadata[]> {
    const chunks = await withDb((db) => db.getAllFromIndex('chunks_meta', 'by-session', sessionId));
    return chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  },

  async getChunkBlob(chunkId: string): Promise<Blob | undefined> {
    const data = await withDb((db) => db.get('chunks_data', chunkId));
    return data?.blob;
  },

  async updateChunkStatus(
    chunkId: string,
    status: AudioChunkStatus,
    uploadedAt?: string
  ): Promise<void> {
    await withDb(async (db) => {
      const chunk = await db.get('chunks_meta', chunkId);
      if (chunk) {
        await db.put('chunks_meta', {
          ...chunk,
          status,
          uploaded_at: uploadedAt ?? null,
        });
      }
    });
  },

  // ── Storage stats ─────────────────────────────────────────

  async getSessionStats(sessionId: string): Promise<{ chunkCount: number; totalBytes: number }> {
    const chunks = await this.getChunksMeta(sessionId);
    return {
      chunkCount: chunks.length,
      totalBytes: chunks.reduce((acc, c) => acc + c.size_bytes, 0),
    };
  },

  async getTotalStorageBytes(): Promise<number> {
    const all = await withDb((db) => db.getAll('chunks_meta'));
    return all.reduce((acc, c) => acc + c.size_bytes, 0);
  },

  // ── Manifest ──────────────────────────────────────────────

  async generateManifest(sessionId: string): Promise<OfflineManifest | null> {
    const session = await this.getSession(sessionId);
    if (!session) return null;

    const chunks = await this.getChunksMeta(sessionId);

    return {
      local_session_id:  session.local_session_id,
      remote_session_id: session.remote_session_id,
      title:             session.title,
      session_type:      session.session_type,
      started_at:        session.started_at ?? session.created_at,
      ended_at:          session.ended_at   ?? new Date().toISOString(),
      duration_ms:       session.duration_ms,
      chunks: chunks.map((c) => ({
        chunk_index: c.chunk_index,
        start_ms:    c.start_ms,
        end_ms:      c.end_ms,
        mime_type:   c.mime_type,
        size_bytes:  c.size_bytes,
        sha256:      c.sha256,
      })),
      metadata: session.metadata,
    };
  },
};
