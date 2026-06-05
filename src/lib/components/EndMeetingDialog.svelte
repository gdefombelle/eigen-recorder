<!-- EndMeetingDialog — replaces direct STOP button.
     Confirms intent before stopping. If user changes mind → PAUSE + explanation. -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { langStore } from '$lib/i18n/index';

  const dispatch = createEventDispatcher<{
    confirm: void;  // user confirms → stop recording
    cancel:  void;  // user changes mind → pause + explain
  }>();

  $: isFr = $langStore === 'fr';
</script>

<div class="overlay" role="dialog" aria-modal="true">
  <div class="dialog animate-slide-up">

    <!-- Icon -->
    <div class="dialog-icon">
      <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="19" stroke="rgba(229,72,77,0.4)" stroke-width="1.5"/>
        <rect x="13" y="13" width="14" height="14" rx="3" fill="#e5484d"/>
      </svg>
    </div>

    <!-- Title & body -->
    <div class="dialog-body">
      <h2>{isFr ? 'Terminer la réunion ?' : 'End the meeting?'}</h2>
      <p>
        {isFr
          ? "L'enregistrement sera arrêté et la session clôturée."
          : "The recording will be stopped and the session closed."}
      </p>
    </div>

    <!-- Actions -->
    <div class="dialog-actions">
      <!-- Cancel → pause -->
      <button
        type="button"
        class="btn-continue"
        on:click={() => dispatch('cancel')}
      >
        {isFr ? '⏸ Continuer la réunion' : '⏸ Keep recording'}
      </button>

      <!-- Confirm → stop -->
      <button
        type="button"
        class="btn-end"
        on:click={() => dispatch('confirm')}
      >
        {isFr ? 'Terminer' : 'End meeting'}
      </button>
    </div>

  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 999;
    padding: 0 var(--sp-4) calc(var(--sp-8) + env(safe-area-inset-bottom, 0px));
  }

  .dialog {
    width: 100%;
    max-width: 480px;
    background: var(--ev-surface);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: var(--sp-6);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-5);
    text-align: center;
  }

  .dialog-icon { flex-shrink: 0; }

  .dialog-body { display: flex; flex-direction: column; gap: var(--sp-2); }
  .dialog-body h2 {
    font-family: var(--font-display);
    font-size: 1.15rem;
    font-weight: 700;
    color: var(--ev-text);
    margin: 0;
  }
  .dialog-body p {
    font-size: 0.88rem;
    color: var(--ev-text-dim);
    margin: 0;
    line-height: 1.5;
  }

  .dialog-actions {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    width: 100%;
  }

  /* Continue → stays active, prominent */
  .btn-continue {
    width: 100%;
    padding: 14px;
    background: var(--ev-blue-bg);
    border: 1.5px solid var(--ev-blue);
    border-radius: var(--radius-md);
    color: var(--ev-blue);
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-continue:hover { background: rgba(154,209,255,0.15); }

  /* End → destructive, but not screaming */
  .btn-end {
    width: 100%;
    padding: 14px;
    background: rgba(229,72,77,0.1);
    border: 1.5px solid rgba(229,72,77,0.4);
    border-radius: var(--radius-md);
    color: var(--ev-danger);
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 120ms, border-color 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .btn-end:hover { background: rgba(229,72,77,0.2); border-color: var(--ev-danger); }
</style>
