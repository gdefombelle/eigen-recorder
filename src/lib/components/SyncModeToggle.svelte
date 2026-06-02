<!-- SyncModeToggle — shown in ready state before pressing REC -->
<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { SyncMode } from '$lib/recorder/types';
  import { langStore } from '$lib/i18n/index';
  import { isAuthenticated } from '$lib/auth/auth';
  import { goto } from '$app/navigation';

  const dispatch = createEventDispatcher<{ change: SyncMode }>();

  export let mode:   SyncMode = 'local';
  export let online: boolean  = true;

  $: authed = isAuthenticated();
  $: canStream = authed && online;
  $: isFr = $langStore === 'fr';

  function select(m: SyncMode) {
    mode = m;
    dispatch('change', m);
  }
</script>

<div class="sync-toggle">
  <!-- Local -->
  <button
    type="button"
    class="sync-option"
    class:active={mode === 'local'}
    on:click={() => select('local')}
  >
    <span class="sync-icon">📱</span>
    <div class="sync-label">
      <span class="sync-name">{isFr ? 'Local seulement' : 'Local only'}</span>
      <span class="sync-desc">{isFr ? 'Hors-ligne, sync après' : 'Offline, sync later'}</span>
    </div>
  </button>

  <!-- Stream -->
  <button
    type="button"
    class="sync-option"
    class:active={mode === 'stream'}
    class:disabled={!canStream}
    on:click={() => {
      if (!authed) { goto('/auth?next=' + window.location.pathname); return; }
      if (canStream) select('stream');
    }}
  >
    <span class="sync-icon ev-diamond" class:pulse={mode === 'stream'}>◈</span>
    <div class="sync-label">
      <span class="sync-name">{isFr ? 'Stream EigenVertex' : 'Stream to EigenVertex'}</span>
      <span class="sync-desc">
        {#if !authed}
          <span class="login-hint">{isFr ? 'Connexion requise →' : 'Login required →'}</span>
        {:else if !online}
          {isFr ? 'Pas de réseau' : 'No network'}
        {:else}
          {isFr ? 'Envoi en temps réel' : 'Real-time upload'}
        {/if}
      </span>
    </div>
  </button>
</div>

<style>
  .sync-toggle {
    display: flex;
    gap: 6px;
    padding: 3px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
  }

  .sync-option {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 11px 12px;
    border: none;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    cursor: pointer;
    text-align: left;
    transition: background 120ms, color 120ms;
    color: rgba(255,255,255,0.45);
    font-family: var(--font-sans);
    -webkit-tap-highlight-color: transparent;
  }
  .sync-option:hover:not(.disabled) { background: rgba(255,255,255,0.05); color: var(--ev-text); }
  .sync-option.active {
    background: var(--ev-surface);
    color: var(--ev-text);
    box-shadow: 0 1px 5px rgba(0,0,0,0.5);
  }
  .sync-option.disabled { opacity: 0.4; cursor: default; }

  .sync-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
  }
  .ev-diamond {
    font-size: 1rem;
    color: var(--ev-text-dim);
    transition: color 120ms;
  }
  .sync-option.active .ev-diamond { color: var(--ev-blue); }
  .ev-diamond.pulse { animation: pulse-dot 1.4s ease-in-out infinite; color: var(--ev-blue); }

  .sync-label {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .sync-name {
    font-size: 0.82rem;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sync-desc {
    font-size: 0.65rem;
    color: var(--ev-text-dim);
    opacity: 0.8;
    white-space: nowrap;
  }
  .login-hint { color: var(--ev-blue); }
</style>
