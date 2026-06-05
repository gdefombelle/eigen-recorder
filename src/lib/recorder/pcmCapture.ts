// PcmCapture — unified mono 16 kHz PCM16 capture for web / PWA / iOS Capacitor WebView.
//
// Single pipeline: Web Audio API + AudioWorklet.
// Works identically in browser, PWA, and WKWebView (iOS 15+, AudioWorklet supported).
//
// Audio path:
//   getUserMedia (mono) → AudioContext → AudioWorkletNode
//     • downmix N channels → mono
//     • resample ctx.sampleRate → 16 000 Hz (linear interpolation)
//     • convert Float32 → Int16 PCM
//     • emit 320 ms frames (~5 120 samples) via onFrame callback

export const LIVE_SAMPLE_RATE   = 16_000;
export const FRAME_DURATION_MS  = 320;
export const FRAME_SAMPLES      = Math.round(LIVE_SAMPLE_RATE * FRAME_DURATION_MS / 1_000); // 5120

// ---------------------------------------------------------------------------
// AudioWorklet processor source — loaded as an inline Blob URL so no extra
// static file is needed (works in production builds and iOS WKWebView).
// ---------------------------------------------------------------------------
const WORKLET_CODE = `
class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // sampleRate is the AudioWorkletGlobalScope global (= AudioContext.sampleRate)
    this._ratio        = sampleRate / 16000; // e.g. 3.0 for 48 kHz source
    this._phase        = 0;                  // fractional input position for next output sample
    this._frameSamples = 5120;               // 320 ms × 16 000 Hz
    this._buf          = [];
  }

  process(inputs) {
    const inp = inputs[0];
    if (!inp || inp.length === 0) return true;

    const len = inp[0].length; // always 128 per spec

    // ── 1. Downmix all channels to mono ────────────────────────────────────
    const mono = new Float32Array(len);
    for (let c = 0; c < inp.length; c++)
      for (let i = 0; i < len; i++) mono[i] += inp[c][i] / inp.length;

    // ── 2. Resample to 16 kHz via linear interpolation ─────────────────────
    // _phase advances by _ratio per output sample; carry-over across blocks.
    while (this._phase < len) {
      const i = Math.floor(this._phase);
      const f = this._phase - i;
      const a = mono[i];
      const b = (i + 1) < len ? mono[i + 1] : mono[len - 1];
      this._buf.push(a + f * (b - a));
      this._phase += this._ratio;
    }
    this._phase -= len; // carry forward; always >= 0

    // ── 3. Emit full 320 ms frames ──────────────────────────────────────────
    while (this._buf.length >= this._frameSamples) {
      const pcm = new Int16Array(this._frameSamples);
      let ss = 0;
      for (let i = 0; i < this._frameSamples; i++) {
        const s = Math.max(-1, Math.min(1, this._buf[i]));
        pcm[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
        ss += s * s;
      }
      const rms = Math.sqrt(ss / this._frameSamples);
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
      this._buf = this._buf.slice(this._frameSamples);
    }

    return true; // keep processor alive
  }
}
registerProcessor('pcm-frame-processor', PcmFrameProcessor);
`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class PcmCapture {
  private ctx:         AudioContext | null               = null;
  private workletNode: AudioWorkletNode | null           = null;
  private source:      MediaStreamAudioSourceNode | null = null;
  private stream:      MediaStream | null                = null;
  private sink:        GainNode | null                   = null;

  private _startEpoch  = 0;
  private _pausedMs    = 0;
  private _pauseEpoch  = 0;
  private _frameIndex  = 0;
  private _lastLevel   = 0;

  onFrame?: (pcm: ArrayBuffer, frameIndex: number, startMs: number, endMs: number) => void;
  onLevel?: (level: number) => void;
  onError?: (err: Error)    => void;

  // ── Start ─────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    // Mono mic — no stereo, no noise suppression/AGC for raw PCM capture
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount:      1,
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   false,
      },
    });

    // Prefer 16 kHz context so the worklet resamples as little as possible.
    // If the browser ignores our hint (common on iOS), the worklet resamples
    // from whatever ctx.sampleRate is.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: LIVE_SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;

    // iOS AudioContext starts suspended until a user-gesture touch; since
    // start() is called from the REC button handler we can resume immediately.
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    // Load worklet from inline Blob — no separate static file needed
    const blob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const url  = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.source      = ctx.createMediaStreamSource(this.stream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm-frame-processor');

    // Silent sink — required in some browsers for the graph to actually process
    this.sink             = ctx.createGain();
    this.sink.gain.value  = 0;
    this.source.connect(this.workletNode);
    this.workletNode.connect(this.sink);
    this.sink.connect(ctx.destination);

    this._startEpoch = Date.now();
    this._pausedMs   = 0;
    this._pauseEpoch = 0;
    this._frameIndex = 0;

    this.workletNode.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const { pcm, rms } = ev.data;
      const idx    = this._frameIndex++;
      const startMs = idx * FRAME_DURATION_MS;
      const endMs   = startMs + FRAME_DURATION_MS;
      // Scale RMS (0..1) into a usable 0..1 visual level
      this._lastLevel = Math.min(1, rms * 6);
      this.onLevel?.(this._lastLevel);
      this.onFrame?.(pcm, idx, startMs, endMs);
    };

    this.workletNode.port.onmessageerror = () => {
      this.onError?.(new Error('AudioWorklet message error'));
    };
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  pause(): void {
    if (this.ctx?.state === 'running') {
      this._pauseEpoch = Date.now();
      this.ctx.suspend().catch(() => {});
    }
  }

  resume(): void {
    if (this.ctx?.state === 'suspended' && this._pauseEpoch) {
      this._pausedMs   += Date.now() - this._pauseEpoch;
      this._pauseEpoch  = 0;
      this.ctx.resume().catch(() => {});
    }
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  stop(): void {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.source?.disconnect();
    this.source = null;
    this.sink?.disconnect();
    this.sink = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // ── Elapsed time (excludes paused intervals) ──────────────────────────────

  getElapsedMs(): number {
    if (!this._startEpoch) return 0;
    const nowPaused = this._pauseEpoch ? Date.now() - this._pauseEpoch : 0;
    return Date.now() - this._startEpoch - this._pausedMs - nowPaused;
  }

  getLevel(): number { return this._lastLevel; }
}
