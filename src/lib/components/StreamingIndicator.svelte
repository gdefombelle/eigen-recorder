<!-- StreamingIndicator — visible during recording when syncMode='stream' -->
<script lang="ts">
  import { langStore } from '$lib/i18n/index';
  export let streamedCount: number = 0;
  export let totalChunks:   number = 0;
  export let pulse:         boolean = false;
  export let online:        boolean = true;
  $: isFr = $langStore === 'fr';
</script>

<div class="streaming-bar" class:offline={!online}>
  <span class="ev-icon" class:pulse>◈</span>
  <span class="streaming-text">
    {#if !online}
      {isFr ? 'Hors-ligne — stocké localement' : 'Offline — stored locally'}
    {:else if streamedCount > 0}
      <span class="streamed">{streamedCount}/{totalChunks}</span>
      {isFr ? 'chunks streamés' : 'chunks streamed'}
    {:else}
      {isFr ? 'Stream EigenVertex actif' : 'EigenVertex stream active'}
    {/if}
  </span>
  {#if pulse && online}
    <span class="chunk-sent">↑</span>
  {/if}
</div>

<style>
  .streaming-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 12px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.25);
    border-radius: var(--radius-md);
    font-size: 0.75rem;
    color: var(--ev-text-dim);
    transition: background 120ms;
  }
  .streaming-bar.offline {
    background: rgba(245,158,11,0.08);
    border-color: rgba(245,158,11,0.2);
  }

  .ev-icon {
    font-size: 1rem;
    color: var(--ev-blue);
    flex-shrink: 0;
    transition: color 120ms;
  }
  .ev-icon.pulse {
    animation: pulse-send 0.6s ease-out;
    color: #60c4ff;
  }
  @keyframes pulse-send {
    0%   { transform: scale(1);    color: #60c4ff; }
    40%  { transform: scale(1.35); color: #9ad1ff; }
    100% { transform: scale(1);    color: var(--ev-blue); }
  }

  .streaming-bar.offline .ev-icon { color: var(--ev-orange); }

  .streaming-text { flex: 1; }
  .streamed { font-weight: 700; color: var(--ev-text); }

  .chunk-sent {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--ev-blue);
    animation: slide-up-fade 0.5s ease-out forwards;
  }
  @keyframes slide-up-fade {
    0%   { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-8px); }
  }
</style>
