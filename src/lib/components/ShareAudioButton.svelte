<script lang="ts">
  import { shareOrDownload, canWebShare, buildExport, isSafariMp4Warning } from '$lib/recorder/shareAudio';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { formatBytes } from '$lib/recorder/utils';

  export let sessionId: string;
  export let chunkCount: number = 0;
  export let variant: 'full' | 'icon' = 'full';

  type State = 'idle' | 'preparing' | 'sharing' | 'done' | 'error';

  let state: State = 'idle';
  let outcome: string = '';
  let errorMsg: string = '';
  let exportSize: number = 0;
  let mimeType: string = '';
  let showWarning = false;

  $: canShare = canWebShare();
  $: label = canShare ? 'Share Audio' : 'Export Audio';
  $: icon  = canShare ? '↑' : '↓';

  async function loadMeta() {
    const chunks = await offlineStorage.getChunksMeta(sessionId);
    if (chunks.length > 0) mimeType = chunks[0].mime_type;
    showWarning = isSafariMp4Warning(mimeType);
  }

  $: if (sessionId) loadMeta();

  async function handleShare() {
    if (state === 'preparing' || state === 'sharing') return;

    state = 'preparing';
    errorMsg = '';

    try {
      // Preview size before sharing
      const info = await buildExport(sessionId);
      exportSize = info.sizeBytes;
      mimeType   = info.mimeType;
      showWarning = isSafariMp4Warning(mimeType);

      state = 'sharing';
      const result = await shareOrDownload(sessionId);

      if (result === 'cancelled') {
        state = 'idle';
        return;
      }

      outcome = result === 'shared' ? 'Shared ✓' : 'Saved to Downloads ✓';
      state   = 'done';
      setTimeout(() => { state = 'idle'; outcome = ''; }, 3500);

    } catch (err) {
      errorMsg = err instanceof Error ? err.message : 'Export failed';
      state    = 'error';
    }
  }

  function dismiss() { state = 'idle'; errorMsg = ''; }
</script>

<div class="share-wrap">

  {#if state === 'error'}
    <div class="share-error">
      <span>{errorMsg}</span>
      <button class="btn btn-sm btn-ghost" on:click={dismiss}>Dismiss</button>
    </div>
  {:else if state === 'done'}
    <div class="share-done">{outcome}</div>
  {:else}
    <button
      class="share-btn"
      class:icon-only={variant === 'icon'}
      on:click={handleShare}
      disabled={chunkCount === 0 || state === 'preparing' || state === 'sharing'}
      title="{label} — {formatBytes(exportSize) || '…'}"
    >
      {#if state === 'preparing'}
        <span class="spinner-sm"></span>
        Preparing…
      {:else if state === 'sharing'}
        <span class="spinner-sm"></span>
        {canShare ? 'Opening…' : 'Downloading…'}
      {:else if variant === 'icon'}
        <span class="sh-icon">{icon}</span>
      {:else}
        <span class="sh-icon">{icon}</span>
        {label}
        {#if exportSize > 0}
          <span class="size-hint">{formatBytes(exportSize)}</span>
        {/if}
      {/if}
    </button>
  {/if}
</div>

<style>
  .share-wrap { display: flex; flex-direction: column; gap: 6px; }

  .share-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px var(--sp-5);
    border-radius: var(--radius-md);
    border: 1px solid var(--ev-border);
    background: var(--ev-card);
    color: var(--ev-text);
    font-family: var(--font-sans);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 120ms, border-color 120ms;
    width: 100%;
    -webkit-tap-highlight-color: transparent;
  }
  .share-btn:hover:not(:disabled)    { background: rgba(255,255,255,0.06); border-color: var(--ev-blue); }
  .share-btn:active:not(:disabled)   { transform: scale(0.97); }
  .share-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .share-btn.icon-only {
    width: 34px;
    height: 34px;
    padding: 0;
    border-radius: var(--radius-sm);
    font-size: 1rem;
  }

  .sh-icon { font-size: 1rem; font-weight: 700; }

  .size-hint {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--ev-text-dim);
    background: rgba(255,255,255,0.06);
    padding: 1px 6px;
    border-radius: 4px;
  }

  .share-done {
    font-size: 0.82rem;
    font-weight: 600;
    color: var(--ev-success);
    background: rgba(70,167,88,0.1);
    border: 1px solid rgba(70,167,88,0.25);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    text-align: center;
  }

  .share-error {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 0.8rem;
    color: var(--ev-danger);
    background: rgba(229,72,77,0.08);
    border: 1px solid rgba(229,72,77,0.25);
    border-radius: var(--radius-md);
    padding: 8px 12px;
    flex-wrap: wrap;
  }


  .spinner-sm {
    display: inline-block;
    width: 13px;
    height: 13px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: var(--ev-blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
</style>
