<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import SessionMetadataPrompt from './SessionMetadataPrompt.svelte';
  import type { CreateSessionParams } from '$lib/recorder/types';

  const dispatch = createEventDispatcher<{ cancel: void }>();

  $: isOnline = $recorderStore.isOnline;

  let loading = false;
  let error   = '';

  // Allow retrying in offline mode if backend failed
  let lastParams: CreateSessionParams | null = null;
  let backendError = false;

  async function handleSubmit(ev: CustomEvent<CreateSessionParams>) {
    loading     = true;
    error       = '';
    backendError = false;
    lastParams   = ev.detail;
    try {
      const id = await recorderStore.createSession(ev.detail);
      await goto(`/recorder/session/${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to create session';
      backendError = msg.startsWith('Backend unavailable');
      error = msg;
      loading = false;
    }
  }

  async function continueOffline() {
    if (!lastParams) return;
    loading     = true;
    error       = '';
    backendError = false;
    try {
      // Force offline by removing knowledge_session_id so store skips backend
      const id = await recorderStore.createSession({
        ...lastParams,
        knowledge_session_id: null,
      });
      // Override mode to offline in store
      await goto(`/recorder/session/${id}`);
    } catch (e) {
      error   = e instanceof Error ? e.message : 'Failed to create session';
      loading = false;
    }
  }
</script>

<div class="create-local animate-slide-up">

  <!-- ── Branded nav bar ── -->
  <nav class="page-nav">
    <button class="back-btn" on:click={() => dispatch('cancel')}>
      <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 3L4 7.5 9 12"/>
      </svg>
      Back
    </button>

    <div class="brand">
      <svg class="brand-diamond" width="20" height="20" viewBox="0 0 28 28" fill="none">
        <polygon points="14,1.7 26.3,14 14,26.3 1.7,14" stroke="#9ad1ff" stroke-width="1.5"/>
        <polygon points="14,6.2 21.8,14 14,21.8 6.2,14" stroke="#9ad1ff" stroke-width="0.9" opacity=".65"/>
        <line x1="1.7"  y1="14" x2="6.2"  y2="14" stroke="#9ad1ff" stroke-width="0.9" opacity=".55"/>
        <line x1="21.8" y1="14" x2="26.3" y2="14" stroke="#9ad1ff" stroke-width="0.9" opacity=".55"/>
        <line x1="14"   y1="1.7" x2="14"  y2="6.2" stroke="#9ad1ff" stroke-width="0.9" opacity=".55"/>
        <line x1="14"   y1="21.8" x2="14" y2="26.3" stroke="#9ad1ff" stroke-width="0.9" opacity=".55"/>
        <circle cx="14" cy="14" r="2.4" fill="#e5484d"/>
      </svg>
      <span class="brand-name">EIGEN RECORDER</span>
    </div>

    <div class="conn-badge" class:online={isOnline} class:offline={!isOnline}>
      <span class="conn-dot"></span>
      {isOnline ? 'Online' : 'Offline'}
    </div>
  </nav>

  <!-- ── Page title ── -->
  <div class="page-title-row">
    <h2>New Session</h2>
  </div>

  {#if error}
    <div class="error-msg">
      {backendError ? '⚠ EigenVertex unreachable.' : error}
      {#if backendError}
        <div class="error-actions">
          <button type="button" class="btn btn-sm btn-primary" on:click={continueOffline} disabled={loading}>
            📱 Continue offline
          </button>
          <button type="button" class="btn btn-sm btn-ghost" on:click={() => { error = ''; backendError = false; }}>
            Retry
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <SessionMetadataPrompt
    {loading}
    on:submit={handleSubmit}
    on:cancel={() => dispatch('cancel')}
  />
</div>

<style>
  .create-local {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  /* ── Nav bar ── */
  .page-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 0 10px;
    border-bottom: 1px solid var(--ev-border);
    gap: var(--sp-3);
  }

  .back-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.82rem;
    font-weight: 600;
    font-family: var(--font-sans);
    cursor: pointer;
    padding: 4px 0;
    flex-shrink: 0;
    transition: opacity 120ms;
  }
  .back-btn:hover { opacity: 0.7; }

  .brand {
    display: flex;
    align-items: center;
    gap: 6px;
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
  }
  .brand-diamond { flex-shrink: 0; }
  .brand-name {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ev-text);
    white-space: nowrap;
  }

  .conn-badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: var(--r-full);
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    border: 1px solid;
    flex-shrink: 0;
  }
  .conn-badge.online  { background: var(--green-dim); color: var(--green); border-color: var(--green); }
  .conn-badge.offline { background: var(--red-dim);   color: var(--red);   border-color: var(--red); }
  .conn-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  .conn-badge.online .conn-dot { animation: pulse-dot 2s ease-in-out infinite; }

  /* ── Page title ── */
  .page-title-row { padding: var(--sp-1) 0 0; }
  h2 { font-size: 1.5rem; font-weight: 700; }

  .error-msg {
    background: var(--red-dim);
    border: 1px solid var(--red);
    border-radius: var(--r);
    padding: var(--sp-3) var(--sp-4);
    font-size: 0.875rem;
    color: var(--red);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .error-actions {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
  }
</style>
