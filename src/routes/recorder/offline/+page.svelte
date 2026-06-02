<!-- /recorder/offline — Full sessions archive + bulk mock-sync -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import OfflineSessionsList from '$lib/components/OfflineSessionsList.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';
  import { formatBytes } from '$lib/recorder/utils';

  $: store = $recorderStore;

  let totalBytes = 0;
  let sessionCount = 0;

  onMount(async () => {
    recorderStore.init();
    totalBytes   = await offlineStorage.getTotalStorageBytes();
    const sessions = await offlineStorage.getAllSessions();
    sessionCount = sessions.length;
  });
</script>

<main>
  <div class="page">
    <div class="header">
      <div class="header-title">Sessions</div>
      <ConnectionStatus online={store.isOnline} />
    </div>

    <div class="content">
      <!-- Storage overview -->
      <div class="storage-card card card-sm animate-fade-in">
        <div class="storage-stats">
          <div class="st-item">
            <span class="st-val">{sessionCount}</span>
            <span class="st-key">sessions</span>
          </div>
          <div class="st-sep">·</div>
          <div class="st-item">
            <span class="st-val">{formatBytes(totalBytes)}</span>
            <span class="st-key">local storage</span>
          </div>
          <div class="st-sep">·</div>
          <div class="st-item">
            <span class="st-val">{store.isOnline ? 'Online' : 'Offline'}</span>
            <span class="st-key">network</span>
          </div>
        </div>
      </div>

      <!-- Sessions list -->
      <div class="list-section">
        <OfflineSessionsList />
      </div>
    </div>
  </div>
</main>

<style>
  main {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }

  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 480px;
    margin: 0 auto;
    width: 100%;
  }

  .storage-card {
    margin-bottom: var(--sp-4);
  }

  .storage-stats {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    flex-wrap: wrap;
  }

  .st-item { display: flex; flex-direction: column; align-items: center; }
  .st-val {
    font-size: 1rem;
    font-weight: 700;
    font-family: var(--font-mono);
    color: var(--text);
  }
  .st-key {
    font-size: 0.6rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  .st-sep { color: rgba(255,255,255,0.25); }

  .list-section { flex: 1; }
</style>
