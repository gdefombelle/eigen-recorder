<!-- AttachmentViewer — full-screen photo viewer. -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';

  let { url, title = '', onclose }: { url: string; title?: string; onclose: () => void } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
</script>

<div class="viewer" role="dialog" aria-modal="true" aria-label={title}>
  <button type="button" class="close" onclick={onclose} aria-label={tr.viewerClose}>
    <svg width="16" height="16" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/></svg>
  </button>
  <img src={url} alt={title} />
  {#if title}<p class="cap">{title}</p>{/if}
</div>

<style>
  .viewer { position: fixed; inset: 0; z-index: 1200; background: rgba(0,0,0,0.96); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: env(safe-area-inset-top, 0px) 0 env(safe-area-inset-bottom, 0px); }
  img { max-width: 100%; max-height: 86%; object-fit: contain; }
  .cap { margin: 10px 16px 0; color: var(--ev-text-dim); font-size: 0.9rem; text-align: center; }
  .close { position: absolute; top: calc(env(safe-area-inset-top, 0px) + 12px); right: 12px; width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,0.12); border: none; color: #fff; display: flex; align-items: center; justify-content: center; cursor: pointer; }
</style>
