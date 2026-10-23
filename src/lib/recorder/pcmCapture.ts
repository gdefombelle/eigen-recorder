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
  private ctx:         AudioContext | null                         = null;
  private workletNode: AudioWorkletNode | null                     = null;
  private source:      MediaStreamAudioSourceNode | null           = null;
  private gainNode:    GainNode | null                             = null; // iOS amplification stage
  private ampDest:     MediaStreamAudioDestinationNode | null      = null; // gained stream for backup recorder
  private _stream:     MediaStream | null                          = null;
  private sink:        GainNode | null                             = null;

  /** The raw getUserMedia stream — available after start(), null before/after. */
  get stream(): MediaStream | null { return this._stream; }

  /**
   * Amplified stream — the mic signal after the iOS gain stage.
   * Use this for backup MediaRecorder so the saved file matches the VU meter level.
   * Falls back to `stream` on non-iOS (gain = 1, no difference).
   */
  get amplifiedStream(): MediaStream | null { return this.ampDest?.stream ?? this._stream; }

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
    this._startEpoch = Date.now();
    this._pausedMs   = 0;
    this._pauseEpoch = 0;
    this._frameIndex = 0;
    await this._buildPipeline();
  }

  // ── Pause / Resume ────────────────────────────────────────────────────────

  async pause(): Promise<void> {
    if (!this.ctx) return;
    this._pauseEpoch = Date.now();
    this._teardownPipeline();
  }

  // Two narrower fixes (await+verify ctx.resume(), then re-acquire just the
  // mic track into the existing context) both failed on-device: after
  // Resume the vu meter stayed flat — nothing was being captured at all,
  // not just mistimed or unsent. That means the AudioContext itself can end
  // up "zombied" by iOS/WebKit: ctx.resume() can resolve and ctx.state can
  // read 'running' while the context never actually reconnects to real
  // hardware input again. There is no reliable signal from the Web Audio
  // API to detect that case — so resume() no longer tries to revive the old
  // context at all. It tears down every node and the old context, and
  // builds a brand new pipeline (new AudioContext, new getUserMedia track,
  // new worklet) exactly the way start() does — which we know works,
  // because an uninterrupted recording transcribes correctly. Frame/pause
  // bookkeeping (_frameIndex, _startEpoch, _pausedMs) is untouched, so
  // timestamps stay continuous across the gap.
  async resume(): Promise<void> {
    if (!this._pauseEpoch) return;
    this._pausedMs  += Date.now() - this._pauseEpoch;
    this._pauseEpoch = 0;
    this._teardownPipeline();
    await this._buildPipeline();
  }

  private _isIOS(): boolean {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // On iOS/WKWebView, autoGainControl MUST be true: without it the hardware ADC
  // operates at minimum analog gain (~-48 dBFS), producing near-silent capture.
  // On desktop/Android the raw signal is already at a usable level so we can
  // disable AGC to preserve natural dynamics.
  private _micConstraints(): MediaStreamConstraints {
    return {
      audio: {
        channelCount:      1,
        echoCancellation:  false,
        noiseSuppression:  false,
        autoGainControl:   this._isIOS(),
      },
    };
  }

  // Builds the entire capture graph from scratch: getUserMedia → AudioContext
  // → gain → worklet, exposing the same amplifiedStream shape each time so a
  // caller rebinding a backup MediaRecorder after resume() gets a working
  // stream (the old ampDest.stream from before pause() is gone — it belonged
  // to the closed context — so that rebind is the caller's responsibility).
  private async _buildPipeline(): Promise<void> {
    this._stream = await navigator.mediaDevices.getUserMedia(this._micConstraints());

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

    // AudioContext starts suspended until a user-gesture touch; both the
    // initial start() (REC button) and resume() (Resume button) are called
    // from a tap handler, so resuming immediately is safe here.
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

    this.source      = ctx.createMediaStreamSource(this._stream);
    this.workletNode = new AudioWorkletNode(ctx, 'pcm-frame-processor');

    // iOS WKWebView mic signal is typically 20–30 dB below desktop even with AGC.
    // A ×10 (20 dB) gain stage brings normal speech to -20 dBFS.
    // The worklet already clamps samples to ±1, so clipping from a very loud
    // input degrades gracefully without crashing the pipeline.
    this.gainNode            = ctx.createGain();
    this.gainNode.gain.value = this._isIOS() ? 10 : 1;

    // Expose the gained signal as a proper MediaStream so the backup MediaRecorder
    // records at the boosted level (matching the VU meter), not the raw quiet signal.
    this.ampDest = ctx.createMediaStreamDestination();

    // Silent sink — required in some browsers for the graph to actually process
    this.sink             = ctx.createGain();
    this.sink.gain.value  = 0;
    this.source.connect(this.gainNode);
    this.gainNode.connect(this.workletNode);
    this.gainNode.connect(this.ampDest);    // ← backup recorder source
    this.workletNode.connect(this.sink);
    this.sink.connect(ctx.destination);

    this.workletNode.port.onmessage = (ev: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
      const { pcm, rms } = ev.data;
      const idx    = this._frameIndex++;
      const startMs = idx * FRAME_DURATION_MS;
      const endMs   = startMs + FRAME_DURATION_MS;
      // dBFS-based display: floor at -50 dBFS → 0 %, 0 dBFS → 100 %.
      // Normal speech (-25 to -10 dBFS) → 50–80 %.  Silence / no-signal → 0 %.
      // More honest than sqrt*K because each 10 dB step moves the needle by the
      // same visual distance, matching how ears perceive loudness.
      const dB = rms > 1e-7 ? 20 * Math.log10(rms) : -120;
      this._lastLevel = Math.max(0, Math.min(1, (dB + 50) / 50));
      this.onLevel?.(this._lastLevel);
      this.onFrame?.(pcm, idx, startMs, endMs);
    };

    this.workletNode.port.onmessageerror = () => {
      this.onError?.(new Error('AudioWorklet message error'));
    };
  }

  private _teardownPipeline(): void {
    this.workletNode?.port.close();
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.gainNode?.disconnect();
    this.gainNode = null;
    this.ampDest = null; // MediaStreamDestinationNode has no disconnect needed
    this.source?.disconnect();
    this.source = null;
    this.sink?.disconnect();
    this.sink = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
  }

  // ── Stop ──────────────────────────────────────────────────────────────────

  stop(): void {
    this._teardownPipeline();
  }

  // ── Elapsed time (excludes paused intervals) ──────────────────────────────

  getElapsedMs(): number {
    if (!this._startEpoch) return 0;
    const nowPaused = this._pauseEpoch ? Date.now() - this._pauseEpoch : 0;
    return Date.now() - this._startEpoch - this._pausedMs - nowPaused;
  }

  getLevel(): number { return this._lastLevel; }
}
