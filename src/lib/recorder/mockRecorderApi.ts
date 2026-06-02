import { BaseRecorderApi } from './recorderApi';
import type { LocalKnowledgeSession, AudioChunkMetadata, OfflineManifest } from './types';

// Mock API — simulates backend round-trips for UX testing.
// Replace with real HTTP implementation when the backend is ready.
// Keep the same interface contract.

const FAKE_LATENCY_MS = 400;

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

export class MockRecorderApi extends BaseRecorderApi {
  async createRemoteSession(session: LocalKnowledgeSession): Promise<string> {
    await sleep(FAKE_LATENCY_MS);
    return `mock_remote_${session.local_session_id.slice(0, 8)}`;
  }

  async uploadChunk(meta: AudioChunkMetadata, _blob: Blob): Promise<void> {
    // Simulate per-chunk upload with variable latency based on size
    const latency = Math.min(50 + Math.floor(meta.size_bytes / 20000) * 10, 500);
    await sleep(latency);
  }

  async finalizeSession(_sessionId: string, _manifest: OfflineManifest): Promise<void> {
    await sleep(FAKE_LATENCY_MS);
  }
}

export const mockRecorderApi = new MockRecorderApi();
