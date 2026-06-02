<!-- RecorderMiniK7 — the main recorder screen, inspired by a field dictaphone. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import RecordingTimer from './RecordingTimer.svelte';
  import StereoMicMeter from './StereoMicMeter.svelte';
  import OrientationGuide from './OrientationGuide.svelte';
  import RecorderControls from './RecorderControls.svelte';
  import UploadQueueStatus from './UploadQueueStatus.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import OfflineBanner from './OfflineBanner.svelte';
  import { SESSION_TYPE_LABELS } from '$lib/recorder/types';
  import { isSafariLimited, getSupportedMimeType } from '$lib/recorder/audioRecorder';
  import ShareAudioButton from './ShareAudioButton.svelte';
  import { authStore, isAuthenticated } from '$lib/auth/auth';
  import { t, langStore } from '$lib/i18n/index';
  import SyncModeToggle from './SyncModeToggle.svelte';
  import StreamingIndicator from './StreamingIndicator.svelte';

  export let localSessionId: string;

  $: store = $recorderStore;
  $: session = store.currentSession;
  $: isRecording = store.state === 'recording_offline';
  $: isPaused    = store.state === 'paused';
  $: isStopped   = store.state === 'stopped_local' || store.state === 'mock_synced';
  $: isStopping  = store.state === 'stopping';
  $: isUploading = store.state === 'mock_uploading';
  $: hasError    = store.state === 'error';

  $: safariLimited = isSafariLimited();
  $: mimeSupported = getSupportedMimeType();
  $: _lang     = $langStore;
  $: _auth     = $authStore;
  $: authed    = isAuthenticated();
  $: syncMode  = store.syncMode;
  $: isStreaming = isRecording && syncMode === 'stream';

  function onSyncModeChange(e: CustomEvent<never> & { currentTarget: HTMLElement }) {
    // bound via bind:mode — handled reactively
  }

  let loadError = '';
  let guideDismissed = false;

  // Vrai stéréo = les deux canaux ont du signal ET sont différents
  // (évite le faux positif quand un canal est à 0)
  $: isStereo = store.micLevelL > 0.02 && store.micLevelR > 0.02
    && Math.abs(store.micLevelL - store.micLevelR) > 0.01;

  onMount(async () => {
    recorderStore.init();
    try {
      await recorderStore.loadSession(localSessionId);
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load session';
    }
  });

  onDestroy(() => {
    // Only reset if not actively recording — allow background recording
    const s = $recorderStore.state;
    if (s !== 'recording_offline' && s !== 'paused') {
      // Don't reset on navigate away if recording — user might come back
    }
  });

  async function handleRec() {
    if (store.state === 'mic_permission_denied') return;
    await recorderStore.startRecording();
  }

  function handlePause()  { recorderStore.pauseRecording(); }
  function handleResume() { recorderStore.resumeRecording(); }

  async function handleStop() {
    await recorderStore.stopRecording();
  }

  async function handleMockUpload() {
    await recorderStore.mockUpload();
  }
</script>

<div class="k7-shell">

  <!-- ── Offline banner ── -->
  {#if !store.isOnline}
    <OfflineBanner visible />
  {/if}

  <!-- ── Header ── -->
  <div class="k7-header">
    <!-- Back only visible before recording starts — once REC is pressed, STOP is the only exit -->
    {#if store.state === 'ready' || store.state === 'stopped_local' || store.state === 'mock_synced' || isStopped}
      <button class="back-btn" on:click={() => goto('/recorder')}>← Retour</button>
    {:else}
      <div class="back-placeholder"></div>
    {/if}

    <div class="header-info">
      <div class="session-type-label">
        {session ? SESSION_TYPE_LABELS[session.session_type] : '—'}
      </div>
      <div class="session-title-label">
        {session?.title ?? '—'}
      </div>
    </div>

    <ConnectionStatus online={store.isOnline} />
  </div>

  <!-- ── Error state ── -->
  {#if loadError}
    <div class="content center-content">
      <div class="error-card card">
        <div class="error-icon">⚠</div>
        <p>{loadError}</p>
        <button class="btn btn-ghost" on:click={() => goto('/recorder')}>Back</button>
      </div>
    </div>

  {:else if hasError}
    <div class="content center-content">
      <div class="error-card card">
        <div class="error-icon">⚠</div>
        <p>{store.errorMessage ?? 'An error occurred.'}</p>
        <div class="flex gap-3">
          <button class="btn btn-ghost" on:click={() => recorderStore.clearError()}>Dismiss</button>
          <button class="btn btn-primary" on:click={() => goto('/recorder')}>Back</button>
        </div>
      </div>
    </div>

  {:else if store.state === 'mic_permission_denied'}
    <div class="content center-content">
      <div class="perm-card card animate-slide-up">
        <div class="perm-icon">🎙</div>
        <h3>Microphone required</h3>
        <p>{store.errorMessage ?? 'Please allow microphone access to start recording.'}</p>
        {#if safariLimited}
          <div class="safari-note">
            <strong>Safari / iOS note:</strong> Go to Settings → Safari → Microphone and allow access.
            For best results, install this app to the Home Screen (Add to Home Screen).
          </div>
        {/if}
        <button class="btn btn-primary" on:click={() => recorderStore.requestMicrophone()}>
          Request Access Again
        </button>
        <button class="btn btn-ghost" on:click={() => goto('/recorder')}>Back</button>
      </div>
    </div>

  {:else if store.state === 'idle' || store.state === 'creating_local_session'}
    <div class="content center-content">
      <div class="loading-state">
        <span class="spinner-lg"></span>
        <span>Loading session…</span>
      </div>
    </div>

  {:else}
    <!-- ── Main recording UI ── -->
    <!-- Scrollable zone : timer + guide + meters + stats -->
    <div class="content k7-content">

      <!-- Timer -->
      <div class="timer-zone">
        <RecordingTimer
          elapsedMs={store.elapsedMs}
          recording={isRecording}
          paused={isPaused}
        />
      </div>

      <!-- Sync mode toggle — only in ready state, before first REC -->
      {#if store.state === 'ready' && store.chunks.length === 0}
        <SyncModeToggle
          mode={store.syncMode}
          online={store.isOnline}
          on:change={(e) => recorderStore.setSyncMode(e.detail)}
        />
      {/if}

      <!-- Guide d'orientation — dismissable -->
      {#if !guideDismissed && !isStopped && !isUploading}
        <OrientationGuide bind:dismissed={guideDismissed} />
      {/if}

      <!-- Streaming indicator — during recording in stream mode -->
      {#if isStreaming || (isStopped && syncMode === 'stream')}
        <StreamingIndicator
          streamedCount={store.streamedCount}
          totalChunks={store.chunks.length}
          pulse={store.streamPulse}
          online={store.isOnline}
        />
      {/if}

      <!-- Double vumètre stéréo -->
      <div class="level-zone">
        <StereoMicMeter
          levelL={store.micLevelL}
          levelR={store.micLevelR}
          active={isRecording}
          stereo={isStereo}
        />
      </div>

      <!-- Safari warning — only on web, not in Capacitor native app -->
      {#if safariLimited && !mimeSupported && !$authStore}
        <div class="warn-box">
          ⚠ Limited audio support in browser. Install to Home Screen for best results.
        </div>
      {/if}

      <!-- Stats & upload queue (single instance) -->
      {#if store.chunks.length > 0 || isStopped || isUploading}
        <div class="stats-zone card">
          <UploadQueueStatus
            chunks={store.chunks}
            totalSizeBytes={store.totalSizeBytes}
            state={store.state}
            onMockUpload={isStopped ? handleMockUpload : null}
          />
        </div>
      {/if}

      <!-- Post-recording actions (in scroll zone) -->
      {#if isStopped && store.state !== 'mock_synced'}
        <div class="post-actions animate-fade-in">
          <ShareAudioButton sessionId={localSessionId} chunkCount={store.chunks.length} />

          <!-- Show sync button only if NOT streamed during recording -->
          {#if syncMode === 'local'}
            {#if authed}
              <button class="btn btn-ghost btn-full" on:click={handleMockUpload} disabled={isUploading}>
                {isUploading ? '⏳ Syncing…' : '◈ Sync to EigenVertex'}
              </button>
            {:else}
              <button class="signin-sync-btn btn-full" on:click={() => goto(`/auth?next=/recorder/session/${localSessionId}`)}>
                <span class="ev-icon">◈</span>{t().auth.signInToSync}
              </button>
              <p class="signin-sync-hint">{t().auth.signInHint}</p>
            {/if}
          {:else}
            <!-- Was streamed — show summary -->
            <div class="stream-done">
              <span class="stream-done-icon">◈</span>
              <span>{store.streamedCount}/{store.chunks.length} chunks streamed to EigenVertex</span>
            </div>
          {/if}

          <button class="btn btn-ghost btn-full" on:click={() => goto('/recorder')}>Back to sessions</button>
        </div>
      {:else if store.state === 'mock_synced'}
        <div class="post-actions animate-fade-in">
          <ShareAudioButton sessionId={localSessionId} chunkCount={store.chunks.length} />
          <div class="synced-msg"><span class="synced-check">✓</span>Synced — <code>{session?.remote_session_id}</code></div>
          <button class="btn btn-ghost btn-full" on:click={() => goto('/recorder')}>Back to sessions</button>
        </div>
      {:else if isUploading}
        <div class="uploading-state"><span class="spinner-lg"></span><span>Syncing…</span></div>
      {/if}

    </div>

    <!-- ── Controls pinned at bottom — never cut off ── -->
    {#if !isStopped && !isUploading}
      <div class="controls-pinned">
        <RecorderControls
          state={store.state}
          on:rec={handleRec}
          on:pause={handlePause}
          on:resume={handleResume}
          on:stop={handleStop}
        />
      </div>
    {/if}

  {/if}

</div>

<style>
  .k7-shell {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg);
  }

  /* ── Header ── */
  .k7-header {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-3) var(--sp-4);
    border-bottom: 1px solid var(--border-dim);
    flex-shrink: 0;
    min-height: 60px;
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
    transition: opacity 120ms;
  }
  .back-btn:hover { opacity: 0.7; }
  .back-placeholder { width: 60px; flex-shrink: 0; }

  .header-info { flex: 1; min-width: 0; }
  .session-type-label {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--blue-bright);
  }
  .session-title-label {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* ── Content ── */
  .content {
    flex: 1;
    overflow-y: auto;
    padding: var(--sp-4) var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
  }

  .center-content {
    align-items: center;
    justify-content: center;
  }

  /* ── Timer zone ── */
  .timer-zone {
    display: flex;
    justify-content: center;
    padding: var(--sp-2) 0;
  }

  /* ── Level zone ── */
  .level-zone {
    padding: 0 var(--sp-2);
  }

  /* ── Controls pinned at bottom — never cut off ── */
  .controls-pinned {
    flex-shrink: 0;
    display: flex;
    justify-content: center;
    padding: var(--sp-2) var(--sp-5) calc(var(--sp-3) + env(safe-area-inset-bottom, 0px));
    border-top: 1px solid var(--ev-border);
    background: var(--ev-black);
  }

  /* ── Stats ── */
  .stats-zone { margin-top: var(--sp-2); }

  /* ── Post actions ── */
  .post-actions {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }

  /* ── Synced ── */
  .synced-msg {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 0.8rem;
    color: var(--green);
    background: var(--green-dim);
    padding: var(--sp-3) var(--sp-4);
    border-radius: var(--r);
    flex-wrap: wrap;
  }
  .synced-check { font-size: 1.1rem; }
  code {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    background: #002200;
    padding: 2px 6px;
    border-radius: var(--r-sm);
  }

  /* ── Stream done summary ── */
  .stream-done {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.25);
    border-radius: var(--radius-md);
    font-size: 0.82rem;
    color: var(--ev-text-dim);
  }
  .stream-done-icon { color: var(--ev-blue); font-size: 1rem; }

  /* ── Sign-in to sync ── */
  .signin-sync-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.3);
    border-radius: var(--radius-md);
    color: var(--ev-blue);
    font-family: var(--font-display);
    font-size: 0.95rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 120ms, border-color 120ms;
  }
  .signin-sync-btn:hover { background: rgba(154,209,255,0.15); border-color: var(--ev-blue); }
  .ev-icon { font-size: 1.1rem; }

  .signin-sync-hint {
    margin: 0;
    font-size: 0.78rem;
    color: var(--ev-text-dim);
    text-align: center;
    line-height: 1.5;
  }

  /* ── Loading ── */
  .loading-state, .uploading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    color: var(--text-muted);
    font-size: 0.875rem;
    padding: var(--sp-12) 0;
  }

  .spinner-lg {
    display: inline-block;
    width: 36px;
    height: 36px;
    border: 3px solid var(--border);
    border-top-color: var(--blue-bright);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  /* ── Error / permission cards ── */
  .error-card, .perm-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--sp-3);
    text-align: center;
    max-width: 360px;
    width: 100%;
  }
  .error-icon, .perm-icon { font-size: 2.5rem; }
  .error-card p, .perm-card p { font-size: 0.875rem; color: var(--text-dim); }

  .safari-note {
    background: #1a1000;
    border: 1px solid var(--orange);
    border-radius: var(--r);
    padding: var(--sp-3);
    font-size: 0.8rem;
    color: var(--orange);
    text-align: left;
    line-height: 1.5;
  }

  /* ── Warning box ── */
  .warn-box {
    background: #1a1000;
    border: 1px solid var(--orange);
    border-radius: var(--r);
    padding: var(--sp-3) var(--sp-4);
    font-size: 0.78rem;
    color: var(--orange);
    line-height: 1.5;
  }

</style>
