// dictation.ts — speech-to-text for text composers, with a live mic level
// that drives the same MicLevelMeter waveform used by the recorder.
//
// Two engines behind one interface, mirroring how recorderStore picks
// NativeAudioRecorder vs AudioRecorder:
//
//   native → EigenAudioPlugin (SFSpeechRecognizer). Reuses the microphone
//            permission the app already holds, so dictation never re-asks for
//            the mic. Only speech recognition needs its own authorization,
//            because it is a genuinely different question (transcribing speech
//            vs recording audio). On-device whenever the locale supports it.
//
//   web    → Web Speech API. The browser owns the permission prompt, granted
//            once per origin.
//
// In both engines the level meter is BEST-EFFORT: it may fail independently
// and the only consequence is a flat waveform. It must never block dictation.
//
// Dictation never starts, stops or disturbs a session recording, and raw audio
// is never sent to the chat API — callers only receive recognized text.

import { isNative } from '$lib/platform';

export type DictationErrorKind =
  | 'unsupported'        // no speech recognition on this platform
  | 'permission_denied'  // speech recognition refused by user or policy
  | 'busy'               // a session recording is in progress
  | 'no_speech'          // ended without recognizing anything
  | 'failed';            // network or other recognition failure

export interface DictationError {
  kind:    DictationErrorKind;
  message: string;
}

export interface DictationHandlers {
  /** Recognized text so far, for live preview in the composer. */
  onTranscript: (text: string) => void;
  /** Mono peak amplitude 0..1 for the level meter. */
  onLevel:      (level: number) => void;
  /** Recognition ended on its own — e.g. a silence timeout. */
  onEnd:        () => void;
  onError:      (err: DictationError) => void;
}

const ERROR_MESSAGES: Record<DictationErrorKind, string> = {
  unsupported:       'Dictation is not supported on this device.',
  permission_denied: 'Speech recognition is off. Enable it in Settings › Eigen Pocket.',
  busy:              'Stop the recording before dictating.',
  no_speech:         "Didn't catch that — tap the mic and try again.",
  failed:            'Dictation failed. Please try again.',
};

export function dictationMessage(kind: DictationErrorKind): string {
  return ERROR_MESSAGES[kind];
}

/** True when this platform can dictate. */
export function isDictationSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (isNative()) return true; // EigenAudioPlugin provides SFSpeechRecognizer
  return 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
}

/** Map the app's language preference onto a BCP-47 recognition locale. */
export function recognitionLocale(lang: string | null | undefined): string {
  return lang === 'fr' ? 'fr-FR' : 'en-US';
}

interface Engine {
  start(lang: string | null | undefined): Promise<boolean>;
  stop(): Promise<string>;
  cancel(): Promise<void>;
}

// ── Native engine — EigenAudioPlugin / SFSpeechRecognizer ───────────────────

class NativeEngine implements Engine {
  private removers: Array<{ remove: () => Promise<void> }> = [];
  private text = '';

  constructor(private handlers: DictationHandlers) {}

  async start(lang: string | null | undefined): Promise<boolean> {
    const { EigenAudio } = await import('$lib/plugins/eigenAudio');
    this.text = '';

    this.removers = await Promise.all([
      EigenAudio.addListener('dictationResult', ({ text }) => {
        this.text = text;
        this.handlers.onTranscript(text);
      }),
      EigenAudio.addListener('dictationLevel', ({ level }) => this.handlers.onLevel(level)),
      EigenAudio.addListener('dictationError', ({ kind, message }) => {
        this.handlers.onError({
          kind: (['unsupported','permission_denied','busy','no_speech','failed'] as const)
            .includes(kind as DictationErrorKind) ? (kind as DictationErrorKind) : 'failed',
          message,
        });
      }),
    ]);

    try {
      await EigenAudio.startDictation({ locale: recognitionLocale(lang) });
      return true;
    } catch (e) {
      const code = (e as { code?: string })?.code ?? '';
      const kind: DictationErrorKind =
        code === 'RECORDING_ACTIVE' ? 'busy'
        : code === 'DENIED' || code === 'RESTRICTED' ? 'permission_denied'
        : code === 'UNAVAILABLE' ? 'unsupported'
        : 'failed';
      this.handlers.onError({ kind, message: ERROR_MESSAGES[kind] });
      await this.teardown();
      return false;
    }
  }

  async stop(): Promise<string> {
    try {
      const { EigenAudio } = await import('$lib/plugins/eigenAudio');
      const { text } = await EigenAudio.stopDictation();
      return (text || this.text).trim();
    } catch {
      return this.text.trim();
    } finally {
      await this.teardown();
    }
  }

  async cancel(): Promise<void> {
    try {
      const { EigenAudio } = await import('$lib/plugins/eigenAudio');
      await EigenAudio.cancelDictation();
    } catch { /* already stopped */ }
    this.text = '';
    await this.teardown();
  }

  private async teardown(): Promise<void> {
    await Promise.allSettled(this.removers.map((r) => r.remove()));
    this.removers = [];
    this.handlers.onLevel(0);
  }
}

// ── Web engine — Web Speech API ─────────────────────────────────────────────

class WebEngine implements Engine {
  private rec: any = null;
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private levelData: Uint8Array<ArrayBuffer> | null = null;
  private rafId = 0;
  private finalText = '';
  private closing = false;

  constructor(private handlers: DictationHandlers) {}

  async start(lang: string | null | undefined): Promise<boolean> {
    this.finalText = '';
    this.closing   = false;

    const w = window as any;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      this.handlers.onError({ kind: 'unsupported', message: ERROR_MESSAGES.unsupported });
      return false;
    }

    const rec = new SR();
    rec.lang            = recognitionLocale(lang);
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.maxAlternatives = 1;

    rec.onresult = (ev: any) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) this.finalText += (this.finalText ? ' ' : '') + r[0].transcript.trim();
        else           interim        += r[0].transcript;
      }
      const combined = interim
        ? `${this.finalText}${this.finalText ? ' ' : ''}${interim}`
        : this.finalText;
      this.handlers.onTranscript(combined.trim());
    };

    rec.onerror = (ev: any) => {
      if (this.closing || ev?.error === 'aborted') return;
      const kind: DictationErrorKind =
        ev?.error === 'not-allowed' || ev?.error === 'service-not-allowed' ? 'permission_denied'
        : ev?.error === 'no-speech' ? 'no_speech'
        : 'failed';
      this.handlers.onError({ kind, message: ERROR_MESSAGES[kind] });
      this.cleanup();
    };

    rec.onend = () => {
      if (this.closing) return;
      this.cleanup();
      this.handlers.onEnd();
    };

    this.rec = rec;
    try {
      // Recognition owns the microphone permission — start it first so a
      // refusal is reported by onerror('not-allowed') rather than by the meter.
      rec.start();
    } catch {
      this.handlers.onError({ kind: 'failed', message: ERROR_MESSAGES.failed });
      this.cleanup();
      return false;
    }

    // Best-effort waveform. A failure here is silent: dictation continues and
    // the meter simply stays flat. It must never block or fail the session.
    this.attachMeter();
    return true;
  }

  async stop(): Promise<string> {
    this.closing = true;
    try { this.rec?.stop(); } catch { /* already stopped */ }
    const text = this.finalText.trim();
    this.cleanup();
    return text;
  }

  async cancel(): Promise<void> {
    this.closing = true;
    try { this.rec?.abort(); } catch { /* already stopped */ }
    this.finalText = '';
    this.cleanup();
  }

  private async attachMeter(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (this.closing) { this.stream.getTracks().forEach((t) => t.stop()); return; }
      this.audioContext = new AudioContext();
      const source    = this.audioContext.createMediaStreamSource(this.stream);
      // ×4 gain boost so low-level mic input is visible, matching AudioRecorder.
      const meterGain = this.audioContext.createGain();
      meterGain.gain.value = 4;
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.levelData = new Uint8Array(this.analyser.fftSize);
      source.connect(meterGain);
      meterGain.connect(this.analyser);
      this.tick();
    } catch {
      // Flat meter, dictation unaffected.
    }
  }

  /** Mono peak amplitude 0..1, same math as AudioRecorder.getMicLevel(). */
  private tick = (): void => {
    if (!this.analyser || !this.levelData) return;
    this.analyser.getByteTimeDomainData(this.levelData);
    let peak = 0;
    for (let i = 0; i < this.levelData.length; i++) {
      const v = Math.abs(this.levelData[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    this.handlers.onLevel(peak);
    this.rafId = requestAnimationFrame(this.tick);
  };

  private cleanup(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.audioContext?.close().catch(() => {});
    this.rec          = null;
    this.stream       = null;
    this.audioContext = null;
    this.analyser     = null;
    this.levelData    = null;
    this.handlers.onLevel(0);
  }
}

// ── Public facade ───────────────────────────────────────────────────────────

export class Dictation {
  private engine: Engine | null = null;

  constructor(private handlers: DictationHandlers) {}

  async start(lang: string | null | undefined): Promise<boolean> {
    if (!isDictationSupported()) {
      this.handlers.onError({ kind: 'unsupported', message: ERROR_MESSAGES.unsupported });
      return false;
    }
    this.engine = isNative() ? new NativeEngine(this.handlers) : new WebEngine(this.handlers);
    const ok = await this.engine.start(lang);
    if (!ok) this.engine = null;
    return ok;
  }

  /** Stop listening and resolve with the recognized text ('' when nothing was heard). */
  async stop(): Promise<string> {
    const engine = this.engine;
    this.engine = null;
    return engine ? engine.stop() : '';
  }

  /** Abort listening and discard everything recognized so far. */
  async cancel(): Promise<void> {
    const engine = this.engine;
    this.engine = null;
    await engine?.cancel();
  }
}
