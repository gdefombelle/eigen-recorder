import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type {
  LocalKnowledgeSession,
  AudioChunkMetadata,
  AudioChunkData,
  AudioChunkStatus,
  OfflineManifest,
} from './types';

interface EigenRecorderDB extends DBSchema {
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

let _db: IDBPDatabase<EigenRecorderDB> | null = null;

async function getDb(): Promise<IDBPDatabase<EigenRecorderDB>> {
  if (_db) return _db;

  _db = await openDB<EigenRecorderDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'local_session_id' });
      sessions.createIndex('by-status', 'status');

      const meta = db.createObjectStore('chunks_meta', { keyPath: 'local_chunk_id' });
      meta.createIndex('by-session', 'local_session_id');

      db.createObjectStore('chunks_data', { keyPath: 'local_chunk_id' });
    },
    blocked() {
      console.warn('[EigenRecorder] IndexedDB blocked — another tab may have an older version open.');
    },
    blocking() {
      _db?.close();
      _db = null;
    },
  });

  return _db;
}

export const offlineStorage = {
  // ── Sessions ──────────────────────────────────────────────

  async saveSession(session: LocalKnowledgeSession): Promise<void> {
    const db = await getDb();
    await db.put('sessions', session);
  },

  async getSession(id: string): Promise<LocalKnowledgeSession | undefined> {
    const db = await getDb();
    return db.get('sessions', id);
  },

  async getAllSessions(): Promise<LocalKnowledgeSession[]> {
    const db = await getDb();
    const sessions = await db.getAll('sessions');
    return sessions.sort(
      (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  },

  async deleteSession(sessionId: string): Promise<void> {
    const db = await getDb();
    const chunks = await this.getChunksMeta(sessionId);

    const tx = db.transaction(['sessions', 'chunks_meta', 'chunks_data'], 'readwrite');
    await tx.objectStore('sessions').delete(sessionId);
    for (const c of chunks) {
      await tx.objectStore('chunks_meta').delete(c.local_chunk_id);
      await tx.objectStore('chunks_data').delete(c.local_chunk_id);
    }
    await tx.done;
  },

  // ── Chunks ────────────────────────────────────────────────

  async saveChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(['chunks_meta', 'chunks_data'], 'readwrite');
    await tx.objectStore('chunks_meta').put(meta);
    await tx.objectStore('chunks_data').put({ local_chunk_id: meta.local_chunk_id, blob });
    await tx.done;
  },

  async getChunksMeta(sessionId: string): Promise<AudioChunkMetadata[]> {
    const db = await getDb();
    const chunks = await db.getAllFromIndex('chunks_meta', 'by-session', sessionId);
    return chunks.sort((a, b) => a.chunk_index - b.chunk_index);
  },

  async getChunkBlob(chunkId: string): Promise<Blob | undefined> {
    const db = await getDb();
    const data = await db.get('chunks_data', chunkId);
    return data?.blob;
  },

  async updateChunkStatus(
    chunkId: string,
    status: AudioChunkStatus,
    uploadedAt?: string
  ): Promise<void> {
    const db = await getDb();
    const chunk = await db.get('chunks_meta', chunkId);
    if (chunk) {
      await db.put('chunks_meta', {
        ...chunk,
        status,
        uploaded_at: uploadedAt ?? null,
      });
    }
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
    const db = await getDb();
    const all = await db.getAll('chunks_meta');
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
