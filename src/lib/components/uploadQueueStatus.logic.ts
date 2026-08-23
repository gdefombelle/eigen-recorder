/**
 * Pure logic extracted from UploadQueueStatus.svelte for unit testing.
 *
 * The Svelte component uses $derived to compute these values at runtime;
 * this file re-exposes the same derivations as plain functions so tests
 * can run without a browser or Svelte runtime.
 */

import type { AudioChunkMetadata } from '$lib/recorder/types';

export interface UploadQueueDerived {
  /** Chunks that were actually meant for /audio-chunks (excludes backup_only). */
  realChunks:  AudioChunkMetadata[];
  /** Count of realChunks with status 'uploaded'. */
  uploaded:    number;
  /** Count of realChunks with status 'saved' (awaiting upload). */
  pending:     number;
  /**
   * True when the session is confirmed synced to EigenVertex:
   * - 'synced'      → POST /stop returned 2xx in stream mode
   * - 'mock_synced' → offline flush completed
   */
  isSynced:    boolean;
  isUploading: boolean;
}

export function deriveUploadQueue(
  chunks: AudioChunkMetadata[],
  state:  string,
): UploadQueueDerived {
  const realChunks  = chunks.filter((c) => c.status !== 'backup_only');
  const uploaded    = realChunks.filter((c) => c.status === 'uploaded').length;
  const pending     = realChunks.filter((c) => c.status === 'saved').length;
  const isSynced    = state === 'mock_synced' || state === 'synced';
  const isUploading = state === 'mock_uploading';
  return { realChunks, uploaded, pending, isSynced, isUploading };
}
