<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { RecorderState } from '$lib/recorder/types';

  export let state: RecorderState;

  const dispatch = createEventDispatcher<{
    rec:    void;
    pause:  void;
    resume: void;
    stop:   void;
  }>();

  $: isReady     = state === 'ready';
  $: isRecording = state === 'recording_offline';
  $: isPaused    = state === 'paused';
  $: isStopping  = state === 'stopping';
  $: canControl  = isRecording || isPaused;
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
          PAUSE
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
          RESUME
        </button>
      {/if}

      <!-- Stop -->
      <button
        class="ctrl-btn stop-btn"
        on:click={() => dispatch('stop')}
        aria-label="Stop recording"
        disabled={isStopping}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="3" y="3" width="10" height="10" rx="2"/>
        </svg>
        {isStopping ? 'SAVING…' : 'STOP'}
      </button>
    </div>

  {:else}
    <!-- Stopped / other states — no controls shown here -->
  {/if}
</div>

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
    padding: var(--sp-3) var(--sp-6);
    border-radius: var(--r-lg);
    border: 2px solid;
    background: transparent;
    font-family: var(--font-sans);
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
    transition: all var(--t);
    -webkit-tap-highlight-color: transparent;
    min-height: 52px;
    min-width: 110px;
    justify-content: center;
  }
  .ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .ctrl-btn:active:not(:disabled) { transform: scale(0.96); }

  .pause-btn  { border-color: var(--orange);      color: var(--orange); }
  .pause-btn:hover:not(:disabled) { background: var(--orange); color: #000; }

  .resume-btn { border-color: var(--blue-bright); color: var(--blue-bright); }
  .resume-btn:hover:not(:disabled) { background: var(--blue); color: #fff; }

  .stop-btn   { border-color: var(--text-muted);  color: var(--text-dim); }
  .stop-btn:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
</style>
