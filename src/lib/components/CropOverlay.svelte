<script lang="ts">
  /**
   * Manual crop overlay.
   * Shows the captured image with 4 draggable corner handles so the user
   * can correct the document boundary before processing.
   */
  import { onMount } from 'svelte';
  import type { Quad } from '../recorder/scan/web/types.js';
  import { t, langStore } from '$lib/i18n/index';

  interface Props {
    image: ImageData;
    initialQuad: Quad;
    onConfirm: (quad: Quad) => void;
    onCancel: () => void;
  }
  let { image, initialQuad, onConfirm, onCancel }: Props = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });

  let canvasEl: HTMLCanvasElement;

  // Corner handles in CANVAS pixel coordinates (display space)
  // Order: TL, TR, BR, BL — always 4 elements
  let cx: [number, number, number, number] = $state([0, 0, 0, 0]);
  let cy: [number, number, number, number] = $state([0, 0, 0, 0]);

  let scale = 1;
  let offX = 0;
  let offY = 0;
  let activeIdx = -1;
  let imgBitmap: ImageBitmap;

  // Map image coords → canvas display coords
  function imgToCanvas(x: number, y: number): [number, number] {
    return [x * scale + offX, y * scale + offY];
  }
  // Map canvas display coords → image coords
  function canvasToImg(x: number, y: number): [number, number] {
    return [(x - offX) / scale, (y - offY) / scale];
  }

  onMount(async () => {
    imgBitmap = await createImageBitmap(image);
    resize();
  });

  function resize() {
    if (!canvasEl) return;
    const maxW = canvasEl.clientWidth  || window.innerWidth;
    const maxH = canvasEl.clientHeight || window.innerHeight;
    canvasEl.width  = maxW;
    canvasEl.height = maxH;

    const sx = maxW / image.width;
    const sy = maxH / image.height;
    scale = Math.min(sx, sy) * 0.92; // leave a small margin
    offX  = (maxW - image.width  * scale) / 2;
    offY  = (maxH - image.height * scale) / 2;

    // Place handles at initialQuad positions
    const tl = imgToCanvas(initialQuad.tl.x, initialQuad.tl.y);
    const tr = imgToCanvas(initialQuad.tr.x, initialQuad.tr.y);
    const br = imgToCanvas(initialQuad.br.x, initialQuad.br.y);
    const bl = imgToCanvas(initialQuad.bl.x, initialQuad.bl.y);
    cx = [tl[0], tr[0], br[0], bl[0]];
    cy = [tl[1], tr[1], br[1], bl[1]];

    draw();
  }

  function draw() {
    if (!canvasEl || !imgBitmap) return;
    const ctx = canvasEl.getContext('2d')!;
    const W = canvasEl.width, H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);

    // Image
    ctx.drawImage(imgBitmap, offX, offY, image.width * scale, image.height * scale);

    // Dark overlay outside quad
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.moveTo(cx[0], cy[0]);
    ctx.lineTo(cx[1], cy[1]);
    ctx.lineTo(cx[2], cy[2]);
    ctx.lineTo(cx[3], cy[3]);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');
    ctx.restore();

    // Quad border
    ctx.beginPath();
    ctx.moveTo(cx[0], cy[0]);
    ctx.lineTo(cx[1], cy[1]);
    ctx.lineTo(cx[2], cy[2]);
    ctx.lineTo(cx[3], cy[3]);
    ctx.closePath();
    ctx.strokeStyle = '#9ad1ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Grid inside quad (thirds)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx[0], cy[0]);
    ctx.lineTo(cx[1], cy[1]);
    ctx.lineTo(cx[2], cy[2]);
    ctx.lineTo(cx[3], cy[3]);
    ctx.closePath();
    ctx.clip();
    ctx.strokeStyle = 'rgba(154,209,255,0.2)';
    ctx.lineWidth = 1;
    for (let t = 1; t <= 2; t++) {
      const f = t / 3;
      ctx.beginPath();
      ctx.moveTo(cx[0] + (cx[1] - cx[0]) * f, cy[0] + (cy[1] - cy[0]) * f);
      ctx.lineTo(cx[3] + (cx[2] - cx[3]) * f, cy[3] + (cy[2] - cy[3]) * f);
      ctx.moveTo(cx[0] + (cx[3] - cx[0]) * f, cy[0] + (cy[3] - cy[0]) * f);
      ctx.lineTo(cx[1] + (cx[2] - cx[1]) * f, cy[1] + (cy[2] - cy[1]) * f);
      ctx.stroke();
    }
    ctx.restore();

    // Corner handles
    const LABELS = ['TL', 'TR', 'BR', 'BL'];
    for (let i = 0; i < 4; i++) {
      const hx = cx[i]!, hy = cy[i]!;
      ctx.beginPath();
      ctx.arc(hx, hy, 22, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(154,209,255,0.15)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(hx, hy, 13, 0, Math.PI * 2);
      ctx.fillStyle = '#9ad1ff';
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#0a0a0a';
      ctx.font = 'bold 9px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LABELS[i]!, hx, hy);
    }
  }

  function hitTest(x: number, y: number): number {
    for (let i = 0; i < 4; i++) {
      const dx = cx[i]! - x, dy = cy[i]! - y;
      if (Math.hypot(dx, dy) < 36) return i;
    }
    return -1;
  }

  function clientPos(e: TouchEvent | MouseEvent): [number, number] {
    const r = canvasEl.getBoundingClientRect();
    const src = 'touches' in e ? e.touches[0] ?? e.changedTouches[0] : e;
    return [src!.clientX - r.left, src!.clientY - r.top];
  }

  function onDown(e: TouchEvent | MouseEvent) {
    e.preventDefault();
    const [x, y] = clientPos(e);
    activeIdx = hitTest(x, y);
  }

  function onMove(e: TouchEvent | MouseEvent) {
    if (activeIdx < 0) return;
    e.preventDefault();
    const [x, y] = clientPos(e);
    cx = cx.map((v, i) => i === activeIdx ? Math.max(0, Math.min(canvasEl.width,  x)) : v) as typeof cx;
    cy = cy.map((v, i) => i === activeIdx ? Math.max(0, Math.min(canvasEl.height, y)) : v) as typeof cy;
    draw();
  }

  function onUp() { activeIdx = -1; }

  function confirm() {
    const quad: Quad = {
      tl: { x: canvasToImg(cx[0], cy[0])[0], y: canvasToImg(cx[0], cy[0])[1] },
      tr: { x: canvasToImg(cx[1], cy[1])[0], y: canvasToImg(cx[1], cy[1])[1] },
      br: { x: canvasToImg(cx[2], cy[2])[0], y: canvasToImg(cx[2], cy[2])[1] },
      bl: { x: canvasToImg(cx[3], cy[3])[0], y: canvasToImg(cx[3], cy[3])[1] },
    };
    onConfirm(quad);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="crop-root">
  <canvas
    bind:this={canvasEl}
    class="crop-canvas"
    ontouchstart={onDown}
    ontouchmove={onMove}
    ontouchend={onUp}
    onmousedown={onDown}
    onmousemove={onMove}
    onmouseup={onUp}
  ></canvas>

  <div class="crop-top">
    <p class="crop-hint">{tr.cropHint}</p>
  </div>

  <div class="crop-bottom">
    <button class="crop-cancel" onclick={onCancel}>
      {tr.cropRetake}
    </button>
    <button class="crop-confirm" onclick={confirm}>
      {tr.cropConfirm}
    </button>
  </div>
</div>

<style>
  .crop-root {
    position: fixed;
    inset: 0;
    z-index: 1100;
    background: #000;
    display: grid;
    grid-template-rows: auto 1fr auto;
  }

  .crop-canvas {
    grid-row: 1 / -1;
    grid-column: 1;
    width: 100%;
    height: 100%;
    touch-action: none;
    display: block;
  }

  .crop-top, .crop-bottom {
    grid-column: 1;
    pointer-events: none;
    z-index: 1;
  }
  .crop-top {
    grid-row: 1;
    padding: 14px 16px 0;
  }
  .crop-bottom {
    grid-row: 3;
    display: flex;
    gap: 12px;
    padding: 12px 16px calc(env(safe-area-inset-bottom, 12px) + 12px);
    pointer-events: auto;
    background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
  }

  .crop-hint {
    margin: 0;
    text-align: center;
    font-size: 0.82rem;
    color: rgba(255,255,255,0.7);
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(8px);
    border-radius: 999px;
    padding: 6px 14px;
    display: inline-block;
    left: 50%;
    position: relative;
    transform: translateX(-50%);
  }

  .crop-cancel {
    flex: 1;
    background: rgba(255,255,255,0.1);
    border: 1px solid rgba(255,255,255,0.2);
    color: white;
    border-radius: 10px;
    padding: 12px;
    font-size: 0.9rem;
    backdrop-filter: blur(8px);
  }
  .crop-confirm {
    flex: 2;
    background: #9ad1ff;
    border: none;
    color: #0a0a0a;
    border-radius: 10px;
    padding: 12px;
    font-size: 0.9rem;
    font-weight: 700;
  }
</style>
