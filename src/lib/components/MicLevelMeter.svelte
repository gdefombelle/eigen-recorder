<script lang="ts">
  export let level: number = 0; // 0..1
  export let active: boolean = false;

  const BARS = 20;
  $: filledBars = Math.round(level * BARS);
</script>

<div class="meter" class:active>
  <div class="label">MIC</div>
  <div class="bars" aria-label="Microphone level {Math.round(level * 100)}%">
    {#each Array(BARS) as _, i}
      <div
        class="bar"
        class:filled={i < filledBars}
        class:peak={i >= BARS - 3 && i < filledBars}
      ></div>
    {/each}
  </div>
  <div class="pct">{active ? `${Math.round(level * 100)}%` : '—'}</div>
</div>

<style>
  .meter {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-2) 0;
  }

  .label, .pct {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
    min-width: 24px;
  }
  .pct { text-align: right; min-width: 28px; }

  .bars {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    flex: 1;
    height: 20px;
  }

  .bar {
    flex: 1;
    height: 100%;
    background: var(--bg-3);
    border-radius: 2px;
    transition: background 60ms linear;
  }
  .filled { background: var(--blue-bright); }
  .peak   { background: var(--red); }
  .active .bar { border-color: var(--border); }
</style>
