<!-- RecorderMiniK7 — the main recorder screen, inspired by a field dictaphone. -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import RecordingTimer from './RecordingTimer.svelte';
  import MicLevelMeter from './MicLevelMeter.svelte';
  import RecorderControls from './RecorderControls.svelte';
  import UploadQueueStatus from './UploadQueueStatus.svelte';
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
  $: liveState = store.liveStreamState;

  let loadError = '';

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

  <!-- ── Branded nav bar ── -->
  <nav class="page-nav">
    {#if store.state === 'ready' || isStopped}
      <button class="back-btn" on:click={() => goto('/recorder')}>
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M9 3L4 7.5 9 12"/>
        </svg>
        Back
      </button>
    {:else}
      <div class="nav-spacer"></div>
    {/if}

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

  <!-- ── Session info bar ── -->
  {#if session}
    <div class="session-info-bar">
      <span class="session-type-tag">{SESSION_TYPE_LABELS[session.session_type]}</span>
      <span class="session-title-text">{session.title}</span>
    </div>
  {/if}

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

      <!-- Live stream indicator — during recording in stream mode, and post-stop summary -->
      {#if isStreaming || (isStopped && syncMode === 'stream')}
        <StreamingIndicator
          liveStreamState={liveState}
          framesStreamed={store.framesStreamed}
          pulse={store.streamPulse}
          online={store.isOnline}
        />
      {/if}

      <!-- Mono mic level meter -->
      <div class="level-zone">
        <MicLevelMeter
          level={store.micLevel}
          active={isRecording}
        />
      </div>

      <!-- Safari warning — only on web, not in Capacitor native app -->
      {#if safariLimited && !mimeSupported && !$authStore}
        <div class="warn-box">
          ⚠ Limited audio support in browser. Install to Home Screen for best results.
        </div>
      {/if}

      <!-- Stats & upload queue — only when there's local audio saved -->
      {#if store.chunks.length > 0}
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
            <!-- Was live-streamed via PCM WebSocket -->
            <div class="stream-done" class:stream-failed={liveState === 'failed'}>
              <span class="stream-done-icon">◈</span>
              {#if liveState === 'failed'}
                <span>Stream interrupted — audio may be partial</span>
              {:else}
                <span>{store.framesStreamed} frames streamed to EigenVertex</span>
              {/if}
            </div>
          {/if}

          <button class="btn btn-ghost btn-full" on:click={() => goto('/recorder')}>Back to sessions</button>
        </div>
      {:else if store.state === 'mock_synced'}
        <div class="post-actions animate-fade-in">
          <ShareAudioButton sessionId={localSessionId} chunkCount={store.chunks.length} />
          <div class="synced-msg"><span class="synced-check">✓</span>Synced to EigenVertex{#if session?.remote_session_id} — <code>{session.remote_session_id}</code>{/if}</div>
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
  .nav-spacer { width: 60px; flex-shrink: 0; }

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
  .conn-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: currentColor;
  }
  .conn-badge.online .conn-dot { animation: pulse-dot 2s ease-in-out infinite; }

  /* ── Session info bar (below nav) ── */
  .session-info-bar {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: var(--sp-2) var(--sp-4);
    border-bottom: 1px solid var(--ev-border);
    flex-shrink: 0;
    min-height: 36px;
  }
  .session-type-tag {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--blue-bright);
    background: rgba(154,209,255,0.1);
    padding: 2px 7px;
    border-radius: var(--r-full);
    white-space: nowrap;
    flex-shrink: 0;
  }
  .session-title-text {
    font-size: 0.88rem;
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
  .stream-done.stream-failed {
    background: rgba(245,158,11,0.06);
    border-color: rgba(245,158,11,0.25);
    color: var(--ev-orange);
  }
  .stream-done-icon { color: var(--ev-blue); font-size: 1rem; }
  .stream-failed .stream-done-icon { color: var(--ev-orange); }

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
