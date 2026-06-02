<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { goto } from '$app/navigation';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import SessionMetadataPrompt from './SessionMetadataPrompt.svelte';
  import type { CreateSessionParams } from '$lib/recorder/types';

  const dispatch = createEventDispatcher<{ cancel: void }>();

  let loading = false;
  let error   = '';

  async function handleSubmit(ev: CustomEvent<CreateSessionParams>) {
    loading = true;
    error   = '';
    try {
      const id = await recorderStore.createSession(ev.detail);
      await goto(`/recorder/session/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to create session';
      loading = false;
    }
  }
</script>

<div class="create-local animate-slide-up">
  <div class="create-header">
    <button class="back-btn" on:click={() => dispatch('cancel')}>← Retour</button>
    <div class="create-title">
      <div class="ev-tag">EIGEN RECORDER</div>
      <h2>New Session</h2>
    </div>
  </div>

  {#if error}
    <div class="error-msg">{error}</div>
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
    gap: var(--sp-5);
  }

  .create-header {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
  }

  .back-btn {
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.85rem;
    font-weight: 600;
    font-family: var(--font-sans);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    margin-top: 4px;
    transition: opacity 120ms;
  }
  .back-btn:hover { opacity: 0.7; }

  .ev-tag {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--blue-bright);
    margin-bottom: 2px;
  }

  h2 { font-size: 1.5rem; font-weight: 700; }

  .error-msg {
    background: var(--red-dim);
    border: 1px solid var(--red);
    border-radius: var(--r);
    padding: var(--sp-3) var(--sp-4);
    font-size: 0.875rem;
    color: var(--red);
  }
</style>
