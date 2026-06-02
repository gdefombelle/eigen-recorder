import type { RecorderApiContract, LocalKnowledgeSession, AudioChunkMetadata, OfflineManifest } from './types';

// Abstract contract — swap MockRecorderApi for real implementation when backend is ready.
export type { RecorderApiContract };

export abstract class BaseRecorderApi implements RecorderApiContract {
  abstract createRemoteSession(session: LocalKnowledgeSession): Promise<string>;
  abstract uploadChunk(meta: AudioChunkMetadata, blob: Blob): Promise<void>;
  abstract finalizeSession(sessionId: string, manifest: OfflineManifest): Promise<void>;
}
