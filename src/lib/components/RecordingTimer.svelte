<script lang="ts">
  import { formatDuration } from '$lib/recorder/utils';

  let { elapsedMs = 0, recording = false, paused = false }: {
    elapsedMs?: number;
    recording?: boolean;
    paused?: boolean;
  } = $props();

  let display = $derived(formatDuration(elapsedMs));
  let timerParts = $derived.by(() => {
    const d = display;
    if (d.includes(':')) {
      const li = d.lastIndexOf('.');
      return li !== -1
        ? { hhmm: d.slice(0, li), tenths: d.slice(li) }
        : { hhmm: d, tenths: '' };
    }
    return { hhmm: d, tenths: '' };
  });
  let hhmm   = $derived(timerParts.hhmm);
  let tenths = $derived(timerParts.tenths);
</script>

<div class="timer" class:recording class:paused>
  <div class="digits">
    <span class="main">{hhmm}</span><span class="tenths">{tenths}</span>
  </div>
  {#if recording}
    <div class="rec-indicator">
      <span class="rec-dot"></span>
      <span class="rec-label">REC</span>
    </div>
  {:else if paused}
    <div class="rec-indicator paused-ind">
      <span class="rec-dot"></span>
      <span class="rec-label">PAUSED</span>
    </div>
  {/if}
</div>

<style>
  .timer {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-6) 0;
  }

  .digits {
    display: flex;
    align-items: baseline;
    font-family: var(--font-mono);
    font-size: 3rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text);
    line-height: 1;
    transition: color var(--t);
  }
  .recording .digits { color: #fff; }
  .paused .digits    { color: var(--text-muted); }

  .tenths {
    font-size: 1.5rem;
    color: var(--text-muted);
    margin-left: 2px;
  }
  .recording .tenths { color: var(--text-dim); }

  .rec-indicator {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--red);
  }
  .paused-ind { color: var(--text-muted); }

  .rec-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
  }
  .recording .rec-dot {
    animation: pulse-dot 1s ease-in-out infinite;
  }
  .paused-ind .rec-dot {
    background: var(--text-muted);
    animation: none;
  }
</style>
