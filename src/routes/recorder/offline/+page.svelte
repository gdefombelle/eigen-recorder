<!-- /recorder/offline — Full sessions archive + bulk mock-sync -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import OfflineSessionsList from '$lib/components/OfflineSessionsList.svelte';
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
    <!-- ── Branded nav bar ── -->
    <nav class="page-nav">
      <button class="back-btn" on:click={() => goto('/recorder')}>
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
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

      <div class="conn-badge" class:online={store.isOnline} class:offline={!store.isOnline}>
        <span class="conn-dot"></span>
        {store.isOnline ? 'Online' : 'Offline'}
      </div>
    </nav>

    <!-- ── Page title + stats ── -->
    <div class="page-title-row">
      <h2>Sessions</h2>
      <div class="header-stats">
        <span class="hstat">{sessionCount} session{sessionCount !== 1 ? 's' : ''}</span>
        <span class="hstat-sep">·</span>
        <span class="hstat">{formatBytes(totalBytes)}</span>
      </div>
    </div>

    <div class="content">
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

  /* ── Branded nav bar ── */
  .page-nav {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px var(--sp-4);
    border-bottom: 1px solid var(--ev-border);
    flex-shrink: 0;
    min-height: 54px;
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
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
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
  .conn-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
  .conn-badge.online .conn-dot { animation: pulse-dot 2s ease-in-out infinite; }

  /* ── Page title ── */
  .page-title-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-4) var(--sp-4) var(--sp-2);
    border-bottom: 1px solid var(--ev-border);
    flex-shrink: 0;
  }
  h2 { font-size: 1.4rem; font-weight: 700; margin: 0; }

  .header-stats { display: flex; align-items: center; gap: 6px; }
  .hstat {
    font-size: 0.75rem;
    font-family: var(--font-mono);
    color: var(--ev-text-dim);
  }
  .hstat-sep { color: rgba(255,255,255,0.2); font-size: 0.9rem; }

  /* ── Content ── */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-3) var(--sp-4);
  }
  .list-section { flex: 1; }

  @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
</style>
