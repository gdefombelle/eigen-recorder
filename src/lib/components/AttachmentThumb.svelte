<!-- AttachmentThumb — square thumbnail: the stored image for photos, a file glyph for documents.
     The blob comes from the same IndexedDB the queue uploads from, so it works offline. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import type { AttachmentKind } from '$lib/recorder/attachments/types';

  let { id, kind, size = 72 }: { id: string; kind: AttachmentKind; size?: number } = $props();

  let url = $state<string | null>(null);

  onMount(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    if (kind === 'photo') {
      offlineStorage.getAttachmentBlob(id).then((blob) => {
        if (!blob || revoked) return;
        objectUrl = URL.createObjectURL(blob);
        url = objectUrl;
      }).catch(() => { /* glyph fallback */ });
    }
    return () => { revoked = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  });
</script>

<div class="thumb" class:doc={kind === 'document'} style="width:{size}px;height:{size}px">
  {#if url}
    <img src={url} alt="" draggable="false" />
  {:else if kind === 'document'}
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/>
    </svg>
  {:else}
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 3-4 5 6"/>
    </svg>
  {/if}
</div>

<style>
  .thumb {
    display: flex; align-items: center; justify-content: center;
    border-radius: var(--radius-md);
    background: rgba(90,168,232,0.14);
    color: rgba(255,255,255,0.45);
    overflow: hidden;
    flex-shrink: 0;
  }
  .thumb.doc { background: rgba(245,158,11,0.10); color: var(--ev-orange); }
  img { width: 100%; height: 100%; object-fit: cover; display: block; }
</style>
