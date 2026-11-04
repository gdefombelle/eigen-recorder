<!-- AttachmentRow — one attachment in the list: thumbnail + editable title + size + status, retry, delete. -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';
  import { attachmentQueue } from '$lib/recorder/attachments/attachmentQueue';
  import { formatSize, type AttachmentView } from '$lib/recorder/attachments/attachmentView';
  import AttachmentThumb from './AttachmentThumb.svelte';

  let { item }: { item: AttachmentView } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
  let lang = $derived($langStore);

  // Countdown to the next automatic attempt (only meaningful while 'retrying').
  let now = $state(Date.now());
  $effect(() => {
    if (item.status !== 'retrying') return;
    const id = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(id);
  });
  let retryInSec = $derived(item.nextAttemptAt === null ? null : Math.max(0, Math.ceil((item.nextAttemptAt - now) / 1000)));

  let editing = $state(false);
  let draft = $state('');

  function startEdit() { draft = item.title; editing = true; }
  async function commit() {
    editing = false;
    const next = draft.trim();
    if (next && next !== item.title) await attachmentQueue.rename(item.id, next);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    else if (e.key === 'Escape') { editing = false; }
  }

  async function remove() {
    if (typeof confirm === 'function' && !confirm(tr.deleteConfirm)) return;
    await attachmentQueue.remove(item.id);
  }

  let statusText = $derived.by(() => {
    switch (item.status) {
      case 'ready':             return tr.statusReady;
      case 'uploading':         return tr.statusUploading(item.percent ?? 0);
      case 'queued':            return tr.statusQueued;
      case 'offline':           return tr.statusOffline;
      case 'retrying':          return item.retryKind === 'network'
                                  ? tr.statusRetryingNetwork(retryInSec)
                                  : tr.statusRetryingServer(item.lastStatus ?? 0, retryInSec);
      case 'processing':        return tr.statusProcessing;
      case 'processing_failed': return tr.statusProcessingFailed;
      case 'failed':            return tr.statusFailed;
      case 'abandoned':         return tr.statusAbandoned;
    }
  });
  let kindLabel = $derived(item.isScan ? `${tr.kindScan}${item.pageCount ? ` · ${tr.pagesShort(item.pageCount)}` : ''}` : item.kind === 'photo' ? tr.kindPhoto : tr.kindDocument);
</script>

<li class="row s-{item.status}">
  <div class="main">
    <div class="thumb-wrap">
      <AttachmentThumb id={item.id} kind={item.kind} scan={item.isScan} size={64} />
      <span class="time">{item.offsetLabel}</span>
    </div>

    <div class="body">
      {#if editing}
        <!-- svelte-ignore a11y_autofocus -->
        <input class="title-input" bind:value={draft} aria-label={tr.titleLabel} maxlength="200" onblur={commit} onkeydown={onKey} autofocus />
      {:else}
        <button type="button" class="title" onclick={startEdit} aria-label={tr.titleLabel}>{item.title}</button>
      {/if}
      <span class="meta">{kindLabel} · {formatSize(item.sizeBytes, lang, tr.sizeUnit)}</span>
      <span class="status st-{item.status}">
        {#if item.status === 'uploading'}
          <span class="bar"><span class="fill" style="width:{item.percent ?? 0}%"></span></span>
        {/if}
        {statusText}
      </span>
    </div>

    <button type="button" class="trash" onclick={remove} aria-label={tr.deleteLabel}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
    </button>
  </div>

  {#if item.diagnostic && item.status !== 'ready' && item.status !== 'processing'}
    <p class="diag" data-testid="diagnostic"><strong>{tr.diagTitle}</strong>{#if item.attempts > 0} · {tr.diagAttempt(item.attempts)}{/if}<br />{item.diagnostic}</p>
  {/if}

  {#if item.canRetry}
    <button type="button" class="retry" onclick={() => attachmentQueue.retry(item.id)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5"/></svg>
      {tr.retry}
    </button>
  {/if}
</li>

<style>
  .row { list-style: none; background: var(--ev-card); border: 1px solid var(--ev-border); border-radius: 14px; padding: var(--sp-3); display: flex; flex-direction: column; gap: var(--sp-2); }
  .row.s-offline, .row.s-retrying, .row.s-waiting_share { border-color: rgba(245,158,11,0.35); }
  .row.s-retrying, .row.s-failed, .row.s-processing_failed { border-color: rgba(229,72,77,0.55); }
  .row.s-abandoned { opacity: 0.7; }
  .main { display: flex; align-items: center; gap: var(--sp-3); }
  .thumb-wrap { position: relative; flex-shrink: 0; }
  .time { position: absolute; left: 4px; bottom: 4px; font-family: var(--font-mono); font-size: 0.66rem; font-weight: 700; background: rgba(0,0,0,0.78); color: #fff; padding: 1px 5px; border-radius: 5px; }
  .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .title { background: none; border: none; padding: 0; text-align: left; font-family: var(--font-display); font-size: 1.08rem; font-weight: 700; color: var(--ev-text); cursor: text; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .title-input { font-family: var(--font-display); font-size: 1.05rem; font-weight: 700; color: var(--ev-text); background: var(--ev-black); border: 1px solid var(--ev-blue); border-radius: 8px; padding: 4px 8px; width: 100%; }
  .meta { font-size: 0.88rem; color: var(--ev-text-dim); }
  .status { font-size: 0.9rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
  .st-ready { color: var(--ev-success); }
  .st-uploading, .st-processing { color: var(--ev-blue); }
  .st-offline, .st-waiting_share, .st-queued { color: var(--ev-orange); }
  .st-retrying { color: var(--ev-danger); }
  .st-failed, .st-processing_failed, .st-abandoned { color: var(--ev-danger); }
  .bar { flex: 1; max-width: 120px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.1); overflow: hidden; }
  .fill { display: block; height: 100%; background: var(--ev-blue); transition: width 200ms linear; }
  .diag { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,0.35); font-family: var(--font-mono); font-size: 0.74rem; line-height: 1.4; color: var(--ev-text-dim); word-break: break-word; user-select: text; -webkit-user-select: text; }
  .diag strong { color: var(--ev-text); font-family: var(--font-sans); }
  .trash { background: none; border: none; color: var(--ev-text-dim); padding: 10px; margin: -6px -6px -6px 0; cursor: pointer; }
  .retry { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; border-radius: 12px; background: var(--ev-black); border: 1px solid rgba(154,209,255,0.4); color: var(--ev-blue); font-family: var(--font-sans); font-size: 1rem; font-weight: 700; cursor: pointer; }
</style>
