// scanSpike — TEMPORARY instrumentation for the "Scan a document" audio spike.
//
// Question under test: does opening VisionKit's document camera (in DocScan's isolated UIWindow) during a
// record leave the audio and the stream untouched? This module measures what the app can see from the inside
// (stream state, frame rate, recorder state, WebView reloads, iOS audio/lifecycle events). What it cannot see —
// the final audio's duration and silences, the server transcript — is checked outside by
// scripts/spike/analyze-audio.py and by reading the transcript.

import { FRAME_DURATION_MS } from '../../pcmCapture';

// ── Types ──────────────────────────────────────────────────────────────────

export interface StoreSnap {
  state:           string;
  syncMode:        string;
  liveStreamState: string;
  framesStreamed:  number;
  wasInterrupted:  boolean;
  /** Audio-timeline position, pauses excluded (recorderStore.getCaptureOffsetMs). */
  audioOffsetMs:   number;
  wallMs:          number;
}

export interface ProbeSnap {
  interruptionBegan:   number;
  interruptionEnded:   number;
  mediaServicesResets: number;
  resignActive:        number;
  becomeActive:        number;
  routeChanges:        unknown[];
  category:            string;
  mode:                string;
  appState:            number;
}

export interface ScanMeasurement {
  id:                  string;
  label:               string;
  startedAt:           string;
  scanWallMs:          number;
  before:              StoreSnap;
  after:               StoreSnap;
  liveStateTransitions: string[];
  maxTimerGapMs:       number;
  probeBefore:         ProbeSnap | null;
  probeAfter:          ProbeSnap | null;
  pages:               number;
  payloadBytes:        number;
  cancelled:           boolean;
  error:               string | null;
  webviewReloaded:     boolean;
}

export interface ScanCheck { id: string; ok: boolean; informational: boolean; detail: string }
export interface ScanVerdict { checks: ScanCheck[]; pass: boolean }

// ── Verdict (pure) ─────────────────────────────────────────────────────────

/** The audio clock may drift from the wall clock by at most this much across a scan. */
export const CLOCK_TOLERANCE_MS = 300;
/** A scan may lose at most this share of the expected stream frames (plus 2 frames of slack). */
export const FRAME_LOSS_TOLERANCE = 0.15;

export function evaluateScan(m: ScanMeasurement): ScanVerdict {
  const checks: ScanCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, informational = false) => checks.push({ id, ok, informational, detail });
  const stream = m.before.syncMode === 'stream';

  add('webview_stable', !m.webviewReloaded,
    m.webviewReloaded ? 'the WebView RELOADED during the scan (web content process terminated?)' : 'no reload');

  add('scan_completed', m.error === null,
    m.error ? `error: ${m.error}` : m.cancelled ? 'cancelled by the user' : `${m.pages} page(s), ${(m.payloadBytes / 1e6).toFixed(1)} MB through the bridge`);

  const wallDelta = m.after.wallMs - m.before.wallMs;
  const audioDelta = m.after.audioOffsetMs - m.before.audioOffsetMs;
  add('audio_clock_follows_wall', Math.abs(wallDelta - audioDelta) <= CLOCK_TOLERANCE_MS,
    `audio clock +${audioDelta} ms vs wall +${wallDelta} ms (tolerance ${CLOCK_TOLERANCE_MS} ms)`);

  const stillRecording = m.after.state === 'recording_offline' && !m.after.wasInterrupted;
  add('recorder_not_interrupted', stillRecording, `state=${m.after.state}, wasInterrupted=${m.after.wasInterrupted}`);

  if (stream) {
    const bad = m.liveStateTransitions.filter((s) => s === 'reconnecting' || s === 'connecting' || s === 'failed');
    add('stream_stayed_connected', bad.length === 0 && m.after.liveStreamState === 'streaming',
      bad.length ? `stream state went through: ${bad.join(' → ')}` : `stayed '${m.after.liveStreamState}'`);

    const expected = m.scanWallMs / FRAME_DURATION_MS;
    const delta = m.after.framesStreamed - m.before.framesStreamed;
    add('stream_frames_continuous', delta >= expected * (1 - FRAME_LOSS_TOLERANCE) - 2,
      `${delta} frames sent, ~${expected.toFixed(0)} expected for ${(m.scanWallMs / 1000).toFixed(1)} s`);
  }

  if (m.probeBefore && m.probeAfter) {
    const d = (k: 'interruptionBegan' | 'mediaServicesResets' | 'resignActive') => m.probeAfter![k] - m.probeBefore![k];
    add('no_audio_session_interruption', d('interruptionBegan') === 0 && d('mediaServicesResets') === 0,
      `interruptions +${d('interruptionBegan')}, media-services resets +${d('mediaServicesResets')}, route changes +${m.probeAfter.routeChanges.length - m.probeBefore.routeChanges.length}`);
    add('app_stayed_active', d('resignActive') === 0, `willResignActive +${d('resignActive')}`, true);
  }

  add('webview_timers_not_frozen', m.maxTimerGapMs < 1000, `longest JS timer gap ${m.maxTimerGapMs} ms`, true);

  return { checks, pass: checks.filter((c) => !c.informational).every((c) => c.ok) };
}

// ── Heartbeat: how long was the WebView's JS thread stalled? ───────────────

export function startHeartbeat(now: () => number = Date.now, setTimer = setInterval, clearTimer = clearInterval) {
  let last = now();
  let max = 0;
  const id = setTimer(() => { const t = now(); max = Math.max(max, t - last - 100); last = t; }, 100);
  return { stop(): number { clearTimer(id); return Math.max(0, max); } };
}

// ── Persistence & crash detection ──────────────────────────────────────────
//
// A WebView reload kills the pending JS promise, so the scan is written down BEFORE it starts. On the next
// page load, a pending marker whose boot id differs from the current one means the WebView was reloaded.

export interface KeyValueStore { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const LOG_KEY = 'ev_scan_spike_log';
const PENDING_KEY = 'ev_scan_spike_pending';
const MAX_LOG = 50;

interface PendingMarker { id: string; label: string; startedAt: string; bootId: string; before: StoreSnap }

export function readLog(kv: KeyValueStore): ScanMeasurement[] {
  try { return JSON.parse(kv.getItem(LOG_KEY) ?? '[]') as ScanMeasurement[]; } catch { return []; }
}

function writeLog(kv: KeyValueStore, log: ScanMeasurement[]): void {
  try { kv.setItem(LOG_KEY, JSON.stringify(log.slice(-MAX_LOG))); } catch { /* storage full or blocked */ }
}

export function clearLog(kv: KeyValueStore): void { try { kv.removeItem(LOG_KEY); kv.removeItem(PENDING_KEY); } catch { /* */ } }

/** Call once at startup: a leftover pending marker from ANOTHER boot is a scan the WebView did not survive. */
export function recoverInterruptedScan(kv: KeyValueStore, currentBootId: string, nowIso: () => string = () => new Date().toISOString()): ScanMeasurement | null {
  let raw: string | null = null;
  try { raw = kv.getItem(PENDING_KEY); } catch { return null; }
  if (!raw) return null;
  let pending: PendingMarker;
  try { pending = JSON.parse(raw) as PendingMarker; } catch { try { kv.removeItem(PENDING_KEY); } catch { /* */ } return null; }
  try { kv.removeItem(PENDING_KEY); } catch { /* */ }
  if (pending.bootId === currentBootId) return null;          // same boot: the scan is still running or just ended normally
  const lost: ScanMeasurement = {
    id: pending.id, label: pending.label, startedAt: pending.startedAt, scanWallMs: Date.parse(nowIso()) - Date.parse(pending.startedAt),
    before: pending.before, after: pending.before, liveStateTransitions: [], maxTimerGapMs: 0,
    probeBefore: null, probeAfter: null, pages: 0, payloadBytes: 0, cancelled: false,
    error: 'WebView reloaded before the scan returned', webviewReloaded: true,
  };
  writeLog(kv, [...readLog(kv), lost]);
  return lost;
}

// ── Orchestration (dependencies injected) ──────────────────────────────────

export interface ScanPage { index: number; width: number; height: number; data: string }

export interface SpikeDeps {
  kv:             KeyValueStore;
  bootId:         string;
  now:            () => number;
  nowIso:         () => string;
  newId:          () => string;
  snapStore:      () => Promise<StoreSnap>;
  /** Subscribes to the stream state; returns the unsubscribe. The callback receives every state change. */
  watchLiveState: (cb: (s: string) => void) => () => void;
  scan:           () => Promise<{ pages: ScanPage[] } | null>;
  probe:          { start(): Promise<unknown>; snapshot(): Promise<ProbeSnap> } | null;
}

export async function runInstrumentedScan(deps: SpikeDeps, label: string): Promise<ScanMeasurement> {
  const id = deps.newId();
  await deps.probe?.start().catch(() => {});
  const before = await deps.snapStore();
  const probeBefore = await deps.probe?.snapshot().catch(() => null) ?? null;

  try { deps.kv.setItem(PENDING_KEY, JSON.stringify({ id, label, startedAt: deps.nowIso(), bootId: deps.bootId, before } satisfies PendingMarker)); } catch { /* */ }

  const transitions: string[] = [];
  const unwatch = deps.watchLiveState((s) => transitions.push(s));
  const heartbeat = startHeartbeat(deps.now);
  const t0 = deps.now();
  let pages: ScanPage[] = []; let cancelled = false; let error: string | null = null;
  try {
    const res = await deps.scan();
    if (res === null) cancelled = true; else pages = res.pages;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const scanWallMs = deps.now() - t0;
  const maxTimerGapMs = heartbeat.stop();
  unwatch();

  const after = await deps.snapStore();
  const probeAfter = await deps.probe?.snapshot().catch(() => null) ?? null;
  try { deps.kv.removeItem(PENDING_KEY); } catch { /* */ }

  const m: ScanMeasurement = {
    id, label, startedAt: new Date(t0).toISOString(), scanWallMs, before, after, liveStateTransitions: transitions,
    maxTimerGapMs, probeBefore, probeAfter, pages: pages.length,
    payloadBytes: pages.reduce((n, p) => n + p.data.length, 0), cancelled, error, webviewReloaded: false,
  };
  writeLog(deps.kv, [...readLog(deps.kv), m]);
  return m;
}

/** The report to paste back: one JSON document with every scan, its verdict and the scan windows on the audio timeline. */
export function buildReport(log: ScanMeasurement[]): string {
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    scans: log.map((m) => ({
      label: m.label, startedAt: m.startedAt, pages: m.pages, scanWallMs: m.scanWallMs,
      mode: m.before.syncMode,
      /** where the scan sits on the audio timeline — what scripts/spike/analyze-audio.py takes as --scans */
      audioWindowMs: [m.before.audioOffsetMs, m.after.audioOffsetMs],
      verdict: evaluateScan(m),
      measurement: m,
    })),
  }, null, 2);
}
