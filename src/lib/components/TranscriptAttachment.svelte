<!-- TranscriptAttachment — an attachment shown inline in the transcript, at the minute it was added. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t, langStore } from '$lib/i18n/index';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { getAttachmentApi } from '$lib/recorder/attachments/attachmentApi';
  import { attachmentFilename, fetchAttachmentBlob, openDocument } from '$lib/recorder/attachments/attachmentFile';
  import { formatOffset } from '$lib/recorder/attachments/attachmentView';
  import type { AttachmentRecord } from '$lib/recorder/attachments/types';
  import AttachmentViewer from './AttachmentViewer.svelte';

  let { record, sessionId }: { record: AttachmentRecord; sessionId: string } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
  let isPhoto = $derived(record.kind === 'photo' || !!record.stored_file?.content_type?.startsWith('image/'));
  let title = $derived(record.title || (isPhoto ? tr.kindPhoto : tr.kindDocument));

  let thumbUrl = $state<string | null>(null);
  let viewerUrl = $state<string | null>(null);
  let opening = $state(false);
  let error = $state('');

  // Thumbnail from the copy on this device only — never a download just to draw a list.
  onMount(() => {
    let alive = true;
    let url: string | null = null;
    if (isPhoto) {
      offlineStorage.getAttachmentBlob(record.client_attachment_id).then((blob) => {
        if (!blob || !alive) return;
        url = URL.createObjectURL(blob);
        thumbUrl = url;
      }).catch(() => {});
    }
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  });

  function closeViewer() {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }

  async function open() {
    opening = true; error = '';
    try {
      const blob = await fetchAttachmentBlob(
        { getLocalBlob: (id) => offlineStorage.getAttachmentBlob(id), api: await getAttachmentApi() },
        sessionId,
        record,
      );
      if (isPhoto) viewerUrl = URL.createObjectURL(blob);
      else await openDocument(blob, attachmentFilename(record.title, record.stored_file?.content_type ?? blob.type));
    } catch {
      error = tr.openFailed;
    } finally {
      opening = false;
    }
  }
</script>

<div class="att" class:has-thumb={!!thumbUrl}>
  {#if thumbUrl}
    <div class="preview">
      <img src={thumbUrl} alt="" draggable="false" />
      <span class="time">{formatOffset(record.start_offset_ms)}</span>
    </div>
  {/if}
  <div class="row">
    {#if !thumbUrl}
      <div class="glyph" class:doc={!isPhoto} aria-hidden="true">
        {#if isPhoto}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 3-4 5 6"/></svg>
        {:else}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></svg>
        {/if}
        <span class="time">{formatOffset(record.start_offset_ms)}</span>
      </div>
    {/if}
    <div class="meta">
      <span class="kind">{isPhoto ? tr.inlinePhoto : tr.inlineDocument}</span>
      <span class="name">{title}</span>
      {#if error}<span class="err" role="alert">{error}</span>{/if}
    </div>
    <button type="button" class="open" onclick={open} disabled={opening}>{opening ? tr.opening : tr.open}</button>
  </div>
</div>

{#if viewerUrl}
  <AttachmentViewer url={viewerUrl} {title} onclose={closeViewer} />
{/if}

<style>
  .att { background: var(--ev-card, #161616); border: 1px solid var(--ev-border); border-radius: 14px; overflow: hidden; }
  .preview { position: relative; background: rgba(90,168,232,0.10); max-height: 220px; display: flex; justify-content: center; }
  .preview img { width: 100%; max-height: 220px; object-fit: cover; display: block; }
  .time { position: absolute; left: 8px; top: 8px; font-family: var(--font-mono); font-size: 0.72rem; font-weight: 700; background: rgba(0,0,0,0.78); color: #fff; padding: 2px 7px; border-radius: 6px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; }
  .glyph { position: relative; width: 60px; height: 60px; flex-shrink: 0; border-radius: 10px; display: flex; align-items: center; justify-content: center; background: rgba(90,168,232,0.14); color: rgba(255,255,255,0.45); }
  .glyph.doc { background: rgba(245,158,11,0.10); color: var(--ev-orange); }
  .glyph .time { top: auto; bottom: 3px; left: 3px; font-size: 0.62rem; padding: 1px 5px; }
  .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .kind { font-size: 0.68rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: var(--ev-blue); }
  .name { font-size: 1.02rem; font-weight: 700; color: var(--ev-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .err { font-size: 0.8rem; color: var(--ev-danger); }
  .open { flex-shrink: 0; padding: 10px 16px; border-radius: 12px; background: rgba(154,209,255,0.08); border: 1px solid rgba(154,209,255,0.4); color: var(--ev-blue); font-family: var(--font-sans); font-size: 0.95rem; font-weight: 700; cursor: pointer; }
  .open:disabled { opacity: 0.6; }
</style>
