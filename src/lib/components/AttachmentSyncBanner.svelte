<!-- AttachmentSyncBanner — end-of-record status of the attachments that did not (all) reach the server.
     One banner per situation; nothing is rendered when everything is delivered. -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';
  import type { AttachmentSummary } from '$lib/recorder/attachments/attachmentView';

  let { summary, onretry }: { summary: AttachmentSummary; onretry: () => void } = $props();

  let tr = $derived.by(() => { $langStore; return t().attachments; });
</script>

{#if summary.sending > 0}
  <div class="banner info" role="status">
    <span class="ico spin" aria-hidden="true"></span>
    <div class="txt"><strong>{tr.syncUploading(summary.sending)}</strong></div>
  </div>
{/if}

{#if summary.offline > 0}
  <div class="banner wait" role="status">
    <span class="ico" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
    </span>
    <div class="txt">
      <strong>{tr.syncOfflineTitle(summary.offline)}</strong>
      <small>{tr.syncOfflineBody(summary.offline)}</small>
    </div>
    <button type="button" class="retry" onclick={onretry}>{tr.retry}</button>
  </div>
{/if}

{#if summary.retrying > 0}
  <div class="banner fail" role="alert">
    <span class="ico" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
    </span>
    <div class="txt">
      <strong>{tr.syncRetryingTitle(summary.retrying)}</strong>
      <small>{tr.syncRetryingBody}</small>
    </div>
    <button type="button" class="retry" onclick={onretry}>{tr.retry}</button>
  </div>
{/if}

{#if summary.waitingShare > 0}
  <div class="banner wait" role="status">
    <span class="ico" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>
    </span>
    <div class="txt">
      <strong>{tr.syncWaitingShareTitle(summary.waitingShare)}</strong>
      <small>{tr.syncWaitingShareBody(summary.waitingShare)}</small>
    </div>
  </div>
{/if}

{#if summary.failed > 0}
  <div class="banner fail" role="alert">
    <span class="ico" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
    </span>
    <div class="txt">
      <strong>{tr.syncFailedTitle(summary.failed)}</strong>
      <small>{tr.syncFailedBody}</small>
    </div>
    <button type="button" class="retry" onclick={onretry}>{tr.retry}</button>
  </div>
{/if}

{#if summary.abandoned > 0}
  <div class="banner fail" role="alert">
    <span class="ico" aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/></svg>
    </span>
    <div class="txt"><strong>{tr.syncAbandonedTitle(summary.abandoned)}</strong></div>
  </div>
{/if}

<style>
  .banner { display: flex; align-items: center; gap: var(--sp-3); width: 100%; padding: 14px var(--sp-3); border-radius: 14px; border: 1px solid; }
  .wait { background: rgba(245,158,11,0.07); border-color: rgba(245,158,11,0.4); color: var(--ev-orange); }
  .fail { background: rgba(229,72,77,0.07); border-color: rgba(229,72,77,0.45); color: var(--ev-danger); }
  .info { background: rgba(154,209,255,0.06); border-color: rgba(154,209,255,0.3); color: var(--ev-blue); }
  .ico { width: 38px; height: 38px; border-radius: 50%; border: 1.5px solid currentColor; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ico.spin { border-top-color: transparent; width: 22px; height: 22px; animation: spin 0.8s linear infinite; }
  .txt { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
  strong { font-size: 1.02rem; font-weight: 700; line-height: 1.25; }
  small { font-size: 0.85rem; line-height: 1.35; color: var(--ev-text-dim); }
  .retry { flex-shrink: 0; padding: 10px 14px; border-radius: 12px; background: var(--ev-black); border: 1px solid rgba(154,209,255,0.4); color: var(--ev-blue); font-family: var(--font-sans); font-size: 0.95rem; font-weight: 700; cursor: pointer; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
