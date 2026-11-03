<!-- ScanSpikePanel — TEMPORARY test tool for the "Scan a document" audio spike (iOS app only).
     Shown on the record screen while recording/paused, only when enabled in Settings › Diagnostics.
     Runs DocScan's native scanner in its isolated window and measures what the app can see meanwhile. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { registerPlugin } from '@capacitor/core';
  import { isNative } from '$lib/platform';
  import { langStore } from '$lib/i18n/index';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import {
    runInstrumentedScan, recoverInterruptedScan, readLog, clearLog, evaluateScan, buildReport,
    type ScanMeasurement, type ScanPage, type ProbeSnap,
  } from '$lib/recorder/scan/spike/scanSpike';

  const scanner = registerPlugin<{ scan(): Promise<{ pages: ScanPage[] }> }>('DocumentScannerPlugin');
  const probe   = registerPlugin<{ start(): Promise<unknown>; snapshot(): Promise<ProbeSnap> }>('ScanSpikeProbePlugin');

  let isFr = $derived($langStore === 'fr');
  let enabled = $state(false);
  let running = $state(false);
  let log = $state<ScanMeasurement[]>([]);
  let copied = $state(false);
  let report = $state('');

  const kv = {
    getItem: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* */ } },
    removeItem: (k: string) => { try { localStorage.removeItem(k); } catch { /* */ } },
  };
  const bootId = String(typeof performance !== 'undefined' ? performance.timeOrigin : Date.now());

  onMount(() => {
    enabled = isNative() && kv.getItem('ev_scan_spike') === '1';
    if (!enabled) return;
    recoverInterruptedScan(kv, bootId);       // a scan the WebView did not survive shows up as a reload
    log = readLog(kv);
  });

  async function run(label: string) {
    running = true; copied = false; report = '';
    try {
      await runInstrumentedScan({
        kv, bootId, now: Date.now, nowIso: () => new Date().toISOString(),
        newId: () => crypto.randomUUID(),
        snapStore: async () => {
          const s = get(recorderStore);
          return {
            state: s.state, syncMode: s.syncMode, liveStreamState: s.liveStreamState, framesStreamed: s.framesStreamed,
            wasInterrupted: s.wasInterrupted, audioOffsetMs: await recorderStore.getCaptureOffsetMs(), wallMs: Date.now(),
          };
        },
        watchLiveState: (cb) => {
          let last = get(recorderStore).liveStreamState;
          return recorderStore.subscribe((s) => { if (s.liveStreamState !== last) { last = s.liveStreamState; cb(s.liveStreamState); } });
        },
        scan: async () => {
          try { return await scanner.scan(); }
          catch (e) { if (e instanceof Error && e.message === 'Cancelled') return null; throw e; }
        },
        probe: { start: () => probe.start(), snapshot: () => probe.snapshot() },
      }, label);
    } finally {
      log = readLog(kv);
      running = false;
    }
  }

  async function copyReport() {
    report = buildReport(log);
    try { await navigator.clipboard.writeText(report); copied = true; } catch { copied = false; }   // falls back to the visible text
  }

  function reset() { clearLog(kv); log = []; report = ''; copied = false; }

  let last = $derived(log.at(-1) ?? null);
  let verdict = $derived(last ? evaluateScan(last) : null);
</script>

{#if enabled}
  <section class="spike" aria-label="Scan spike">
    <header>
      <strong>{isFr ? 'TEST SCAN (spike)' : 'SCAN TEST (spike)'}</strong>
      <span class="tag">{isFr ? 'temporaire' : 'temporary'}</span>
    </header>
    <p class="hint">{isFr
      ? 'Le record continue. Scannez le nombre de pages indiqué, puis touchez « Enregistrer » dans le scanner.'
      : 'The record keeps running. Scan the number of pages shown, then tap “Save” in the scanner.'}</p>
    <div class="btns">
      {#each ['1', '5', '10'] as n}
        <button type="button" disabled={running} onclick={() => run(`${n} ${isFr ? 'page(s)' : 'page(s)'}`)}>{n} {isFr ? 'p.' : 'p.'}</button>
      {/each}
    </div>

    {#if running}<p class="run">{isFr ? 'Scan en cours…' : 'Scanning…'}</p>{/if}

    {#if last && verdict}
      <div class="result" class:ok={verdict.pass} class:ko={!verdict.pass}>
        <strong>{verdict.pass ? '✓' : '✗'} {last.label} · {last.before.syncMode} · {(last.scanWallMs / 1000).toFixed(1)} s</strong>
        <ul>
          {#each verdict.checks as c}
            <li class:bad={!c.ok} class:info={c.informational}>{c.ok ? '✓' : (c.informational ? '·' : '✗')} {c.id} — {c.detail}</li>
          {/each}
        </ul>
      </div>
    {/if}

    <footer>
      <span>{log.length} scan(s)</span>
      <button type="button" onclick={copyReport} disabled={log.length === 0}>{copied ? (isFr ? 'Copié ✓' : 'Copied ✓') : (isFr ? 'Copier le rapport' : 'Copy report')}</button>
      <button type="button" onclick={reset} disabled={log.length === 0}>{isFr ? 'Effacer' : 'Clear'}</button>
    </footer>
    {#if report && !copied}<textarea readonly rows="6" value={report}></textarea>{/if}
  </section>
{/if}

<style>
  .spike { width: calc(100% - 2 * var(--sp-4)); margin: 0 var(--sp-4); padding: 12px; border: 1px dashed var(--ev-orange); border-radius: 12px; background: rgba(245,158,11,0.05); display: flex; flex-direction: column; gap: 8px; font-size: 0.8rem; color: var(--ev-text); }
  header { display: flex; align-items: center; gap: 8px; }
  .tag { font-size: 0.68rem; color: var(--ev-orange); border: 1px solid var(--ev-orange); border-radius: 999px; padding: 1px 8px; }
  .hint, .run { margin: 0; color: var(--ev-text-dim); }
  .btns { display: flex; gap: 8px; }
  button { padding: 8px 14px; border-radius: 10px; border: 1px solid var(--ev-border); background: var(--ev-surface); color: var(--ev-blue); font-family: var(--font-sans); font-weight: 700; cursor: pointer; }
  button:disabled { opacity: 0.5; }
  .result { padding: 8px 10px; border-radius: 10px; border: 1px solid; }
  .result.ok { border-color: rgba(70,167,88,0.5); } .result.ko { border-color: rgba(229,72,77,0.6); }
  ul { margin: 6px 0 0; padding-left: 0; list-style: none; font-family: var(--font-mono); font-size: 0.7rem; line-height: 1.5; }
  li.bad { color: var(--ev-danger); } li.info { color: var(--ev-text-dim); }
  footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  textarea { width: 100%; font-family: var(--font-mono); font-size: 0.65rem; background: var(--ev-black); color: var(--ev-text); border: 1px solid var(--ev-border); border-radius: 8px; }
</style>
