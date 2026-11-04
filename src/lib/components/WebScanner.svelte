<!-- WebScanner — "Scan a document" in the PWA / browser. The DocScan web scanner (scanner-app, scan page) in Pocket:
     live viewfinder with edge detection, capture, perspective correction + enhancement in a Web Worker, optional manual
     corners, page strip. It only collects pages: the engine (webScanEngine.ts) turns them into the PDF.

     The microphone is never requested here (camera.ts asks for video only) and there is no shutter sound: the record
     is running and its audio must not be touched or fed back. -->
<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { t, langStore } from '$lib/i18n/index';
  import { CameraService } from '$lib/recorder/scan/web/camera';
  import { PipelineClient } from '$lib/recorder/scan/web/workers/client';
  import { getOpenCVDetector } from '$lib/recorder/scan/web/cv/opencv-client';
  import { toGrayscale, detectEdgesFromGray } from '$lib/recorder/scan/web/cv/edges';
  import { findDocumentQuad, scaleQuad } from '$lib/recorder/scan/web/cv/quad';
  import { processCapture, plainQuad, guideQuad, WEB_PIPELINE_SETTINGS, type ProcessorDeps } from '$lib/recorder/scan/web/scanProcessor';
  import { downscale, rotateCW90, imageDataToBlob } from '$lib/recorder/scan/web/imageUtils';
  import { registerWebScannerHost } from '$lib/recorder/scan/web/webScannerHost';
  import type { ScannedPage } from '$lib/recorder/scan/web/pdf';
  import type { Quad } from '$lib/recorder/scan/web/types';
  import CropOverlay from './CropOverlay.svelte';

  const tr = $derived.by(() => { $langStore; return t().attachments; });

  // Threshold bias for the Otsu detector (DocScan): -30 aggressive … +20 strict.
  const SENSITIVITIES = [
    { key: 'precise', bias: 20 }, { key: 'auto', bias: 0 }, { key: 'sensitive', bias: -30 },
  ] as const;

  type LightQuality = 'dark' | 'dim' | 'good' | 'bright';
  interface Slot { id: number; state: 'processing' | 'done' | 'failed'; page?: ScannedPage; url?: string }

  let open = $state(false);
  let videoEl = $state<HTMLVideoElement | undefined>(undefined);
  let overlayEl = $state<HTMLCanvasElement | undefined>(undefined);
  let slots = $state<Slot[]>([]);
  let error = $state('');
  let aiStatus = $state('');
  let flash = $state(false);
  let cropMode = $state(false);
  let detectionEnabled = $state(true);
  let sensitivityIdx = $state(1);
  let lightQuality = $state<LightQuality | null>(null);
  let hasTorch = $state(false);
  let torchOn = $state(false);
  let pendingImage = $state<ImageData | null>(null);
  let pendingQuad = $state<Quad | null>(null);
  let confirmAbandon = $state(false);
  let cameraReady = $state(false);

  let cam: CameraService | null = null;
  let pipeline: PipelineClient | null = null;
  let detectedQuad: Quad | null = null;
  let detectionTimer: ReturnType<typeof setTimeout> | null = null;
  let detectionRunning = false;
  let nextId = 1;
  let settle: ((pages: ScannedPage[] | null) => void) | null = null;

  const processing = $derived(slots.filter((s) => s.state === 'processing').length);
  const donePages = $derived(slots.filter((s) => s.state === 'done'));
  const threshBias = $derived(SENSITIVITIES[sensitivityIdx]!.bias);

  // The engine asks this component to open; it answers with the pages (or null if abandoned).
  const unregister = registerWebScannerHost({
    open() {
      return new Promise<ScannedPage[] | null>((resolve) => { settle = resolve; void begin(); });
    },
  });
  onDestroy(() => { unregister(); teardown(); settle?.(null); settle = null; });

  async function begin() {
    slots = []; error = ''; pendingImage = null; pendingQuad = null; confirmAbandon = false; torchOn = false; cameraReady = false;
    open = true;
    await tick();
    pipeline = new PipelineClient();
    cam = new CameraService();
    try {
      const stream = await cam.start();
      if (!videoEl) return;
      videoEl.srcObject = stream;
      await videoEl.play();
      hasTorch = cam.hasTorch();
      cameraReady = true;
      startDetection();
    } catch (e) {
      console.warn('[WebScanner] camera failed —', e);
      error = tr.webScanCameraError;
    }
  }

  function teardown() {
    stopDetection();
    cam?.stop(); cam = null;
    pipeline?.destroy(); pipeline = null;
    for (const s of slots) if (s.url) URL.revokeObjectURL(s.url);
  }

  function close(result: ScannedPage[] | null) {
    const done = settle; settle = null;
    teardown();
    slots = []; open = false; pendingImage = null; pendingQuad = null; cameraReady = false;
    done?.(result);
  }

  // ── Live detection overlay (DocScan's JS detector; no native detector in the browser) ───────────
  function startDetection() { detectionRunning = true; void scheduleDetection(); }
  function stopDetection() {
    detectionRunning = false;
    if (detectionTimer) { clearTimeout(detectionTimer); detectionTimer = null; }
    overlayEl?.getContext('2d')?.clearRect(0, 0, overlayEl.width, overlayEl.height);
    lightQuality = null; detectedQuad = null;
  }
  async function scheduleDetection() {
    if (!detectionRunning || !videoEl?.videoWidth) { if (detectionRunning) detectionTimer = setTimeout(scheduleDetection, 300); return; }
    if (detectionEnabled) { try { runDetectionTick(); } catch { /* non-fatal */ } }
    else { detectedQuad = null; drawOverlay(); }
    if (detectionRunning) detectionTimer = setTimeout(scheduleDetection, 300);
  }
  function measureLuminosity(img: ImageData): LightQuality {
    const d = img.data; let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
    const avg = sum / (d.length / 4);
    return avg < 45 ? 'dark' : avg < 95 ? 'dim' : avg > 215 ? 'bright' : 'good';
  }
  function runDetectionTick() {
    if (!videoEl?.videoWidth || !cam) return;
    const procImg = cam.grabVideoFrame(videoEl, 640);
    const { width, height } = procImg;
    lightQuality = measureLuminosity(procImg);
    const gray = toGrayscale(procImg);
    const edges = detectEdgesFromGray(gray, width, height);
    const raw = findDocumentQuad(gray, edges, width, height, threshBias);
    const quadScale = width / videoEl.videoWidth;                       // scaleQuad DIVIDES: detection space → video space
    detectedQuad = raw ? (quadScale < 1 ? scaleQuad(raw, quadScale) : raw) : null;
    drawOverlay();
  }
  function drawOverlay() {
    if (!overlayEl || !videoEl) return;
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    const cw = overlayEl.clientWidth || overlayEl.width, ch = overlayEl.clientHeight || overlayEl.height;
    overlayEl.width = cw; overlayEl.height = ch;
    const ctx = overlayEl.getContext('2d')!;
    ctx.clearRect(0, 0, cw, ch);
    const s = Math.max(cw / vw, ch / vh);                                // object-fit: cover
    ctx.setTransform(s, 0, 0, s, (cw - vw * s) / 2, (ch - vh * s) / 2);
    if (detectedQuad) {
      const q = detectedQuad;
      ctx.beginPath(); ctx.moveTo(q.tl.x, q.tl.y); ctx.lineTo(q.tr.x, q.tr.y); ctx.lineTo(q.br.x, q.br.y); ctx.lineTo(q.bl.x, q.bl.y); ctx.closePath();
      ctx.fillStyle = 'rgba(255,59,48,0.08)'; ctx.fill();
      ctx.strokeStyle = '#ff3b30'; ctx.lineWidth = 3 / s; ctx.lineJoin = 'round'; ctx.stroke();
      ctx.fillStyle = '#ff3b30';
      for (const pt of [q.tl, q.tr, q.br, q.bl]) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 7 / s, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.resetTransform();
  }

  // ── Capture ─────────────────────────────────────────────────────────────────────────────────────
  function capture() {
    if (!videoEl || !cam || !pipeline || pendingImage) return;
    flash = true; setTimeout(() => { flash = false; }, 220);            // visual only: no sound while a record is running
    // Same coordinate space as the viewfinder quad (grabVideoFrame, not ImageCapture.takePhoto): see DocScan's note.
    const image = cam.grabVideoFrame(videoEl, 2048);
    const k = videoEl.videoWidth ? image.width / videoEl.videoWidth : 1;
    const q = detectedQuad;
    const imageQuad: Quad = q
      ? { tl: { x: q.tl.x * k, y: q.tl.y * k }, tr: { x: q.tr.x * k, y: q.tr.y * k }, br: { x: q.br.x * k, y: q.br.y * k }, bl: { x: q.bl.x * k, y: q.bl.y * k } }
      : guideQuad(image.width, image.height);
    if (cropMode) { pendingImage = image; pendingQuad = plainQuad(imageQuad); return; }
    void process(image, imageQuad);
  }
  function onCropConfirm(q: Quad) {
    const image = pendingImage; pendingImage = null; pendingQuad = null;
    if (image) void process(image, plainQuad(q));
  }
  function onCropCancel() { pendingImage = null; pendingQuad = null; }

  async function process(image: ImageData, viewfinderQuad: Quad) {
    const p = pipeline; if (!p) return;
    const slot: Slot = { id: nextId++, state: 'processing' };
    slots = [...slots, slot];                                            // reserved now: pages keep the order they were shot in
    const deps: ProcessorDeps = {
      detect: (img) => getOpenCVDetector().detect(img),
      runPipeline: async (frame, quad) => (await p.process(frame, WEB_PIPELINE_SETTINGS, undefined, quad)).image,
      downscale, rotateCW90,
      toJpeg: (img, quality) => imageDataToBlob(img, 'image/jpeg', quality),
      now: Date.now,
      timeout: (ms, fallback) => new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
    };
    aiStatus = tr.webScanAnalyzing;
    try {
      const page = await processCapture(deps, image, viewfinderQuad);
      const url = page.thumbnail ? URL.createObjectURL(page.thumbnail) : undefined;
      slots = slots.map((s) => (s.id === slot.id ? { ...s, state: 'done', page: { blob: page.blob, width: page.width, height: page.height, thumbnail: page.thumbnail }, url } : s));
    } catch (e) {
      console.warn('[WebScanner] page failed —', e);
      slots = slots.map((s) => (s.id === slot.id ? { ...s, state: 'failed' } : s));
      error = tr.webScanProcessError;
      setTimeout(() => { slots = slots.filter((s) => s.state !== 'failed'); error = ''; }, 2500);
    } finally {
      if (!slots.some((s) => s.state === 'processing')) aiStatus = '';
    }
  }

  function removeSlot(id: number) {
    const s = slots.find((x) => x.id === id);
    if (s?.url) URL.revokeObjectURL(s.url);
    slots = slots.filter((x) => x.id !== id);
  }

  async function finish() {
    while (slots.some((s) => s.state === 'processing')) await new Promise((r) => setTimeout(r, 150));
    const pages = slots.filter((s) => s.state === 'done' && s.page).map((s) => s.page!);
    close(pages.length ? pages : null);
  }

  function back() {
    if (slots.length > 0) { confirmAbandon = true; return; }              // abandon confirmation: pages would be lost
    close(null);
  }

  async function toggleTorch() { torchOn = !torchOn; await cam?.setTorch(torchOn); }

  const lightText = $derived(lightQuality === 'dark' ? tr.webScanLightDark : lightQuality === 'dim' ? tr.webScanLightDim : lightQuality === 'bright' ? tr.webScanLightBright : tr.webScanLightGood);
</script>

{#if open}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={tr.scan}>
    <!-- svelte-ignore a11y_media_has_caption -->
    <video bind:this={videoEl} playsinline muted autoplay></video>
    <canvas bind:this={overlayEl} class="overlay" aria-hidden="true"></canvas>
    <div class="flash" class:active={flash} aria-hidden="true"></div>

    {#if error}<div class="error" role="alert">{error}</div>{/if}
    {#if !error && slots.length === 0}<p class="hint">{tr.webScanHint}</p>{/if}

    <div class="hud">
      <div class="ctrl-bar">
        {#if lightQuality}<div class="light" data-q={lightQuality}><span class="dot"></span>{lightText}</div>{/if}
        <div class="ctrl-group">
          <button type="button" class="chip" class:active={cropMode} onclick={() => { cropMode = !cropMode; }}>{cropMode ? tr.webScanCorrectionOn : tr.webScanCorrection}</button>
          <button type="button" class="chip det" class:active={detectionEnabled} class:off={!detectionEnabled} onclick={() => { detectionEnabled = !detectionEnabled; }}>{detectionEnabled ? tr.webScanDetectionOn : tr.webScanDetectionOff}</button>
          {#if detectionEnabled}
            {#each SENSITIVITIES as s, i (s.key)}
              <button type="button" class="chip" class:active={sensitivityIdx === i} onclick={() => { sensitivityIdx = i; }}>{s.key === 'precise' ? tr.webScanPrecise : s.key === 'auto' ? tr.webScanAuto : tr.webScanSensitive}</button>
            {/each}
          {/if}
        </div>
      </div>

      {#if slots.length > 0}
        <div class="thumbstrip">
          {#each slots as s, i (s.id)}
            <div class="thumb" class:processing={s.state === 'processing'} class:failed={s.state === 'failed'}>
              {#if s.url}<img src={s.url} alt="" />{:else if s.state === 'processing'}<span class="spin"></span>{/if}
              {#if s.state === 'done'}
                <span class="num">{donePages.findIndex((d) => d.id === s.id) + 1}</span>
                <button type="button" class="del" onclick={() => removeSlot(s.id)} aria-label={tr.webScanRemovePage(i + 1)}>×</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
      {#if aiStatus}<div class="ai">{aiStatus}</div>{/if}

      <div class="actions">
        <button type="button" class="pill" onclick={back}>{tr.back}</button>
        {#if hasTorch}<button type="button" class="pill icon" onclick={toggleTorch} aria-label={tr.webScanTorch}>{torchOn ? '🔦' : '💡'}</button>{/if}
        <button type="button" class="shutter" onclick={capture} disabled={!cameraReady || !!pendingImage} aria-label={tr.webScanCapture}></button>
        <button type="button" class="pill primary" onclick={finish} disabled={slots.length === 0}>
          {#if processing > 0}<span class="spin small"></span>{/if}{tr.webScanDone(slots.filter((s) => s.state !== 'failed').length)}
        </button>
      </div>
    </div>

    {#if confirmAbandon}
      <div class="confirm-bg" role="presentation">
        <div class="confirm" role="alertdialog" aria-modal="true" aria-label={tr.webScanAbandonTitle(slots.length)}>
          <h3>{tr.webScanAbandonTitle(slots.length)}</h3>
          <p>{tr.webScanAbandonBody}</p>
          <div class="confirm-actions">
            <button type="button" class="pill" onclick={() => { confirmAbandon = false; }}>{tr.webScanKeep}</button>
            <button type="button" class="pill danger" onclick={() => { confirmAbandon = false; close(null); }}>{tr.webScanAbandon}</button>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if pendingImage && pendingQuad}
    <CropOverlay image={pendingImage} initialQuad={pendingQuad} onConfirm={onCropConfirm} onCancel={onCropCancel} />
  {/if}
{/if}

<style>
  .viewer { position: fixed; inset: 0; z-index: 1000; background: #000; display: grid; grid-template-rows: 1fr; color: #fff; font-family: var(--font-sans); }
  video { width: 100%; height: 100%; object-fit: cover; grid-area: 1/1; }
  .overlay { grid-area: 1/1; position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .flash { position: absolute; inset: 0; background: #fff; opacity: 0; pointer-events: none; }
  .flash.active { animation: flash 0.25s ease-out forwards; }
  @keyframes flash { 0% { opacity: 0.85; } 100% { opacity: 0; } }
  .hint { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 16px); left: 16px; right: 16px; margin: 0; text-align: center; font-size: 0.85rem; color: rgba(255,255,255,0.85); text-shadow: 0 1px 3px rgba(0,0,0,0.8); }
  .error { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 60px); left: 50%; transform: translateX(-50%); background: #dc2626; padding: 10px 18px; border-radius: 14px; font-size: 0.85rem; max-width: 90vw; text-align: center; }

  .hud { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; background: linear-gradient(to top, rgba(0,0,0,0.78) 0%, transparent 100%); padding-bottom: env(safe-area-inset-bottom, 12px); }
  .ctrl-bar { display: flex; flex-direction: column; gap: 5px; padding: 6px 16px; }
  .ctrl-group { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .chip { background: rgba(0,0,0,0.45); border: 1px solid rgba(255,255,255,0.2); color: rgba(255,255,255,0.7); border-radius: 999px; padding: 4px 11px; font-size: 0.75rem; backdrop-filter: blur(8px); cursor: pointer; }
  .chip.active { background: rgba(154,209,255,0.2); border-color: #9ad1ff; color: #9ad1ff; font-weight: 600; }
  .chip.det.off { background: rgba(229,72,77,0.15); border-color: rgba(229,72,77,0.5); color: rgba(229,72,77,0.85); }
  .light { align-self: flex-start; display: flex; align-items: center; gap: 6px; font-size: 0.72rem; background: rgba(0,0,0,0.5); padding: 3px 10px; border-radius: 999px; }
  .light .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ecf8e; }
  .light[data-q='dark'] .dot, .light[data-q='bright'] .dot { background: #e5484d; }
  .light[data-q='dim'] .dot { background: #f59e0b; }

  .thumbstrip { display: flex; gap: 8px; overflow-x: auto; padding: 6px 16px; scrollbar-width: none; }
  .thumbstrip::-webkit-scrollbar { display: none; }
  .thumb { position: relative; flex-shrink: 0; width: 52px; height: 68px; border-radius: 6px; overflow: hidden; border: 2px solid rgba(255,255,255,0.35); background: #222; display: grid; place-items: center; }
  .thumb.processing { border: 1px dashed rgba(154,209,255,0.4); background: rgba(154,209,255,0.08); }
  .thumb.failed { border-color: #e5484d; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; }
  .num { position: absolute; bottom: 2px; right: 4px; font-size: 10px; font-weight: 700; text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
  .del { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; background: rgba(0,0,0,0.65); border: none; border-radius: 50%; color: #fff; font-size: 12px; line-height: 1; padding: 0; cursor: pointer; display: grid; place-items: center; }
  .ai { text-align: center; font-size: 0.72rem; color: #9ad1ff; letter-spacing: 0.06em; padding: 4px 0 0; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }

  .actions { display: flex; align-items: center; justify-content: space-between; padding: 10px 20px 14px; gap: 12px; }
  .pill { background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.25); border-radius: 999px; padding: 10px 16px; font-size: 0.9rem; white-space: nowrap; backdrop-filter: blur(8px); cursor: pointer; font-family: var(--font-sans); }
  .pill.primary { background: #9ad1ff; color: #000; border-color: transparent; font-weight: 700; }
  .pill.danger { background: #e5484d; border-color: transparent; font-weight: 700; }
  .pill:disabled { opacity: 0.4; }
  .shutter { width: 72px; height: 72px; border-radius: 50%; background: #fff; border: 4px solid rgba(255,255,255,0.45); box-shadow: 0 0 0 3px rgba(255,255,255,0.2); flex-shrink: 0; cursor: pointer; transition: transform 0.08s; }
  .shutter:active:not(:disabled) { transform: scale(0.88); }
  .shutter:disabled { opacity: 0.6; }
  .spin { width: 20px; height: 20px; border: 2px solid rgba(154,209,255,0.25); border-top-color: #9ad1ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .spin.small { display: inline-block; width: 14px; height: 14px; margin-right: 6px; vertical-align: middle; border-color: rgba(0,0,0,0.2); border-top-color: #000; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .confirm-bg { position: absolute; inset: 0; background: rgba(0,0,0,0.7); display: grid; place-items: center; padding: 24px; }
  .confirm { background: var(--ev-surface, #151515); border: 1px solid var(--ev-border, #333); border-radius: 18px; padding: 20px; max-width: 360px; width: 100%; }
  .confirm h3 { margin: 0 0 6px; font-size: 1.1rem; }
  .confirm p { margin: 0 0 16px; color: rgba(255,255,255,0.7); font-size: 0.9rem; }
  .confirm-actions { display: flex; gap: 10px; justify-content: flex-end; }
</style>
