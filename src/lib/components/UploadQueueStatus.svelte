<script lang="ts">
  import type { AudioChunkMetadata } from '$lib/recorder/types';
  import { formatBytes } from '$lib/recorder/utils';

  let { chunks, totalSizeBytes, state, onMockUpload = null }: {
    chunks: AudioChunkMetadata[];
    totalSizeBytes: number;
    state: string;
    onMockUpload?: (() => void) | null;
  } = $props();

  // Exclude backup_only chunks from sync accounting — they were sent via
  // WebSocket and are kept locally for Share Audio only, not via /audio-chunks.
  let realChunks  = $derived(chunks.filter((c) => c.status !== 'backup_only'));
  let uploaded    = $derived(realChunks.filter((c) => c.status === 'uploaded').length);
  let pending     = $derived(realChunks.filter((c) => c.status === 'saved').length);

  // 'synced'      → POST /stop confirmed by backend (PCM stream mode)
  // 'mock_synced' → full offline flush completed
  let isSynced    = $derived(state === 'mock_synced' || state === 'synced');
  let isUploading = $derived(state === 'mock_uploading');
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
    {#if !isSynced && realChunks.length > 0}
      <div class="stat-sep">·</div>
      <div class="stat">
        <span class="stat-val">{uploaded}/{realChunks.length}</span>
        <span class="stat-key">synced</span>
      </div>
    {/if}
  </div>

  {#if pending > 0 && !isSynced}
    <div class="not-uploaded">
      <span class="warn-icon">⚠</span>
      <span>{pending} chunk{pending > 1 ? 's' : ''} not synced yet — use the button below</span>
    </div>
  {/if}
</div>
<!-- Note: the "✓ Synced" and "Syncing…" badges are intentionally NOT rendered
     here — RecorderMiniK7's post-actions block handles those states. This
     component is responsible only for file stats and the pending-chunks warning. -->

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
