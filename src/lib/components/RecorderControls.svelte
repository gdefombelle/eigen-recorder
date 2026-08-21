<script lang="ts">
  import type { RecorderState } from '$lib/recorder/types';
  import EndMeetingDialog from './EndMeetingDialog.svelte';
  import { langStore } from '$lib/i18n/index';

  let { state: recState, onrec, onpause, onresume, onstop }: {
    state: RecorderState;
    onrec?: () => void;
    onpause?: () => void;
    onresume?: () => void;
    onstop?: () => void;
  } = $props();

  let showEndDialog = $state(false);

  let isReady     = $derived(recState === 'ready');
  let isRecording = $derived(recState === 'recording_offline');
  let isPaused    = $derived(recState === 'paused');
  let isStopping  = $derived(recState === 'stopping');
  let canControl  = $derived(isRecording || isPaused);
  let isFr        = $derived($langStore === 'fr');

  // User taps "End meeting" → show confirmation dialog
  function requestStop() {
    showEndDialog = true;
  }

  // User confirms → stop
  function onConfirmStop() {
    showEndDialog = false;
    onstop?.();
  }

  // User changes mind → pause (if recording) + dismiss dialog
  function onCancelStop() {
    showEndDialog = false;
    if (isRecording) {
      onpause?.();
    }
    // If already paused, just close — nothing to do
  }
</script>

<div class="controls">
  {#if isReady}
    <button
      class="rec-btn"
      onclick={() => onrec?.()}
      aria-label="Start recording"
    >
      <span class="rec-icon"></span>
      <span class="rec-text">REC</span>
    </button>

  {:else if isStopping}
    <!-- Clean saving state — no buttons, just status -->
    <div class="saving-state" aria-live="polite">
      <span class="saving-dot"></span>
      <span class="saving-label">{isFr ? 'Sauvegarde en cours…' : 'Saving recording…'}</span>
    </div>

  {:else if canControl}
    <div class="active-controls">
      <!-- Pause / Resume -->
      {#if isRecording}
        <button
          class="ctrl-btn pause-btn"
          onclick={() => onpause?.()}
          aria-label="Pause"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <rect x="3" y="2" width="4" height="12" rx="1"/>
            <rect x="9" y="2" width="4" height="12" rx="1"/>
          </svg>
          {isFr ? 'PAUSE' : 'PAUSE'}
        </button>
      {:else}
        <button
          class="ctrl-btn resume-btn"
          onclick={() => onresume?.()}
          aria-label="Resume"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2l10 6-10 6V2z"/>
          </svg>
          {isFr ? 'REPRENDRE' : 'RESUME'}
        </button>
      {/if}

      <!-- End meeting — triggers dialog -->
      <button
        class="ctrl-btn end-btn"
        onclick={requestStop}
        aria-label="End meeting"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M8 3v5l3 3"/>
          <circle cx="8" cy="8" r="6"/>
        </svg>
        {isFr ? 'TERMINER' : 'END'}
      </button>
    </div>

  {:else}
    <!-- Stopped / other states — no controls shown here -->
  {/if}
</div>

<!-- Confirmation dialog — shown above everything when user taps END -->
{#if showEndDialog}
  <EndMeetingDialog
    onconfirm={onConfirmStop}
    oncancel={onCancelStop}
  />
{/if}

<style>
  .controls {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--sp-3) 0;
  }

  /* ── REC button ── */
  .rec-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    width: 88px;
    height: 88px;
    border-radius: 50%;
    border: 4px solid var(--red);
    background: var(--red-dim);
    color: var(--red);
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: 0.9rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    transition: all var(--t-med);
    -webkit-tap-highlight-color: transparent;
    box-shadow: 0 0 30px #ef444422;
  }
  .rec-btn:hover  { background: var(--red); color: #fff; box-shadow: 0 0 50px #ef444466; }
  .rec-btn:active { transform: scale(0.94); }

  .rec-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--red);
    transition: background var(--t);
  }
  .rec-btn:hover .rec-icon { background: #fff; }

  .rec-text {
    font-size: 0.7rem;
    font-weight: 900;
    letter-spacing: 0.18em;
  }

  /* ── Active controls ── */
  .active-controls {
    display: flex;
    gap: var(--sp-4);
    align-items: center;
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-5);
    border-radius: var(--r-lg);
    border: 2px solid;
    background: transparent;
    font-family: var(--font-sans);
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all var(--t);
    -webkit-tap-highlight-color: transparent;
    min-height: 52px;
    min-width: 100px;
    justify-content: center;
  }
  .ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ctrl-btn:active:not(:disabled) { transform: scale(0.96); }

  .pause-btn  { border-color: var(--orange); color: var(--orange); }
  .pause-btn:hover:not(:disabled) { background: var(--orange); color: #000; }

  .resume-btn { border-color: var(--blue-bright); color: var(--blue-bright); }
  .resume-btn:hover:not(:disabled) { background: var(--blue); color: #fff; }

  /* End meeting — neutral, not alarming, but clear */
  .end-btn {
    border-color: rgba(255,255,255,0.25);
    color: var(--ev-text-dim);
  }
  .end-btn:hover:not(:disabled) {
    border-color: var(--ev-danger);
    color: var(--ev-danger);
    background: rgba(229,72,77,0.08);
  }

  .saving-state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-5);
    min-height: 52px;
  }

  .saving-label {
    font-family: var(--font-sans);
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    color: var(--ev-text-dim);
  }

  .saving-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ev-text-dim);
    animation: pulse-dot 0.8s ease-in-out infinite;
    flex-shrink: 0;
  }
</style>
