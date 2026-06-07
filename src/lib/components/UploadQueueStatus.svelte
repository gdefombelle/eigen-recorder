<script lang="ts">
  import type { AudioChunkMetadata } from '$lib/recorder/types';
  import { formatBytes } from '$lib/recorder/utils';

  export let chunks: AudioChunkMetadata[];
  export let totalSizeBytes: number;
  export let state: string;
  export let onMockUpload: (() => void) | null = null;

  $: uploaded = chunks.filter((c) => c.status === 'uploaded').length;
  $: pending  = chunks.filter((c) => c.status === 'saved').length;
  $: isSynced = state === 'mock_synced';
  $: isUploading = state === 'mock_uploading';
</script>

<div class="queue-status">
  <div class="stats-row">
    <div class="stat">
      <span class="stat-val">{chunks.length}</span>
      <span class="stat-key">local files</span>
    </div>
    <div class="stat-sep">·</div>
    <div class="stat">
      <span class="stat-val">{formatBytes(totalSizeBytes)}</span>
      <span class="stat-key">on device</span>
    </div>
    {#if chunks.length > 0}
      <div class="stat-sep">·</div>
      <div class="stat">
        <span class="stat-val">{uploaded}/{chunks.length}</span>
        <span class="stat-key">synced</span>
      </div>
    {/if}
  </div>

  {#if isSynced}
    <div class="sync-badge synced">
      <span>✓</span> Synced to EigenVertex
    </div>
  {:else if isUploading}
    <div class="sync-badge uploading">
      <span class="spinner"></span> Syncing…
    </div>
  {:else if pending > 0}
    <div class="not-uploaded">
      <span class="warn-icon">⚠</span>
      <span>{pending} chunk{pending > 1 ? 's' : ''} not synced yet</span>
      {#if onMockUpload}
        <button class="btn btn-sm btn-ghost" on:click={onMockUpload}>
          Sync to EigenVertex
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .queue-status {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .stats-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  .stat-val {
    font-size: 1.1rem;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--text);
  }
  .stat-key {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .stat-sep { color: var(--text-subtle); font-size: 1.2rem; }

  .sync-badge {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 0.75rem;
    font-weight: 600;
    padding: var(--sp-2) var(--sp-3);
    border-radius: var(--r);
    letter-spacing: 0.03em;
  }
  .synced    { background: var(--green-dim); color: var(--green); }
  .uploading { background: var(--bg-3); color: var(--blue-bright); }

  .not-uploaded {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--orange);
    background: #1a0a00;
    border: 1px solid #451a03;
    border-radius: var(--r);
    padding: var(--sp-2) var(--sp-3);
    flex-wrap: wrap;
  }
  .warn-icon { font-size: 0.9rem; }

  .spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--blue-bright);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
</style>
