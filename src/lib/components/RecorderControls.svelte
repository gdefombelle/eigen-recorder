<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { RecorderState } from '$lib/recorder/types';
  import EndMeetingDialog from './EndMeetingDialog.svelte';
  import { langStore } from '$lib/i18n/index';

  export let state: RecorderState;

  const dispatch = createEventDispatcher<{
    rec:    void;
    pause:  void;
    resume: void;
    stop:   void;
  }>();

  let showEndDialog = false;

  $: isReady     = state === 'ready';
  $: isRecording = state === 'recording_offline';
  $: isPaused    = state === 'paused';
  $: isStopping  = state === 'stopping';
  $: canControl  = isRecording || isPaused;
  $: isFr        = $langStore === 'fr';

  // User taps "End meeting" → show confirmation dialog
  function requestStop() {
    showEndDialog = true;
  }

  // User confirms → stop
  function onConfirmStop() {
    showEndDialog = false;
    dispatch('stop');
  }

  // User changes mind → pause (if recording) + dismiss dialog
  function onCancelStop() {
    showEndDialog = false;
    if (isRecording) {
      dispatch('pause');
    }
    // If already paused, just close — nothing to do
  }
</script>

<div class="controls">
  {#if isReady}
    <button
      class="rec-btn"
      on:click={() => dispatch('rec')}
      aria-label="Start recording"
    >
      <span class="rec-icon"></span>
      <span class="rec-text">REC</span>
    </button>

  {:else if canControl || isStopping}
    <div class="active-controls">
      <!-- Pause / Resume -->
      {#if isRecording}
        <button
          class="ctrl-btn pause-btn"
          on:click={() => dispatch('pause')}
          aria-label="Pause"
          disabled={isStopping}
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
          on:click={() => dispatch('resume')}
          aria-label="Resume"
          disabled={isStopping}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4 2l10 6-10 6V2z"/>
          </svg>
          {isFr ? 'REPRENDRE' : 'RESUME'}
        </button>
      {/if}

      <!-- End meeting — triggers dialog instead of direct stop -->
      <button
        class="ctrl-btn end-btn"
        on:click={requestStop}
        aria-label="End meeting"
        disabled={isStopping}
      >
        {#if isStopping}
          <span class="saving-dot"></span>
          {isFr ? 'SAUVEGARDE…' : 'SAVING…'}
        {:else}
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <path d="M8 3v5l3 3"/>
            <circle cx="8" cy="8" r="6"/>
          </svg>
          {isFr ? 'TERMINER' : 'END'}
        {/if}
      </button>
    </div>

  {:else}
    <!-- Stopped / other states — no controls shown here -->
  {/if}
</div>

<!-- Confirmation dialog — shown above everything when user taps END -->
{#if showEndDialog}
  <EndMeetingDialog
    on:confirm={onConfirmStop}
    on:cancel={onCancelStop}
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

  .saving-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ev-text-dim);
    animation: pulse-dot 0.8s ease-in-out infinite;
  }
</style>
