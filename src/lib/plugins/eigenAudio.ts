// EigenAudio — TypeScript bridge to EigenAudioPlugin (Capacitor native).
// Used only when isNative() = true. The web AudioRecorder.ts handles the PWA path.

import { registerPlugin } from '@capacitor/core';

// ── Plugin contract (mirrors EigenAudioPlugin.swift) ──────────────────────

export interface EigenAudioChunk {
  path:      string;   // file:// URI in iOS sandbox
  index:     number;
  startMs:   number;
  endMs:     number;
  sizeBytes: number;
  mimeType:  'audio/x-caf' | 'audio/mp4';
  isStereo:  boolean;
}

export interface EigenAudioStartOptions {
  sessionId:       string;
  chunkDurationMs: number;
  stereo:          boolean;
  sampleRate:      number;
}

export interface EigenAudioStopResult {
  chunks:     EigenAudioChunk[];
  durationMs: number;
}

export interface EigenAudioPlugin {
  requestLocationPermission(): Promise<{ granted: boolean }>;
  getLocation(): Promise<{ latitude: number; longitude: number; accuracy: number; timestamp: number }>;
  requestPermission(): Promise<{ granted: boolean }>;
  startRecording(options: EigenAudioStartOptions): Promise<void>;
  pauseRecording(): Promise<void>;
  resumeRecording(): Promise<void>;
  stopRecording(): Promise<EigenAudioStopResult>;
  getElapsedMs(): Promise<{ value: number }>;
  getMicLevel(): Promise<{ value: number }>;
  mergeChunks(options: { sessionId: string }): Promise<{
    base64: string;
    mimeType: string;
    sizeBytes: number;
    path: string;
  }>;
}

export const EigenAudio = registerPlugin<EigenAudioPlugin>('EigenAudioPlugin');

// ── Mic level polling helper ───────────────────────────────────────────────

let _levelInterval: ReturnType<typeof setInterval> | null = null;

export function startLevelPolling(onLevel: (level: number) => void, intervalMs = 100) {
  stopLevelPolling();
  _levelInterval = setInterval(async () => {
    try {
      const { value } = await EigenAudio.getMicLevel();
      onLevel(value);
    } catch { /* plugin not active */ }
  }, intervalMs);
}

export function stopLevelPolling() {
  if (_levelInterval) clearInterval(_levelInterval);
  _levelInterval = null;
}
