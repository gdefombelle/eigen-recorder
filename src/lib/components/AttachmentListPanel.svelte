<!-- AttachmentListPanel — full-screen list of a record's attachments.
     An overlay on top of the recorder screen (not a route) so the recording keeps running underneath. -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';
  import { summarize, type AttachmentView } from '$lib/recorder/attachments/attachmentView';
  import { formatDuration } from '$lib/recorder/utils';
  import AttachmentRow from './AttachmentRow.svelte';

  let { items, recording = false, paused = false, elapsedMs = 0, onclose }: {
    items: AttachmentView[];
    recording?: boolean;
    paused?: boolean;
    elapsedMs?: number;
    onclose: () => void;
  } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
  let notSentYet = $derived(items.some((i) => i.status !== 'ready' && i.status !== 'processing' && i.status !== 'processing_failed'));
  let summary = $derived(summarize(items));
</script>

<div class="panel" role="dialog" aria-modal="true" aria-label={tr.listTitle}>
  <nav>
    <button type="button" class="back" onclick={onclose}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 3L4 7.5 9 12"/></svg>
      {tr.back}
    </button>
  </nav>

  <div class="scroll">
    {#if recording || paused}
      <div class="rec-bar" class:paused>
        <span class="rec-dot"></span>
        <span class="rec-label">{paused ? 'PAUSE' : 'REC'}</span>
        <span class="rec-time">{formatDuration(elapsedMs)}</span>
      </div>
    {/if}

    <h1>{tr.listTitle}</h1>
    <p class="sub">{tr.listSubtitle(summary.total)}</p>

    {#if notSentYet}
      <p class="warn" role="note">{tr.unsyncedWarning}</p>
    {/if}

    {#if items.length === 0}
      <p class="empty">{tr.empty}</p>
    {:else}
      <ul>
        {#each items as it (it.id)}
          <AttachmentRow item={it} />
        {/each}
      </ul>
    {/if}
  </div>

  <footer>
    <button type="button" class="back-record" onclick={onclose}>{tr.backToRecord}</button>
  </footer>
</div>

<style>
  .panel { position: fixed; inset: 0; z-index: 998; background: var(--bg); display: flex; flex-direction: column; padding-top: env(safe-area-inset-top, 0px); }
  nav { padding: 10px var(--sp-4); border-bottom: 1px solid var(--ev-border); flex-shrink: 0; }
  .back { display: flex; align-items: center; gap: 4px; background: none; border: none; color: var(--ev-blue); font-family: var(--font-sans); font-size: 0.95rem; font-weight: 600; cursor: pointer; padding: 6px 0; }
  .scroll { flex: 1; overflow-y: auto; padding: var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-3); -webkit-overflow-scrolling: touch; }
  .rec-bar { display: flex; align-items: center; gap: 10px; padding: 12px var(--sp-3); border: 1px solid rgba(229,72,77,0.4); background: rgba(229,72,77,0.07); border-radius: 12px; }
  .rec-bar.paused { border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.07); }
  .rec-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ev-danger); }
  .paused .rec-dot { background: var(--ev-orange); }
  .rec-label { font-weight: 800; letter-spacing: 0.14em; color: var(--ev-danger); font-size: 0.9rem; }
  .paused .rec-label { color: var(--ev-orange); }
  .rec-time { margin-left: auto; font-family: var(--font-mono); font-weight: 700; font-size: 1.1rem; color: var(--ev-text); }
  h1 { margin: var(--sp-2) 0 0; font-family: var(--font-display); font-size: 1.9rem; font-weight: 800; color: var(--ev-text); }
  .sub { margin: 0; color: var(--ev-text-dim); font-size: 0.95rem; }
  .warn { margin: 0; padding: 10px var(--sp-3); border-radius: 10px; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.3); color: var(--ev-orange); font-size: 0.88rem; line-height: 1.4; }
  .empty { color: var(--ev-text-dim); text-align: center; padding: var(--sp-6) 0; }
  ul { margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
  footer { padding: var(--sp-3) var(--sp-4) calc(var(--sp-3) + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--ev-border); flex-shrink: 0; }
  .back-record { width: 100%; padding: 16px; border-radius: 14px; background: var(--ev-surface); border: 1px solid var(--ev-border); color: var(--ev-blue); font-family: var(--font-sans); font-size: 1.05rem; font-weight: 700; cursor: pointer; }
</style>
