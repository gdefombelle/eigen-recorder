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
  private analyserL: AnalyserNode | null = null;
  private analyserR: AnalyserNode | null = null;
  private levelDataL: Uint8Array<ArrayBuffer> | null = null;
  private levelDataR: Uint8Array<ArrayBuffer> | null = null;

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

  // Returns [left/bottom, right/top] — 0..1 each.
  // Uses time-domain peak amplitude — far more reactive than frequency bins for voice.
  getMicLevels(): [number, number] {
    const readPeak = (a: AnalyserNode | null, d: Uint8Array<ArrayBuffer> | null): number => {
      if (!a || !d) return 0;
      a.getByteTimeDomainData(d);
      let peak = 0;
      for (let i = 0; i < d.length; i++) {
        const v = Math.abs(d[i] - 128) / 128; // 128=silence, 0/255=peak
        if (v > peak) peak = v;
      }
      return peak;
    };
    const l = readPeak(this.analyserL, this.levelDataL);
    const r = readPeak(this.analyserR ?? this.analyserL, this.levelDataR ?? this.levelDataL);
    return [l, r];
  }

  // Backward-compat
  getMicLevel(): number {
    const [l, r] = this.getMicLevels();
    return Math.max(l, r);
  }

  get state(): string {
    return this.mediaRecorder?.state ?? 'inactive';
  }

  private _setupAnalyser(stream: MediaStream): void {
    try {
      this.audioContext = new AudioContext();
      const source  = this.audioContext.createMediaStreamSource(stream);
      const numCh   = source.channelCount;

      // Gain node amplifies signal for the meter only (not for MediaRecorder recording)
      const meterGain = this.audioContext.createGain();
      meterGain.gain.value = 4; // ×4 boost — makes low-level mic visible on mobile

      if (numCh >= 2) {
        const splitter = this.audioContext.createChannelSplitter(2);
        this.analyserL = this.audioContext.createAnalyser();
        this.analyserR = this.audioContext.createAnalyser();
        this.analyserL.fftSize = 2048; // higher resolution for time-domain
        this.analyserR.fftSize = 2048;
        this.levelDataL = new Uint8Array(this.analyserL.fftSize);
        this.levelDataR = new Uint8Array(this.analyserR.fftSize);
        source.connect(meterGain);
        meterGain.connect(splitter);
        splitter.connect(this.analyserL, 0);
        splitter.connect(this.analyserR, 1);
      } else {
        this.analyserL = this.audioContext.createAnalyser();
        this.analyserL.fftSize = 2048;
        this.levelDataL = new Uint8Array(this.analyserL.fftSize);
        source.connect(meterGain);
        meterGain.connect(this.analyserL);
      }

    } catch {
      // Non-fatal
    }
  }

  private _releaseStream(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    this.stream       = null;
    this.audioContext = null;
    this.analyserL    = null;   this.levelDataL = null;
    this.analyserR    = null;   this.levelDataR = null;
  }
}
