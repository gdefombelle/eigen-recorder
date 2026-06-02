// NativeAudioRecorder — wraps EigenAudioPlugin (Capacitor) with the same interface
// as the web AudioRecorder, so recorderStore.ts routes transparently.
//
// Key differences vs web:
//   • Chunks arrive as file:// URIs after stopRecording() (not during via ondataavailable)
//   • Levels and elapsed are polled async; synchronous getters return last cached value
//   • Stereo is real (two physical mics via AVAudioEngine polar patterns)

import { EigenAudio } from '$lib/plugins/eigenAudio';
import type { EigenAudioChunk } from '$lib/plugins/eigenAudio';

export class NativeAudioRecorder {
  mimeType = 'audio/x-caf';

  onChunk?: (blob: Blob, chunkIndex: number, startMs: number, endMs: number) => void;
  onError?: (err: Error) => void;
  onStop?:  () => void;

  private _levelL   = 0;
  private _levelR   = 0;
  private _elapsed  = 0;
  private _poll: ReturnType<typeof setInterval> | null = null;

  // ── Permission ──────────────────────────────────────────────

  async requestPermission(): Promise<'granted' | 'denied'> {
    try {
      const { granted } = await EigenAudio.requestPermission();
      return granted ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }

  // ── Start ───────────────────────────────────────────────────

  async start(sessionId: string, timesliceMs = 5000): Promise<void> {
    await EigenAudio.startRecording({
      sessionId,
      chunkDurationMs: timesliceMs,
      stereo:          true,
      sampleRate:      48000,
    });
    this._startPolling();
  }

  // ── Pause / Resume ──────────────────────────────────────────

  pause(): void  { EigenAudio.pauseRecording().catch(() => {}); }
  resume(): void { EigenAudio.resumeRecording().catch(() => {}); }

  // ── Stop ────────────────────────────────────────────────────
  // Fetches each .caf chunk file as a Blob and fires onChunk callbacks
  // so the rest of the app (IndexedDB, share, upload) works identically to web.

  async stop(): Promise<void> {
    this._stopPolling();

    let result: { chunks: EigenAudioChunk[]; durationMs: number };
    try {
      result = await EigenAudio.stopRecording();
    } catch (err) {
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.onStop?.();
      return;
    }

    // Build Blob from base64 data returned by Swift plugin.
    // fetch('file://') is blocked in WKWebView — base64 in the response avoids this.
    for (const chunk of result.chunks) {
      try {
        const raw = chunk as EigenAudioChunk & { base64?: string };
        if (!raw.base64) throw new Error(`No base64 data for chunk ${chunk.index}`);
        const bytes = Uint8Array.from(atob(raw.base64), (c) => c.charCodeAt(0));
        const blob  = new Blob([bytes], { type: chunk.mimeType });
        this.mimeType = chunk.mimeType;
        this.onChunk?.(blob, chunk.index, chunk.startMs, chunk.endMs);
      } catch (err) {
        this.onError?.(new Error(`Chunk ${chunk.index} decode failed: ${err}`));
      }
    }

    this.onStop?.();
  }

  release(): void { this._stopPolling(); }

  // ── Synchronous getters (backed by async polling) ───────────

  getMicLevels(): [number, number] { return [this._levelL, this._levelR]; }
  getMicLevel():  number           { return Math.max(this._levelL, this._levelR); }
  getElapsedMs(): number           { return this._elapsed; }

  get state(): string {
    return this._poll ? 'recording' : 'inactive';
  }

  // ── Private ─────────────────────────────────────────────────

  private _startPolling() {
    this._stopPolling();
    this._poll = setInterval(async () => {
      try {
        const [elRes, lvlRes] = await Promise.all([
          EigenAudio.getElapsedMs(),
          EigenAudio.getMicLevel(),
        ]);
        this._elapsed = elRes.value;
        this._levelL  = (lvlRes as { left?: number; right?: number; value: number }).left  ?? lvlRes.value;
        this._levelR  = (lvlRes as { left?: number; right?: number; value: number }).right ?? lvlRes.value;
      } catch { /* plugin paused or stopped */ }
    }, 80);
  }

  private _stopPolling() {
    if (this._poll) clearInterval(this._poll);
    this._poll = null;
  }
}
