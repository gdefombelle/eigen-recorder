import { offlineStorage } from './offlineStorage';
import type { RecorderApiContract, AudioChunkMetadata } from './types';
import { writable, get } from 'svelte/store';

export interface QueueStats {
  pending:    number;
  uploading:  number;
  uploaded:   number;
  failed:     number;
}

export const queueStats = writable<QueueStats>({
  pending: 0, uploading: 0, uploaded: 0, failed: 0,
});

let _api: RecorderApiContract | null = null;
let _running = false;
let _queue: AudioChunkMetadata[] = [];

export const chunkQueue = {
  init(api: RecorderApiContract) {
    _api = api;
  },

  enqueue(meta: AudioChunkMetadata) {
    _queue.push(meta);
    this._updateStats();
    if (!_running) this._drain();
  },

  enqueueAll(metas: AudioChunkMetadata[]) {
    _queue.push(...metas);
    this._updateStats();
    if (!_running) this._drain();
  },

  async _drain() {
    if (!_api || _running) return;
    _running = true;

    while (_queue.length > 0) {
      const meta = _queue.shift()!;

      queueStats.update((s) => ({ ...s, uploading: s.uploading + 1 }));

      try {
        const blob = await offlineStorage.getChunkBlob(meta.local_chunk_id);
        if (!blob) throw new Error(`Blob missing for chunk ${meta.local_chunk_id}`);

        await _api.uploadChunk(meta, blob);
        await offlineStorage.updateChunkStatus(
          meta.local_chunk_id,
          'uploaded',
          new Date().toISOString()
        );

        queueStats.update((s) => ({
          ...s,
          uploading: s.uploading - 1,
          uploaded:  s.uploaded + 1,
        }));
      } catch {
        await offlineStorage.updateChunkStatus(meta.local_chunk_id, 'error');
        queueStats.update((s) => ({
          ...s,
          uploading: s.uploading - 1,
          failed:    s.failed + 1,
        }));
      }
    }

    _running = false;
  },

  _updateStats() {
    const stats = get(queueStats);
    queueStats.set({ ...stats, pending: _queue.length });
  },

  reset() {
    _queue = [];
    queueStats.set({ pending: 0, uploading: 0, uploaded: 0, failed: 0 });
  },
};
