// AudioRecorder — wraps MediaRecorder with precise chunk timing and mic-level analysis.
// Designed to be swappable with a Capacitor native plugin in a future iOS build.

export type MicPermissionStatus = 'granted' | 'denied' | 'unavailable';

const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/aac',
];

export function getSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of PREFERRED_TYPES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

export function isSafariLimited(): boolean {
  // Safari before 14.5 on iOS does not support MediaRecorder at all.
  // In supported versions it only handles audio/mp4, not webm.
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (
    navigator.maxTouchPoints > 1 && /Macintosh/.test(ua)
  );
}

export class AudioRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;

  private sessionStartEpoch = 0;
  private pausedAccumMs     = 0;
  private pauseEpoch        = 0;
  private chunkStartMs      = 0;
  private _chunkIndex       = 0;

  public mimeType = '';

  // Callbacks injected by the store
  onChunk?: (blob: Blob, chunkIndex: number, startMs: number, endMs: number) => void;
  onError?: (err: Error) => void;
  onStop?:  () => void;

  // ── Permission ──────────────────────────────────────────────

  async requestPermission(): Promise<MicPermissionStatus> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      return 'unavailable';
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return 'granted';
    } catch {
      return 'denied';
    }
  }

  // ── Start ───────────────────────────────────────────────────

  async start(timesliceMs = 5000): Promise<void> {
    this.mimeType = getSupportedMimeType();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
        channelCount:      { ideal: 2 }, // stereo on supporting devices
        sampleRate:        48000,
      },
    });

    this._setupAnalyser(this.stream);

    const options: MediaRecorderOptions = { audioBitsPerSecond: 128_000 };
    if (this.mimeType) options.mimeType = this.mimeType;

    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mimeType = this.mediaRecorder.mimeType || this.mimeType;

    this._chunkIndex       = 0;
    this.pausedAccumMs     = 0;
    this.chunkStartMs      = 0;
    this.sessionStartEpoch = Date.now();

    this.mediaRecorder.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        const endMs = this.getElapsedMs();
        this.onChunk?.(ev.data, this._chunkIndex++, this.chunkStartMs, endMs);
        this.chunkStartMs = endMs;
      }
    };

    this.mediaRecorder.onstop = () => {
      this.onStop?.();
    };

    this.mediaRecorder.onerror = (ev) => {
      this.onError?.(new Error((ev as ErrorEvent).message || 'MediaRecorder error'));
    };

    this.mediaRecorder.start(timesliceMs);
  }

  // ── Pause ───────────────────────────────────────────────────

  pause(): void {
    if (this.mediaRecorder?.state === 'recording') {
      // Flush buffered audio since last timeslice so the partial chunk is saved.
      // ondataavailable fires asynchronously before the 'pause' event — safe.
      this.mediaRecorder.requestData();
      this.mediaRecorder.pause();
      this.pauseEpoch = Date.now();
    }
  }

  // ── Resume ──────────────────────────────────────────────────

  resume(): void {
    if (this.mediaRecorder?.state === 'paused') {
      this.pausedAccumMs += Date.now() - this.pauseEpoch;
      this.mediaRecorder.resume();
      this.chunkStartMs = this.getElapsedMs();
    }
  }

  // ── Stop ────────────────────────────────────────────────────

  stop(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // If paused, resume briefly so the final chunk fires before stop
      if (this.mediaRecorder.state === 'paused') {
        this.pausedAccumMs += Date.now() - this.pauseEpoch;
        this.mediaRecorder.resume();
      }
      this.mediaRecorder.stop();
    }
    this._releaseStream();
  }

  // ── Release ─────────────────────────────────────────────────

  release(): void {
    this._releaseStream();
  }

  // ── Helpers ─────────────────────────────────────────────────

  getElapsedMs(): number {
    if (!this.sessionStartEpoch) return 0;
    const nowPaused =
      this.mediaRecorder?.state === 'paused'
        ? this.pausedAccumMs + (Date.now() - this.pauseEpoch)
        : this.pausedAccumMs;
    return Date.now() - this.sessionStartEpoch - nowPaused;
  }

  // Returns mono peak amplitude 0..1 (time-domain, more reactive than frequency bins).
  getMicLevel(): number {
    if (!this.analyser || !this.levelData) return 0;
    this.analyser.getByteTimeDomainData(this.levelData);
    let peak = 0;
    for (let i = 0; i < this.levelData.length; i++) {
      const v = Math.abs(this.levelData[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  // Kept for interface compatibility with NativeAudioRecorder
  getMicLevels(): [number, number] {
    const l = this.getMicLevel();
    return [l, l];
  }

  get state(): string {
    return this.mediaRecorder?.state ?? 'inactive';
  }

  private _setupAnalyser(stream: MediaStream): void {
    try {
      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(stream);
      // ×4 gain boost so low-level mic input is visible in the meter
      const meterGain = this.audioContext.createGain();
      meterGain.gain.value = 4;
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.levelData = new Uint8Array(this.analyser.fftSize);
      source.connect(meterGain);
      meterGain.connect(this.analyser);
    } catch {
      // Non-fatal — meter just stays at 0
    }
  }

  private _releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    this.stream       = null;
    this.audioContext = null;
    this.analyser     = null;
    this.levelData    = null;
  }
}
