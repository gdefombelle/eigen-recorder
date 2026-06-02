<!-- StereoMicMeter — double vumètre L/R avec labels adaptatifs selon l'orientation -->
<script lang="ts">
  export let levelL: number = 0;   // 0..1 — canal gauche / micro bas
  export let levelR: number = 0;   // 0..1 — canal droit / micro haut
  export let active: boolean = false;
  export let stereo: boolean = false; // true = vraie stéréo détectée

  // Orientation de l'iPhone
  let isLandscape = false;
  let labelsL = 'BAS';
  let labelsR = 'HAUT';
  let tooltipL = 'Micro bas — voix directe';
  let tooltipR = 'Micro haut — ambiance salle';

  function detectLandscape(): boolean {
    // screen.orientation est plus fiable que innerWidth/innerHeight sur iOS Capacitor
    if (typeof screen !== 'undefined' && screen.orientation?.type) {
      return screen.orientation.type.startsWith('landscape');
    }
    return window.innerWidth > window.innerHeight;
  }

  function updateOrientation() {
    isLandscape = detectLandscape();
    if (isLandscape) {
      labelsL = 'GAUCHE';   labelsR = 'DROITE';
      tooltipL = 'Micro gauche';  tooltipR = 'Micro droit';
    } else {
      labelsL = 'BAS';   labelsR = 'HAUT';
      tooltipL = 'Micro bas — voix directe';  tooltipR = 'Micro haut — ambiance salle';
    }
  }

  import { onMount } from 'svelte';
  onMount(() => {
    updateOrientation();
    // orientationchange se déclenche sur iOS quand le device pivote
    const onOC = () => setTimeout(updateOrientation, 150); // délai — iOS met à jour le layout après l'event
    window.addEventListener('orientationchange', onOC);
    window.addEventListener('resize', updateOrientation);
    screen.orientation?.addEventListener('change', updateOrientation);
    return () => {
      window.removeEventListener('orientationchange', onOC);
      window.removeEventListener('resize', updateOrientation);
      screen.orientation?.removeEventListener('change', updateOrientation);
    };
  });

  const BARS = 18;
  $: filledL = Math.round(levelL * BARS);
  $: filledR = Math.round(levelR * BARS);

  // Les deux canaux sont identiques → signal mono
  $: isMono = !stereo || Math.abs(levelL - levelR) < 0.01;
</script>

<div class="stereo-meter" class:active>
  <div class="channel" title={tooltipL}>
    <div class="ch-label">{labelsL}</div>
    <div class="bars" class:mono={isMono}>
      {#each Array(BARS) as _, i}
        <div class="bar"
          class:filled={active && i < filledL}
          class:peak={active && i >= BARS - 3 && i < filledL}
        ></div>
      {/each}
    </div>
    <div class="pct">{active ? `${Math.round(levelL * 100)}` : '—'}</div>
  </div>

  <div class="ch-sep"></div>

  <div class="channel" title={tooltipR}>
    <div class="ch-label">{labelsR}</div>
    <div class="bars" class:mono={isMono}>
      {#each Array(BARS) as _, i}
        <div class="bar"
          class:filled={active && i < filledR}
          class:peak={active && i >= BARS - 3 && i < filledR}
        ></div>
      {/each}
    </div>
    <div class="pct">{active ? `${Math.round(levelR * 100)}` : '—'}</div>
  </div>

  {#if active && isMono && stereo}
    <div class="mono-badge" title="Les deux canaux sont identiques — signal mono">MONO</div>
  {:else if active && !isMono}
    <div class="stereo-badge">STEREO</div>
  {/if}
</div>

<style>
  .stereo-meter {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) 0;
    position: relative;
  }

  .channel {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex: 1;
  }

  .ch-label {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    min-width: 28px;
    text-align: right;
  }

  .pct {
    font-size: 0.6rem;
    font-weight: 600;
    color: var(--text-muted);
    min-width: 22px;
    text-align: left;
    font-family: var(--font-mono);
  }

  .bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1;
    height: 16px;
  }

  .bar {
    flex: 1;
    height: 100%;
    background: rgba(255,255,255,0.07);
    border-radius: 2px;
    transition: background 60ms linear;
  }
  .filled      { background: var(--ev-blue); }
  .peak        { background: var(--ev-danger); }
  .mono .filled { background: rgba(154,209,255,0.5); }

  .ch-sep {
    width: 1px;
    height: 20px;
    background: var(--ev-border);
    flex-shrink: 0;
  }

  .stereo-badge, .mono-badge {
    position: absolute;
    right: 0;
    top: -16px;
    font-size: 0.55rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    padding: 1px 5px;
    border-radius: 3px;
  }
  .stereo-badge {
    background: rgba(154,209,255,0.12);
    color: var(--ev-blue);
    border: 1px solid rgba(154,209,255,0.25);
  }
  .mono-badge {
    background: rgba(255,255,255,0.05);
    color: var(--text-muted);
    border: 1px solid var(--ev-border);
  }
</style>
