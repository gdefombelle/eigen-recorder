<!-- SessionPlayer — synchronized multi-track audio player

  Each LocalKnowledgeSession passed in = one track (or one series within a track
  when multiple sessions share the same device_id).

  Alignment: the earliest started_at across all sessions defines t=0.
  Every other session is delayed by (its started_at − globalStart).
  Within a track, each chunk is scheduled at:
    absoluteStart_s = seriesOffset_s + chunk.start_ms / 1000

  Transport: MediaSource API — all chunks for a session are appended in order to
  one SourceBuffer so the browser handles codec continuity. Playback is driven by
  a master clock; per-track delay is applied at play() time via currentTime offset.

  Mute: per-track audio.muted toggle; gain resets instantly (no AudioContext).
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import type { LocalKnowledgeSession, AudioChunkMetadata } from '$lib/recorder/types';
  import { formatDuration } from '$lib/recorder/utils';
  import { isNative } from '$lib/platform';
  import { EigenAudio } from '$lib/plugins/eigenAudio';

  let { sessions }: { sessions: LocalKnowledgeSession[] } = $props();

  // ── Track model ──────────────────────────────────────────────────────────────

  interface TrackSeries {
    session:        LocalKnowledgeSession;
    startOffset_ms: number;                // from global t=0
    chunks:         AudioChunkMetadata[];
    duration_ms:    number;
  }

  interface Track {
    key:            string;
    label:          string;
    series:         TrackSeries[];
    muted:          boolean;
    audioEl:        HTMLAudioElement | null;
    ms:             MediaSource | null;
    loaded:         boolean;
    loadError:      string;
    // Absolute start of this track's first series from global t=0
    trackOffset_ms: number;
    trackDuration_ms: number;
  }

  let tracks        = $state<Track[]>([]);
  let globalDur_ms  = $state(0);
  let loading       = $state(true);
  let error         = $state('');

  // Playback state
  let isPlaying     = $state(false);
  let elapsed_ms    = $state(0);
  let masterTimer: ReturnType<typeof setInterval> | null = null;
  let masterStart_wallclock = 0; // Date.now() when play started
  let masterStart_elapsed   = 0; // elapsed_ms when play started

  // Refs to audio elements — bound after mount
  let audioRefs: (HTMLAudioElement | null)[] = [];

  // ── Build track model ────────────────────────────────────────────────────────

  onMount(async () => {
    try {
      await buildTracks();
      // Eagerly load all tracks BEFORE showing the play button.
      // On iOS, el.play() must be called synchronously within a user gesture handler.
      // Any await between the click and el.play() causes NotAllowedError (silently
      // swallowed). Pre-loading here means play() never needs to await.
      await ensureAllLoaded();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Impossible de charger l\'audio';
    }
    loading = false;
  });

  onDestroy(stop);

  async function buildTracks() {
    if (sessions.length === 0) return;

    // Global t=0 = earliest started_at (fall back to created_at)
    const getStart = (s: LocalKnowledgeSession) =>
      new Date(s.started_at ?? s.created_at).getTime();
    const globalStart_ms = Math.min(...sessions.map(getStart));

    // Group sessions by device_id (same physical device = same track, multiple series)
    const groups = new Map<string, LocalKnowledgeSession[]>();
    for (const s of sessions) {
      const key = s.device_id ?? s.local_session_id; // fallback: one track per session
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }

    let dur = 0;
    const built: Track[] = [];

    for (const [key, grpSessions] of groups) {
      // Sort series by started_at within the group
      const sorted = [...grpSessions].sort(
        (a, b) => getStart(a) - getStart(b)
      );

      const series: TrackSeries[] = await Promise.all(
        sorted.map(async (s) => {
          const chunks = await offlineStorage.getChunksMeta(s.local_session_id);
          const lastChunkEnd = chunks.at(-1)?.end_ms ?? 0;
          return {
            session:        s,
            startOffset_ms: getStart(s) - globalStart_ms,
            chunks,
            duration_ms:    lastChunkEnd,
          };
        })
      );

      // Track offset = first series' offset; duration = span from first start to last end
      const trackOffset = series[0].startOffset_ms;
      const trackEnd    = Math.max(...series.map(s => s.startOffset_ms + s.duration_ms));

      if (trackEnd > dur) dur = trackEnd;

      // Label: use session title (truncated) or "Piste N"
      const label = sorted[0].title.slice(0, 28) || `Piste ${built.length + 1}`;

      built.push({
        key,
        label,
        series,
        muted:           false,
        audioEl:         null,
        ms:              null,
        loaded:          false,
        loadError:       '',
        trackOffset_ms:  trackOffset,
        trackDuration_ms: trackEnd - trackOffset,
      });
    }

    tracks     = built;
    globalDur_ms = dur;
  }

  // ── Audio loading (MediaSource) ──────────────────────────────────────────────

  // Load the chunks of all series for one track into its MediaSource.
  // MediaSource concatenates chunks in order so the browser manages codec state.

  async function loadTrack(ti: number) {
    const track = tracks[ti];
    const el    = audioRefs[ti];
    if (!el || track.loaded) return;

    const mime      = track.series[0]?.chunks[0]?.mime_type ?? 'audio/webm;codecs=opus';
    const allChunks = track.series.flatMap(s => s.chunks);

    // Native iOS recordings are regular (non-fragmented) M4A — SourceBuffer requires
    // fragmented MP4, so they cannot go through MediaSource regardless of what
    // isTypeSupported() returns. Only webm/opus from the browser MediaRecorder is
    // already fragmented and safe to feed into SourceBuffer.
    if (!mime.includes('webm')) {
      // On iOS native, always prefer mergeChunks — it reads the properly finalized
      // M4A file from disk (Documents/EigenChunks/<sessionId>/). The IndexedDB blob
      // was captured BEFORE AVAudioRecorder.stop() wrote the MOOV atom, so it may
      // be incomplete for sessions recorded before this bug was fixed.
      if (isNative()) {
        const sessionId = track.series[0]?.session.local_session_id;
        if (sessionId) {
          try {
            const result = await EigenAudio.mergeChunks({ sessionId });
            const bytes  = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
            el.src = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
            tracks[ti].loaded = true;
            return;
          } catch { /* files purged or moved — fall through to IndexedDB blobs */ }
        }
      }

      // Fallback: direct blob URL from IndexedDB (valid for sessions recorded after
      // the stop-before-finalize fix, or for non-native/PWA recordings)
      const blobs: Blob[] = [];
      for (const chunk of allChunks) {
        const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
        if (blob) blobs.push(blob);
      }
      if (blobs.length === 0) {
        tracks[ti].loadError = 'Audio non disponible (purgé)';
        return;
      }
      el.src = URL.createObjectURL(new Blob(blobs, { type: mime }));
      tracks[ti].loaded = true;
      return;
    }

    // WebM/Opus (browser MediaRecorder) — already fragmented, use MediaSource
    if (!MediaSource.isTypeSupported(mime)) {
      tracks[ti].loadError = `Format non supporté: ${mime}`;
      return;
    }

    const ms = new MediaSource();
    tracks[ti].ms = ms;
    el.src = URL.createObjectURL(ms);

    await new Promise<void>((resolve, reject) => {
      ms.addEventListener('sourceopen', async () => {
        try {
          const sb = ms.addSourceBuffer(mime);

          const appendBuffer = (buf: ArrayBuffer) =>
            new Promise<void>((res, rej) => {
              sb.addEventListener('updateend', () => res(), { once: true });
              sb.addEventListener('error',    () => rej(new Error('SourceBuffer error')), { once: true });
              sb.appendBuffer(buf);
            });

          for (const series of track.series) {
            for (const chunk of series.chunks) {
              const blob = await offlineStorage.getChunkBlob(chunk.local_chunk_id);
              if (!blob) continue;
              const ab = await blob.arrayBuffer();
              await appendBuffer(ab);
            }
          }

          ms.endOfStream();
          tracks[ti].loaded = true;
          resolve();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          tracks[ti].loadError = `Erreur chargement: ${msg}`;
          reject(e);
        }
      }, { once: true });

      ms.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
    });
  }

  async function ensureAllLoaded() {
    await Promise.all(tracks.map((_, ti) => loadTrack(ti)));
  }

  // ── Playback ─────────────────────────────────────────────────────────────────

  // play() is intentionally NOT async — on iOS, el.play() must be called
  // synchronously within the user gesture event handler. Any await between
  // the click and el.play() causes NotAllowedError. Tracks are pre-loaded
  // in onMount so no loading is needed here.
  function play() {
    if (isPlaying) return;

    masterStart_wallclock = Date.now();
    masterStart_elapsed   = elapsed_ms;

    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti];
      const el    = audioRefs[ti];
      if (!el || track.loadError || !track.loaded) continue;

      el.muted = track.muted;

      const trackLocalTime_ms = elapsed_ms - track.trackOffset_ms;

      if (trackLocalTime_ms < 0) {
        el.currentTime = 0;
        el.pause();
        const delay = -trackLocalTime_ms;
        setTimeout(() => {
          if (isPlaying) el.play().catch((err) => {
            tracks[ti].loadError = `${(err as Error).name}: ${(err as Error).message}`;
          });
        }, delay);
      } else if (trackLocalTime_ms <= track.trackDuration_ms) {
        el.currentTime = trackLocalTime_ms / 1000;
        el.play().catch((err) => {
          tracks[ti].loadError = `${(err as Error).name}: ${(err as Error).message}`;
        });
      }
    }

    isPlaying = true;

    masterTimer = setInterval(() => {
      elapsed_ms = masterStart_elapsed + (Date.now() - masterStart_wallclock);
      if (elapsed_ms >= globalDur_ms) {
        stop();
        elapsed_ms = 0;
      }
    }, 100);
  }

  function pause() {
    if (!isPlaying) return;
    // Snapshot elapsed before stopping timer
    masterStart_elapsed = elapsed_ms;
    if (masterTimer) { clearInterval(masterTimer); masterTimer = null; }
    for (let ti = 0; ti < tracks.length; ti++) {
      audioRefs[ti]?.pause();
    }
    isPlaying = false;
  }

  function stop() {
    if (masterTimer) { clearInterval(masterTimer); masterTimer = null; }
    for (let ti = 0; ti < tracks.length; ti++) {
      const el = audioRefs[ti];
      if (el) { el.pause(); el.currentTime = 0; }
    }
    isPlaying = false;
    elapsed_ms = 0;
  }

  function toggleMute(ti: number) {
    tracks[ti].muted = !tracks[ti].muted;
    const el = audioRefs[ti];
    if (el) el.muted = tracks[ti].muted;
  }

  // Progress click → seek
  function onSeek(e: MouseEvent) {
    const bar = e.currentTarget as HTMLElement;
    const pct = Math.min(1, Math.max(0, e.offsetX / bar.offsetWidth));
    const target_ms = pct * globalDur_ms;
    const wasPlaying = isPlaying;
    pause();
    elapsed_ms = target_ms;
    if (wasPlaying) play();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  // Fraction 0-1 of a series' active time in the global timeline (for the
  // track waveform bar: shows where actual audio is vs silence/gap)
  function seriesFraction(s: TrackSeries): { left: number; width: number } {
    if (globalDur_ms === 0) return { left: 0, width: 0 };
    return {
      left:  s.startOffset_ms / globalDur_ms,
      width: s.duration_ms / globalDur_ms,
    };
  }

  // Current playhead position as fraction in [0, 1]
  let progress = $derived(globalDur_ms > 0 ? elapsed_ms / globalDur_ms : 0);
</script>

<div class="player">

  {#if loading}
    <div class="player-loading">
      <span class="spinner-xs"></span> Chargement…
    </div>

  {:else if error}
    <div class="player-error">{error}</div>

  {:else if tracks.length === 0}
    <div class="player-empty">Aucune piste disponible.</div>

  {:else}

    <!-- ── Tracks ──────────────────────────────────────────────────────────── -->
    <div class="tracks">
      {#each tracks as track, ti}
        <!-- hidden audio element — loaded by loadTrack() -->
        <!-- svelte-ignore a11y_media_has_caption -->
        <audio bind:this={audioRefs[ti]} preload="none"></audio>

        <!-- track row -->
        <div class="track-row">

          <!-- Left column: link icon + label -->
          <div class="track-left">
            {#if ti < tracks.length - 1}
              <!-- vertical link between this track and the next -->
              <div class="link-column" aria-hidden="true">
                <div class="link-line top"></div>
                <svg class="link-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <circle cx="5"  cy="7" r="2.5" stroke="currentColor" stroke-width="1.3"/>
                  <circle cx="9"  cy="7" r="2.5" stroke="currentColor" stroke-width="1.3"/>
                  <line x1="7.5" y1="7" x2="6.5" y2="7" stroke="currentColor" stroke-width="1.3"/>
                </svg>
                <div class="link-line bot"></div>
              </div>
            {:else}
              <div class="link-column-empty" aria-hidden="true"></div>
            {/if}
            <span class="track-label" title={track.label}>{track.label}</span>
          </div>

          <!-- Timeline bar -->
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div class="track-bar" onclick={onSeek} role="slider" aria-label="Avancer" aria-valuemin={0} aria-valuemax={globalDur_ms} aria-valuenow={elapsed_ms}>
            <!-- per-series filled segments (shows where audio actually is) -->
            {#each track.series as series}
              {@const frac = seriesFraction(series)}
              <div
                class="bar-segment"
                style="left:{(frac.left * 100).toFixed(2)}%; width:{(frac.width * 100).toFixed(2)}%"
              ></div>
            {/each}

            <!-- playhead -->
            <div class="playhead" style="left:{(progress * 100).toFixed(2)}%"></div>
          </div>

          <!-- Right column: mute button + load error -->
          <div class="track-right">
            {#if track.loadError}
              <span class="track-err" title={track.loadError}>⚠</span>
            {:else}
              <button
                class="mute-btn"
                class:muted={track.muted}
                onclick={() => toggleMute(ti)}
                aria-label={track.muted ? 'Réactiver' : 'Couper le son'}
                title={track.muted ? 'Réactiver' : 'Couper le son'}
              >
                {#if track.muted}
                  <!-- speaker muted -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>
                  </svg>
                {:else}
                  <!-- speaker on -->
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>
                  </svg>
                {/if}
              </button>
            {/if}
          </div>

        </div>
      {/each}
    </div>

    <!-- ── Transport controls ──────────────────────────────────────────────── -->
    <div class="transport">
      <span class="time-label">{formatDuration(elapsed_ms)} / {formatDuration(globalDur_ms)}</span>

      {#if !isPlaying}
        <button class="ctrl-btn play-btn" onclick={play} aria-label="Lecture">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"/>
          </svg>
        </button>
      {:else}
        <button class="ctrl-btn" onclick={pause} aria-label="Pause">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6"  y="4" width="4" height="16"/>
            <rect x="14" y="4" width="4" height="16"/>
          </svg>
        </button>
      {/if}

      <button class="ctrl-btn stop-btn" onclick={stop} aria-label="Stop">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
        </svg>
      </button>

      <span class="track-count">{tracks.length} piste{tracks.length > 1 ? 's' : ''}</span>
    </div>

  {/if}
</div>

<style>
  .player {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    background: var(--ev-card, rgba(255,255,255,0.03));
    border: 1px solid var(--ev-border, rgba(255,255,255,0.08));
    border-radius: var(--radius-lg, 12px);
    padding: var(--sp-4, 16px);
  }

  /* ── Loading / error / empty ── */
  .player-loading, .player-error, .player-empty {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    font-size: 0.82rem;
    color: var(--ev-text-dim, rgba(255,255,255,0.5));
    padding: var(--sp-2) 0;
  }
  .player-error { color: var(--ev-danger, #e5484d); }

  /* ── Track list ── */
  .tracks {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }

  .track-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    min-height: 36px;
  }

  /* ── Left column: vertical link + label ── */
  .track-left {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 120px;
    flex-shrink: 0;
  }

  .link-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 14px;
    flex-shrink: 0;
    color: var(--ev-blue, #9ad1ff);
    opacity: 0.55;
  }
  .link-line {
    width: 1px;
    flex: 1;
    min-height: 6px;
    background: currentColor;
  }
  .link-icon { flex-shrink: 0; }
  .link-column-empty { width: 14px; flex-shrink: 0; }

  .track-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--ev-text-dim, rgba(255,255,255,0.6));
    letter-spacing: 0.02em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  /* ── Track bar ── */
  .track-bar {
    flex: 1;
    height: 28px;
    background: rgba(255,255,255,0.05);
    border-radius: 4px;
    position: relative;
    cursor: pointer;
    overflow: hidden;
  }
  .track-bar:hover { background: rgba(255,255,255,0.08); }

  .bar-segment {
    position: absolute;
    top: 0;
    height: 100%;
    background: rgba(154,209,255,0.22);
    border-radius: 3px;
  }

  .playhead {
    position: absolute;
    top: 0;
    height: 100%;
    width: 2px;
    background: var(--ev-blue, #9ad1ff);
    transform: translateX(-1px);
    pointer-events: none;
    border-radius: 1px;
  }

  /* ── Right column: mute ── */
  .track-right {
    width: 28px;
    flex-shrink: 0;
    display: flex;
    justify-content: center;
  }

  .mute-btn {
    width: 28px;
    height: 28px;
    background: none;
    border: 1px solid var(--ev-border, rgba(255,255,255,0.08));
    border-radius: var(--radius-sm, 6px);
    color: var(--ev-text-dim, rgba(255,255,255,0.5));
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: color 120ms, border-color 120ms, background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .mute-btn:hover   { color: var(--ev-text, #fff); border-color: rgba(255,255,255,0.2); }
  .mute-btn.muted   { color: var(--ev-danger, #e5484d); border-color: rgba(229,72,77,0.35); background: rgba(229,72,77,0.06); }

  .track-err {
    font-size: 0.9rem;
    color: var(--ev-danger, #e5484d);
    cursor: default;
  }

  /* ── Transport ── */
  .transport {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding-top: var(--sp-2);
    border-top: 1px solid var(--ev-border, rgba(255,255,255,0.06));
  }

  .time-label {
    font-size: 0.72rem;
    font-family: var(--font-mono, monospace);
    color: var(--ev-text-dim, rgba(255,255,255,0.5));
    min-width: 80px;
    font-variant-numeric: tabular-nums;
  }

  .ctrl-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: none;
    border: 1px solid var(--ev-border, rgba(255,255,255,0.1));
    border-radius: var(--radius-sm, 6px);
    color: var(--ev-text, #fff);
    cursor: pointer;
    transition: background 120ms, border-color 120ms;
    -webkit-tap-highlight-color: transparent;
    padding: 0;
  }
  .ctrl-btn:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.18); }
  .play-btn { background: var(--ev-blue-bg, rgba(154,209,255,0.08)); border-color: rgba(154,209,255,0.3); color: var(--ev-blue, #9ad1ff); }
  .play-btn:hover { background: rgba(154,209,255,0.14); }
  .stop-btn { color: var(--ev-text-dim, rgba(255,255,255,0.5)); }

  .track-count {
    margin-left: auto;
    font-size: 0.7rem;
    color: var(--ev-text-dim, rgba(255,255,255,0.35));
    font-family: var(--font-display, monospace);
    letter-spacing: 0.06em;
  }

  /* ── Spinners ── */
  .spinner-xs {
    display: inline-block; width: 11px; height: 11px;
    border: 2px solid var(--ev-border, rgba(255,255,255,0.1));
    border-top-color: var(--ev-blue, #9ad1ff); border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
