import { describe, it, expect, vi } from 'vitest';
import {
  evaluateScan, runInstrumentedScan, recoverInterruptedScan, readLog, buildReport, startHeartbeat,
  type ScanMeasurement, type StoreSnap, type ProbeSnap, type KeyValueStore, type SpikeDeps,
} from './scanSpike';

const snap = (over: Partial<StoreSnap> = {}): StoreSnap => ({
  state: 'recording_offline', syncMode: 'stream', liveStreamState: 'streaming', framesStreamed: 100,
  wasInterrupted: false, audioOffsetMs: 60_000, wallMs: 1_000_000, ...over,
});
const probe = (over: Partial<ProbeSnap> = {}): ProbeSnap => ({
  interruptionBegan: 0, interruptionEnded: 0, mediaServicesResets: 0, resignActive: 0, becomeActive: 0,
  routeChanges: [], category: 'playAndRecord', mode: 'videoChat', appState: 0, ...over,
});

/** A clean 20 s scan in stream mode: 62 frames sent (≈ 20 000 / 320), clocks agree, nothing disturbed. */
const good = (over: Partial<ScanMeasurement> = {}): ScanMeasurement => ({
  id: 's1', label: '5 pages', startedAt: '2026-11-03T20:00:00Z', scanWallMs: 20_000,
  before: snap(), after: snap({ framesStreamed: 162, audioOffsetMs: 80_000, wallMs: 1_020_000 }),
  liveStateTransitions: [], maxTimerGapMs: 120, probeBefore: probe(), probeAfter: probe(),
  pages: 5, payloadBytes: 4_000_000, cancelled: false, error: null, webviewReloaded: false, ...over,
});
const failing = (m: ScanMeasurement) => evaluateScan(m).checks.filter((c) => !c.ok && !c.informational).map((c) => c.id);

describe('evaluateScan', () => {
  it('a clean scan passes every check', () => {
    const v = evaluateScan(good());
    expect(v.pass).toBe(true);
    expect(v.checks.every((c) => c.ok)).toBe(true);
  });

  it('a WebView reload fails the scan (the stream would be lost)', () => {
    expect(failing(good({ webviewReloaded: true }))).toContain('webview_stable');
  });

  it('a stream that reconnected during the scan fails, even if it recovered', () => {
    expect(failing(good({ liveStateTransitions: ['reconnecting', 'streaming'] }))).toContain('stream_stayed_connected');
  });

  it('a stream that is not streaming at the end fails', () => {
    expect(failing(good({ after: snap({ liveStreamState: 'failed', framesStreamed: 162, audioOffsetMs: 80_000, wallMs: 1_020_000 }) }))).toContain('stream_stayed_connected');
  });

  it('frames that stop flowing fail: 5 sent where ~62 were expected', () => {
    expect(failing(good({ after: snap({ framesStreamed: 105, audioOffsetMs: 80_000, wallMs: 1_020_000 }) }))).toContain('stream_frames_continuous');
  });

  it('a small frame loss inside the tolerance passes', () => {
    expect(failing(good({ after: snap({ framesStreamed: 100 + 56, audioOffsetMs: 80_000, wallMs: 1_020_000 }) }))).toEqual([]);
  });

  it('an audio clock that lags the wall clock (recording paused for 3 s) fails', () => {
    expect(failing(good({ after: snap({ framesStreamed: 162, audioOffsetMs: 77_000, wallMs: 1_020_000 }) }))).toContain('audio_clock_follows_wall');
  });

  it('a recorder that was paused / interrupted by the system fails', () => {
    expect(failing(good({ after: snap({ state: 'paused', wasInterrupted: true, framesStreamed: 162, audioOffsetMs: 80_000, wallMs: 1_020_000 }) }))).toContain('recorder_not_interrupted');
  });

  it('reports the audio session category / mode / options before and after (informational, never fails the spike)', () => {
    const same = evaluateScan(good({ probeBefore: probe({ categoryOptionsNames: ['allowBluetooth'] }), probeAfter: probe({ categoryOptionsNames: ['allowBluetooth'] }) }));
    const c = same.checks.find((x) => x.id === 'audio_session_config_unchanged')!;
    expect(c).toMatchObject({ ok: true, informational: true });
    expect(c.detail).toContain('playAndRecord · videoChat · [allowBluetooth]');

    for (const changed of [{ category: 'soloAmbient' }, { mode: 'default' }, { categoryOptionsNames: ['mixWithOthers'] }]) {
      const v = evaluateScan(good({ probeBefore: probe({ categoryOptionsNames: ['allowBluetooth'] }), probeAfter: probe({ categoryOptionsNames: ['allowBluetooth'], ...changed }) }));
      const x = v.checks.find((k) => k.id === 'audio_session_config_unchanged')!;
      expect(x.ok).toBe(false);
      expect(x.detail).toContain('before:');
      expect(x.detail).toContain('after:');
      expect(v.pass).toBe(true);        // informational: a change is reported, it does not fail the spike
    }
  });

  it('an iOS audio-session interruption seen by the native probe fails', () => {
    expect(failing(good({ probeAfter: probe({ interruptionBegan: 1 }) }))).toContain('no_audio_session_interruption');
    expect(failing(good({ probeAfter: probe({ mediaServicesResets: 1 }) }))).toContain('no_audio_session_interruption');
  });

  it('losing active state or a stalled JS timer is reported but does NOT fail the scan (informational)', () => {
    const v = evaluateScan(good({ probeAfter: probe({ resignActive: 1 }), maxTimerGapMs: 4_000 }));
    expect(v.pass).toBe(true);
    expect(v.checks.filter((c) => !c.ok).map((c) => c.id).sort()).toEqual(['app_stayed_active', 'webview_timers_not_frozen']);
  });

  it('local-only mode: no stream checks are applied', () => {
    const v = evaluateScan(good({ before: snap({ syncMode: 'local', liveStreamState: 'idle' }), after: snap({ syncMode: 'local', liveStreamState: 'idle', audioOffsetMs: 80_000, wallMs: 1_020_000 }) }));
    expect(v.checks.some((c) => c.id.startsWith('stream_'))).toBe(false);
    expect(v.pass).toBe(true);
  });

  it('a scan error fails; a user cancel does not', () => {
    expect(failing(good({ error: 'Scan already in progress' }))).toContain('scan_completed');
    expect(failing(good({ cancelled: true }))).toEqual([]);
  });
});

function memoryKv(): KeyValueStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

function makeDeps(over: Partial<SpikeDeps> = {}, kv = memoryKv()) {
  let t = 1_000_000; let n = 0;
  const snaps = [snap(), snap({ framesStreamed: 162, audioOffsetMs: 80_000, wallMs: 1_020_000 })];
  let i = 0;
  const deps: SpikeDeps = {
    kv, bootId: 'boot-1', now: () => (t += 10_000), nowIso: () => '2026-11-03T20:00:00Z', newId: () => `id-${++n}`,
    snapStore: async () => snaps[Math.min(i++, 1)],
    watchLiveState: () => () => {},
    scan: async () => ({ pages: [{ index: 0, width: 1, height: 1, data: 'AAAA' }, { index: 1, width: 1, height: 1, data: 'BBBBBB' }] }),
    probe: null,
    ...over,
  };
  return { deps, kv };
}

describe('runInstrumentedScan', () => {
  it('records the scan, its payload and its verdict inputs, and appends it to the persisted log', async () => {
    const { deps, kv } = makeDeps();
    const m = await runInstrumentedScan(deps, '1 page');
    expect(m).toMatchObject({ label: '1 page', pages: 2, payloadBytes: 10, cancelled: false, error: null, webviewReloaded: false });
    expect(readLog(kv)).toHaveLength(1);
  });

  it('writes a pending marker BEFORE scanning and removes it afterwards', async () => {
    const seenDuringScan: Array<string | null> = [];
    const kv = memoryKv();
    const { deps } = makeDeps({ scan: async () => { seenDuringScan.push(kv.getItem('ev_scan_spike_pending')); return { pages: [] }; } }, kv);
    await runInstrumentedScan(deps, 'x');
    expect(seenDuringScan[0]).toContain('"bootId":"boot-1"');
    expect(kv.getItem('ev_scan_spike_pending')).toBeNull();
  });

  it('captures stream-state transitions that happen while the scanner is open', async () => {
    let push: (s: string) => void = () => {};
    const { deps } = makeDeps({
      watchLiveState: (cb) => { push = cb; return () => {}; },
      scan: async () => { push('reconnecting'); push('streaming'); return { pages: [] }; },
    });
    expect((await runInstrumentedScan(deps, 'x')).liveStateTransitions).toEqual(['reconnecting', 'streaming']);
  });

  it('a user cancel and a plugin error are recorded, not thrown', async () => {
    expect((await runInstrumentedScan(makeDeps({ scan: async () => null }).deps, 'x')).cancelled).toBe(true);
    const m = await runInstrumentedScan(makeDeps({ scan: async () => { throw new Error('boom'); } }).deps, 'x');
    expect(m.error).toBe('boom');
  });

  it('works without the native probe', async () => {
    const m = await runInstrumentedScan(makeDeps({ probe: null }).deps, 'x');
    expect(m.probeBefore).toBeNull();
  });

  it('takes native probe snapshots before and after', async () => {
    let calls = 0;
    const { deps } = makeDeps({ probe: { start: async () => ({}), snapshot: async () => probe({ resignActive: calls++ }) } });
    const m = await runInstrumentedScan(deps, 'x');
    expect(m.probeBefore?.resignActive).toBe(0);
    expect(m.probeAfter?.resignActive).toBe(1);
  });
});

describe('recoverInterruptedScan — the WebView did not survive the scan', () => {
  it('a pending marker from ANOTHER boot is logged as a reload (the crash signature)', async () => {
    const kv = memoryKv();
    const reload = new Promise<void>(() => {});          // the scan promise that never comes back
    const { deps } = makeDeps({ scan: () => reload.then(() => null) }, kv);
    void runInstrumentedScan(deps, '10 pages');
    await vi.waitFor(() => expect(kv.getItem('ev_scan_spike_pending')).not.toBeNull());

    // ... the WebView reloads: module state is gone, only storage remains, and the boot id changed.
    const lost = recoverInterruptedScan(kv, 'boot-2');

    expect(lost).toMatchObject({ label: '10 pages', webviewReloaded: true, error: expect.stringContaining('reloaded') });
    expect(readLog(kv).at(-1)?.webviewReloaded).toBe(true);
    expect(failing(lost!)).toContain('webview_stable');
    expect(kv.getItem('ev_scan_spike_pending')).toBeNull();
  });

  it('a marker from the SAME boot is not a crash', () => {
    const kv = memoryKv();
    kv.setItem('ev_scan_spike_pending', JSON.stringify({ id: 'a', label: 'x', startedAt: '2026-11-03T20:00:00Z', bootId: 'boot-1', before: snap() }));
    expect(recoverInterruptedScan(kv, 'boot-1')).toBeNull();
  });

  it('nothing pending, or garbage in storage, is harmless', () => {
    const kv = memoryKv();
    expect(recoverInterruptedScan(kv, 'b')).toBeNull();
    kv.setItem('ev_scan_spike_pending', '{not json');
    expect(recoverInterruptedScan(kv, 'b')).toBeNull();
    expect(kv.getItem('ev_scan_spike_pending')).toBeNull();
  });
});

describe('startHeartbeat', () => {
  it('reports the longest stall of the JS thread beyond the 100 ms tick', () => {
    vi.useFakeTimers();
    const hb = startHeartbeat(Date.now);
    vi.advanceTimersByTime(300);
    vi.setSystemTime(Date.now() + 2_000);                 // the WebView was frozen for 2 s
    vi.advanceTimersByTime(100);
    const max = hb.stop();
    vi.useRealTimers();
    expect(max).toBeGreaterThanOrEqual(1_900);
  });
});

describe('buildReport', () => {
  it('lists each scan with its audio window (for the audio analysis) and its verdict', () => {
    const report = JSON.parse(buildReport([good()]));
    expect(report.scans[0]).toMatchObject({ label: '5 pages', mode: 'stream', audioWindowMs: [60_000, 80_000], verdict: { pass: true } });
  });
});
