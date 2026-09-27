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
  setKeepAwake(options: { enabled: boolean }): Promise<void>;
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

  // ── Dictation (SFSpeechRecognizer) ──────────────────────────────────────
  // Runs through the native plugin, so it reuses the microphone permission the
  // app already holds. Only speech recognition needs its own authorization.
  dictationPermission(): Promise<{
    granted:    boolean;
    speech:     'granted' | 'denied' | 'restricted' | 'prompt';
    microphone: 'granted' | 'denied';
  }>;
  startDictation(options: { locale: string }): Promise<{ started: boolean }>;
  stopDictation(): Promise<{ text: string }>;
  cancelDictation(): Promise<void>;

  addListener(
    event: 'dictationResult',
    cb: (data: { text: string; isFinal: boolean }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'dictationLevel',
    cb: (data: { level: number }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    event: 'dictationError',
    cb: (data: { kind: string; message: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
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
