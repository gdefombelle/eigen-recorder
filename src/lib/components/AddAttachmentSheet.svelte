<!-- AddAttachmentSheet — bottom sheet: camera / photo library / files.
     The position shown is the one captured when the sheet opened; the recording keeps running behind it. -->
<script lang="ts">
  import { t, langStore } from '$lib/i18n/index';

  import type { PickSource } from '$lib/recorder/attachments/attachmentPicker';
  let { offsetLabel, scanAvailable = false, onpick, onclose }: {
    offsetLabel: string;
    /** The scanner is offered only where an engine exists (iOS app); never in the PWA. */
    scanAvailable?: boolean;
    onpick: (source: PickSource) => void;
    onclose: () => void;
  } = $props();

  let tr = $derived.by(() => { $langStore; return t(); });
</script>

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}>
  <div class="sheet animate-slide-up" role="dialog" aria-modal="true" aria-label={tr.attachments.sheetTitle}>
    <div class="grab" aria-hidden="true"></div>
    <h2>{tr.attachments.sheetTitle}</h2>
    <p class="placed">
      <span class="dot" aria-hidden="true"></span>
      {tr.attachments.placedAt} <span class="mono">{offsetLabel}</span> · {tr.attachments.recordingContinues}
    </p>

    <button type="button" class="opt primary" onclick={() => onpick('camera')}>
      <span class="ico cam" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>
      </span>
      <span class="txt"><strong>{tr.attachments.takePhoto}</strong><small>{tr.attachments.takePhotoHint}</small></span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

    <button type="button" class="opt" onclick={() => onpick('library')}>
      <span class="ico lib" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 3 3 3-4 5 6"/></svg>
      </span>
      <span class="txt"><strong>{tr.attachments.library}</strong><small>{tr.attachments.libraryHint}</small></span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

    <button type="button" class="opt" onclick={() => onpick('files')}>
      <span class="ico doc" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v4h4"/></svg>
      </span>
      <span class="txt"><strong>{tr.attachments.files}</strong><small>{tr.attachments.filesHint}</small></span>
      <span class="chev" aria-hidden="true">›</span>
    </button>

    {#if scanAvailable}
      <button type="button" class="opt" data-testid="opt-scan" onclick={() => onpick('scan')}>
        <span class="ico scan" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>
        </span>
        <span class="txt"><strong>{tr.attachments.scan}</strong><small>{tr.attachments.scanHint}</small></span>
        <span class="chev" aria-hidden="true">›</span>
      </button>
    {/if}

    <button type="button" class="cancel" onclick={onclose}>{tr.common.cancel}</button>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0; z-index: 999;
    background: rgba(0,0,0,0.72); backdrop-filter: blur(4px);
    display: flex; align-items: flex-end; justify-content: center;
  }
  .sheet {
    width: 100%; max-width: 520px;
    background: var(--ev-surface);
    border: 1px solid var(--ev-border); border-bottom: none;
    border-radius: 22px 22px 0 0;
    padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom, 0px));
    display: flex; flex-direction: column; gap: var(--sp-3);
  }
  .grab { width: 40px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.18); align-self: center; margin-bottom: var(--sp-1); }
  h2 { margin: 0; font-family: var(--font-display); font-size: 1.35rem; font-weight: 800; color: var(--ev-text); }
  .placed { margin: 0 0 var(--sp-1); font-size: 0.9rem; color: var(--ev-text-dim); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--ev-danger); flex-shrink: 0; }
  .mono { font-family: var(--font-mono); color: var(--ev-text); font-weight: 700; }

  .opt {
    display: flex; align-items: center; gap: var(--sp-3);
    width: 100%; text-align: left;
    padding: 12px var(--sp-3);
    background: var(--ev-card); border: 1px solid var(--ev-border); border-radius: 14px;
    color: var(--ev-text); font-family: var(--font-sans); cursor: pointer;
    -webkit-tap-highlight-color: transparent; min-height: 64px;
  }
  .opt.primary { border-color: rgba(154,209,255,0.28); background: rgba(154,209,255,0.06); }
  .opt:active { transform: scale(0.985); }
  .ico { width: 46px; height: 46px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
  .ico.cam { background: var(--ev-blue); color: #0a0a0a; }
  .ico.lib { background: rgba(90,168,232,0.16); color: var(--ev-blue); }
  .ico.doc { background: rgba(245,158,11,0.12); color: var(--ev-orange); }
  .ico.scan { background: rgba(16,185,129,0.14); color: var(--ev-success); }
  .txt { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .txt strong { font-size: 1.02rem; font-weight: 700; }
  .txt small { font-size: 0.82rem; color: var(--ev-text-dim); }
  .chev { color: var(--ev-text-dim); font-size: 1.4rem; }

  .cancel {
    margin-top: var(--sp-1); padding: 14px; border-radius: 14px;
    background: transparent; border: 1px solid var(--ev-border);
    color: var(--ev-text-dim); font-family: var(--font-sans); font-size: 1rem; font-weight: 700; cursor: pointer;
  }
</style>
