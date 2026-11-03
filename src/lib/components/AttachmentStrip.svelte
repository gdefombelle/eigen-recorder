<!-- AttachmentStrip — horizontal band of attachment thumbnails under "Open Live Room". -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';
  import type { AttachmentView } from '$lib/recorder/attachments/attachmentView';
  import AttachmentThumb from './AttachmentThumb.svelte';

  let { items, onseeall }: { items: AttachmentView[]; onseeall: () => void } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
</script>

{#if items.length > 0}
  <section class="strip" aria-label={tr.listTitle}>
    <header>
      <h3>{tr.stripTitle(items.length)}</h3>
      <button type="button" class="see-all" onclick={onseeall}>{tr.seeAll}</button>
    </header>
    <div class="rail">
      {#each items as it (it.id)}
        <button type="button" class="card" class:fail={it.status === 'failed' || it.status === 'processing_failed' || it.status === 'retrying'} class:wait={it.status === 'offline' || it.status === 'queued' || it.status === 'waiting_share'} onclick={onseeall}>
          <AttachmentThumb id={it.id} kind={it.kind} size={72} />
          <span class="time">{it.offsetLabel}</span>
          <span class="badge b-{it.status}" aria-hidden="true">
            {#if it.status === 'ready'}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg>
            {:else if it.status === 'uploading'}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10V2M2.5 5.5L6 2l3.5 3.5"/></svg>
            {:else if it.status === 'processing'}
              <span class="spin"></span>
            {:else if it.status === 'failed' || it.status === 'processing_failed' || it.status === 'abandoned' || it.status === 'retrying'}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 2.5v4M6 9v.5"/></svg>
            {:else}
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="6" cy="6" r="4.2"/><path d="M6 3.6V6l1.6 1"/></svg>
            {/if}
          </span>
          {#if it.status === 'uploading' && it.percent !== null}
            <span class="bar"><span class="fill" style="width:{it.percent}%"></span></span>
          {/if}
        </button>
      {/each}
    </div>
  </section>
{/if}

<style>
  .strip { width: 100%; display: flex; flex-direction: column; gap: var(--sp-2); }
  header { display: flex; align-items: baseline; justify-content: space-between; }
  h3 { margin: 0; font-size: 0.74rem; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ev-text-dim); }
  .see-all { background: none; border: none; color: var(--ev-blue); font-family: var(--font-sans); font-size: 0.9rem; font-weight: 700; cursor: pointer; padding: 4px 0; }
  .rail { display: flex; gap: var(--sp-2); overflow-x: auto; padding-bottom: 4px; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .rail::-webkit-scrollbar { display: none; }

  .card {
    position: relative; flex: 0 0 auto; padding: 0; border: 1px solid var(--ev-border);
    border-radius: 12px; background: none; cursor: pointer; overflow: hidden;
    -webkit-tap-highlight-color: transparent;
  }
  .card.wait { border-color: rgba(245,158,11,0.35); }
  .card.fail { border-color: rgba(229,72,77,0.5); }
  .time {
    position: absolute; left: 5px; bottom: 5px;
    font-family: var(--font-mono); font-size: 0.68rem; font-weight: 700;
    background: rgba(0,0,0,0.78); color: #fff; padding: 2px 6px; border-radius: 6px;
  }
  .badge {
    position: absolute; top: 5px; right: 5px; width: 20px; height: 20px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.7); border: 1px solid currentColor;
  }
  .badge :global(svg) { width: 12px; height: 12px; flex-shrink: 0; display: block; }
  .b-ready { color: var(--ev-success); }
  .b-uploading, .b-processing { color: var(--ev-blue); }
  .b-offline, .b-queued, .b-waiting_share { color: var(--ev-orange); }
  .b-retrying { color: var(--ev-danger); }
  .b-failed, .b-processing_failed, .b-abandoned { color: var(--ev-danger); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: rgba(255,255,255,0.12); }
  .fill { display: block; height: 100%; background: var(--ev-blue); transition: width 200ms linear; }
  .spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
