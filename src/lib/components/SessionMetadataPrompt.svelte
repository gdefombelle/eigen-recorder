<script module lang="ts">
  // Persists across component remounts — one geolocation request per session
  const _geoCache: { done: boolean; address: string; error: string; lat: number | null; lng: number | null } =
    { done: false, address: '', error: '', lat: null, lng: null };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { CreateSessionParams, RecordableKnowledgeSession, CaptureProfile, AudioSource } from '$lib/recorder/types';
  import { SESSION_TYPE_LABELS, CAPTURE_PROFILES } from '$lib/recorder/types';
  import { apiGetRecordableSessions, apiGetThreads, type RecordableThread } from '$lib/auth/api';
  import { getCurrentPosition, formatCoords } from '$lib/recorder/geolocation';
  import { langStore, t } from '$lib/i18n/index';
  import { authStore, isAuthenticated } from '$lib/auth/auth';

  let { loading = false, onsubmit, oncancel }: {
    loading?: boolean;
    onsubmit?: (params: CreateSessionParams) => void;
    oncancel?: () => void;
  } = $props();

  // ── Form fields ──────────────────────────────────────────────
  let title:           string = $state('');
  let subject:         string = $state('');
  let agenda:          string = $state('');
  let participantsRaw: string = $state('');
  let location_label:  string = $state('');
  let threads: RecordableThread[] = $state([]);
  let threadsLoading = $state(false);
  let selectedThreadId: string | null = $state(null);
  let threadsLoadedForToken: string | null = $state(null);

  // ── Capture profile (replaces session_type dropdown) ─────────
  // When a planned session is selected, profile is null — the session carries its own type.
  let selectedProfile: CaptureProfile | null = $state(CAPTURE_PROFILES[0]); // default: Notes

  // ── Audio source (for profiles that may have online audio) ───
  // 'microphone_only' is the default and the only mode Recorder captures natively.
  // System audio profiles show the Companion recommendation.
  let audioSource: AudioSource = $state('microphone_only');

  // ── Remote participants ───────────────────────────────────────
  // null = unanswered / 'not sure', false = No, true = Yes
  let remoteParticipants: boolean | null = $state(null);
  // Whether user chose to continue without Companion despite the recommendation
  let continueWithoutCompanion = $state(false);

  // Raw recorder geolocation — sent alongside location_label as the source of
  // truth at Start time (takes precedence over any app-entered location).
  let geoLat: number | null = $state(null);
  let geoLng: number | null = $state(null);
  let geoFromDevice = $state(false); // true once a real GPS fix has been captured

  // Declared here (before the $derived blocks below that reference it) even though
  // the rest of the planned-session state lives further down with the picker logic.
  // Svelte 5 uses block-scoped `let` — forward references inside $derived are errors.
  let selectedSessionId: string | null = $state(null);

  // ── Mobile viewport detection (for remote-participant warning) ──
  let isMobileViewport = $state(false);

  // ── Derived: should we show Companion check? ─────────────────
  let showCompanionCheck = $derived(
    selectedProfile?.requires_companion_check === true && selectedSessionId === null
  );
  // Remote participants question shown for ALL profiles on new captures (not planned sessions).
  // Notes is intentionally included: a user may start recording a personal note and end up
  // capturing an impromptu interview with a remote caller — the question must always be asked
  // so the metadata faithfully records the session conditions.
  let showRemoteParticipantsQ = $derived(
    selectedProfile !== null && selectedSessionId === null
  );
  let showCompanionRecommendation = $derived(
    (audioSource !== 'microphone_only' || remoteParticipants === true) &&
    !continueWithoutCompanion
  );
  // True when user explicitly chose to continue with microphone-only despite needing system audio.
  // A quality warning must be shown at this point (contract §5: "avertissement clair sur la
  // qualité et la séparation des voix attendues").
  let showMicOnlyWarning = $derived(
    continueWithoutCompanion &&
    (audioSource !== 'microphone_only' || remoteParticipants === true)
  );

  // ── Address autocomplete (Photon / OpenStreetMap — no API key) ───────────

  interface PhotonFeature {
    properties: {
      name?: string;
      street?: string;
      housenumber?: string;
      city?: string;
      postcode?: string;
      country?: string;
      state?: string;
    };
  }

  let suggestions: string[]  = $state([]);
  let suggestOpen = $state(false);
  let suggestLoading = $state(false);
  let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function formatPhotonResult(f: PhotonFeature): string {
    const p = f.properties;
    const parts = [
      p.name !== p.street ? p.name : null,
      p.street ? `${p.street}${p.housenumber ? ' ' + p.housenumber : ''}` : null,
      p.city || p.state,
      p.country,
    ].filter(Boolean);
    return parts.join(', ');
  }

  async function fetchSuggestions(query: string) {
    if (query.length < 3) { suggestions = []; suggestOpen = false; return; }
    suggestLoading = true;

    // AbortSignal.timeout() requires iOS 16+ — use AbortController for broader compat
    const controller = new AbortController();
    const timeoutId  = setTimeout(() => controller.abort(), 5000);

    try {
      const lang = $langStore === 'fr' ? 'fr' : 'en';
      const res  = await fetch(
        `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=6&lang=${lang}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      const json = await res.json();
      suggestions = (json.features as PhotonFeature[])
        .map(formatPhotonResult)
        .filter((s, i, arr) => s && arr.indexOf(s) === i)
        .slice(0, 5);
      suggestOpen = suggestions.length > 0;
    } catch {
      clearTimeout(timeoutId);
      suggestions = [];
    }
    suggestLoading = false;
  }

  function onLocationInput(e: Event) {
    const val = (e.target as HTMLInputElement).value;
    location_label = val;
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => fetchSuggestions(val), 300);
  }

  function pickSuggestion(s: string) {
    location_label = s;
    suggestions    = [];
    suggestOpen    = false;
  }

  function onLocationBlur() {
    // Small delay so click on suggestion registers first
    setTimeout(() => { suggestOpen = false; }, 200);
  }

  // ── Geolocation ──────────────────────────────────────────────
  // Module-level cache — persists across component remounts so we don't
  // re-request location every time the user opens "New Session".
  let geoLoading = $state(false);
  let geoAddress = $state('');
  let geoError   = $state('');

  onMount(() => {
    if (_geoCache.done) {
      geoLoading = false;
      geoAddress = _geoCache.address;
      geoError   = _geoCache.error;
      geoLat     = _geoCache.lat;
      geoLng     = _geoCache.lng;
      geoFromDevice = _geoCache.lat !== null;
      if (!location_label && geoAddress) location_label = geoAddress;
      return;
    }
    _geoCache.done = true;
    geoLoading = true;

    // Use a 6s timeout so the UI doesn't hang if GPS is slow
    const timeout = setTimeout(() => {
      if (geoLoading) { geoLoading = false; /* silent — user sees 🗺 button */ }
    }, 8000);

    getCurrentPosition().then((res) => {
      clearTimeout(timeout);
      if (!res.position) {
        geoError   = res.error ?? 'Location unavailable';
        geoLoading = false;
        return;
      }

      const coords = formatCoords(res.position);
      geoAddress  = coords;
      geoLat      = res.position.latitude;
      geoLng      = res.position.longitude;
      geoFromDevice     = true;
      _geoCache.address = coords;
      _geoCache.lat     = geoLat;
      _geoCache.lng     = geoLng;
      if (!location_label) location_label = coords;
      geoLoading  = false;

      // Background reverse geocoding — non-blocking, uses HTTPS Nominatim
      // Falls back silently if fetch fails in native WebView
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${res.position.latitude}&lon=${res.position.longitude}&format=json&accept-language=${$langStore ?? 'fr'}`,
        { signal: AbortSignal.timeout(5000) }
      )
        .then(r => r.json())
        .then(data => {
          const a = data.address ?? {};
          const parts = [
            a.road    ? `${a.road}${a.house_number ? ' ' + a.house_number : ''}` : null,
            a.city    || a.town || a.village || null,
          ].filter(Boolean);
          const resolved = parts.length ? parts.join(', ') : data.display_name?.split(',').slice(0,2).join(',');
          if (resolved) {
            geoAddress = resolved;
            _geoCache.address = resolved;
            if (location_label === coords) location_label = resolved;
          }
        })
        .catch(() => { /* keep coords fallback silently */ });

    }).catch(() => {
      clearTimeout(timeout);
      geoLoading = false;
      geoError   = 'Location unavailable';
      _geoCache.error = geoError;
    });
  });

  // ── Planned meetings (EigenVertex backend) ────────────────────
  let showMeetingPicker    = $state(false);
  let recordableSessions: RecordableKnowledgeSession[] = $state([]);
  let meetingsLoading      = $state(false);
  let sessionsError        = $state('');
  // selectedSessionId declared earlier (before the $derived blocks that reference it)
  let selectedProjectId:   string | null = $state(null);
  let selectedWorkspaceId: string | null = $state(null);
  let availableThreads = $derived(
    selectedWorkspaceId
      ? threads.filter((thread) => thread.workspace_id === selectedWorkspaceId)
      : threads
  );
  let selectedTargetCorpusId: string | null = $state(null);
  // B2: status of the planned session at the moment of selection (drives start/resume/skip)
  let selectedSessionStatus: string = $state('');
  // B3: pristine values from the planned session — used to detect recorder modifications.
  // Only fields in the recorder form are tracked; location is always recorder-owned.
  let pristineTitle        = $state('');
  let pristineSubject      = $state('');
  let pristineAgenda       = $state('');
  let pristineParticipants = $state('');  // serialized as the raw textarea value

  async function loadRecordableSessions() {
    if (!isAuthenticated()) return;
    meetingsLoading = true;
    sessionsError   = '';
    try {
      recordableSessions = await apiGetRecordableSessions();
    } catch {
      sessionsError      = 'Could not load planned sessions.';
      recordableSessions = [];
    }
    meetingsLoading = false;
  }

  function applyPlannedMeeting(s: RecordableKnowledgeSession) {
    selectedSessionId      = s.id;
    selectedSessionStatus  = s.status;          // B2: store for start/resume/skip decision
    selectedProjectId      = s.project_id ?? null;
    selectedWorkspaceId    = s.workspace_id ?? null;
    selectedTargetCorpusId = s.target_corpus_id ?? null;
    selectedThreadId        = s.thread_id ?? null;
    // session_type is owned by the planned session — no profile picker shown
    selectedProfile   = null;

    // Pre-fill form fields from the planned session.
    // Also snapshot pristine values (B3) so submit() can detect recorder modifications.
    title             = s.title;
    subject           = s.subject ?? '';
    agenda            = s.agenda ?? '';
    const rawParticipants = s.participants?.length ? s.participants.join('\n') : '';
    participantsRaw   = rawParticipants;

    // Pristine values are trimmed to match how submit() reads the form fields (title.trim() etc.).
    // Storing raw would cause a false positive when the server returns trailing whitespace.
    pristineTitle        = (s.title   ?? '').trim();
    pristineSubject      = (s.subject ?? '').trim();
    pristineAgenda       = (s.agenda  ?? '').trim();
    pristineParticipants = rawParticipants;

    // Pre-fill location from planned session, but recorder's GPS remains the source of
    // truth and will override this at Start time via recorder-sync.
    if (s.location_label && !location_label) location_label = s.location_label;
    showMeetingPicker = false;
  }

  function clearSession() {
    selectedSessionId      = null;
    selectedSessionStatus  = '';
    selectedProjectId      = null;
    selectedWorkspaceId    = null;
    selectedTargetCorpusId = null;
    selectedThreadId        = null;
    pristineTitle        = '';
    pristineSubject      = '';
    pristineAgenda       = '';
    pristineParticipants = '';
    title             = '';
    subject           = '';
    agenda            = '';
    participantsRaw   = '';
    selectedProfile   = CAPTURE_PROFILES[0]; // restore Notes default
    audioSource       = 'microphone_only';
    remoteParticipants = null;
    continueWithoutCompanion = false;
  }

  // ── STT (Web Speech API) ─────────────────────────────────────
  type FieldName = 'title' | 'subject' | 'agenda' | 'participants';
  let sttActive: FieldName | null = $state(null);
  let sttSupported = $state(false);

  onMount(() => {
    sttSupported = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
    isMobileViewport = window.matchMedia('(max-width: 600px)').matches;
    loadRecordableSessions();
  });

  // Auth is restored by the parent layout and may complete after this form mounts.
  // Subscribe to the store so the Thread destination appears as soon as the user is
  // authenticated, instead of evaluating isAuthenticated() only once at mount time.
  $effect(() => {
    const user = $authStore;
    if (!user || threadsLoadedForToken === user.token) return;
    threadsLoadedForToken = user.token;
    threadsLoading = true;
    apiGetThreads()
      .then((items) => { threads = items; })
      .catch(() => { threads = []; })
      .finally(() => { threadsLoading = false; });
  });

  function startSTT(field: FieldName) {
    if (!sttSupported) return;
    if (sttActive === field) { sttActive = null; return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.webkitSpeechRecognition ?? w.SpeechRecognition;
    if (!SR) return;

    sttActive = field;
    const rec = new SR();
    rec.lang           = $langStore === 'fr' ? 'fr-FR' : 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (ev: any) => {
      const transcript: string = ev.results[0][0].transcript;
      if (field === 'title')        title           += (title ? ' ' : '') + transcript;
      if (field === 'subject')      subject         += (subject ? ' ' : '') + transcript;
      if (field === 'agenda')       agenda          += (agenda ? '\n' : '') + transcript;
      if (field === 'participants') participantsRaw += (participantsRaw ? '\n' : '') + transcript;
      sttActive = null;
    };
    rec.onerror = () => { sttActive = null; };
    rec.onend   = () => { sttActive = null; };
    rec.start();
  }

  // ── Geo retry (on-demand) ────────────────────────────────────
  async function retryGeo() {
    _geoCache.done  = false; // reset cache to allow retry
    geoLoading      = true;
    geoError        = '';
    const res = await getCurrentPosition();
    if (res.position) {
      const coords = formatCoords(res.position);
      geoAddress = coords;
      geoLat     = res.position.latitude;
      geoLng     = res.position.longitude;
      geoFromDevice     = true;
      _geoCache.address = coords;
      _geoCache.lat     = geoLat;
      _geoCache.lng     = geoLng;
      _geoCache.done    = true;
      if (!location_label) location_label = coords;
      // Background reverse geocoding
      fetch(`https://nominatim.openstreetmap.org/reverse?lat=${res.position.latitude}&lon=${res.position.longitude}&format=json&accept-language=${$langStore ?? 'fr'}`,
        { signal: AbortSignal.timeout(5000) })
        .then(r => r.json())
        .then(data => {
          const a = data.address ?? {};
          const parts = [a.road ? `${a.road}${a.house_number ? ' ' + a.house_number : ''}` : null, a.city || a.town || a.village].filter(Boolean);
          const resolved = parts.length ? parts.join(', ') : null;
          if (resolved) { geoAddress = resolved; _geoCache.address = resolved; }
        }).catch(() => {});
    } else {
      geoError = '';  // silent — no error shown
    }
    geoLoading = false;
  }

  // ── Quick Record — no metadata, starts immediately (Notes profile) ──────────
  function quickRecord() {
    const now  = new Date();
    const time = now.toLocaleTimeString($langStore === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    onsubmit?.({
      title:                `Note ${time}`,
      session_type:         'voice_note',
      capture_profile_id:   'notes',
      subject:              '',
      agenda:               '',
      participants:         [],
      location_label:       location_label.trim() || null,
      geo_lat:              geoFromDevice ? geoLat : null,
      geo_lng:              geoFromDevice ? geoLng : null,
      project_id:           null,
      workspace_id:         null,
      target_corpus_id:     null,
      thread_id:            selectedThreadId,
      knowledge_intent:     'personal_note',
      target_type:          'inbox',
      audio_source:         'microphone_only',
      remote_participants:  null,
      knowledge_session_id: null,
      recorder_surface:     'record_now',
    });
  }

  // ── Submit ───────────────────────────────────────────────────
  async function submit() {
    if (!title.trim() && !selectedSessionId) return;

    // For planned sessions, session_type comes from the backend session.
    // For new captures, it comes from the selected profile.
    const profile      = selectedProfile;
    const plannedSess  = selectedSessionId
      ? recordableSessions.find(s => s.id === selectedSessionId)
      : null;
    const sessionType  = (plannedSess?.session_type ?? profile?.session_type ?? 'meeting') as import('$lib/recorder/types').KnowledgeSessionType;

    // B3: for flow A, build the set of fields the recorder actually modified.
    // Fields equal to their pristine planned-session values are omitted from recorder-sync.
    // For flow B/C (no planned session), recorder_modified_fields is undefined — all fields
    // are recorder-owned by definition.
    let recorderModifiedFields: Set<'title' | 'subject' | 'agenda' | 'participants'> | undefined;
    if (selectedSessionId) {
      recorderModifiedFields = new Set();
      if (title.trim() !== pristineTitle)           recorderModifiedFields.add('title');
      if (subject.trim() !== pristineSubject)       recorderModifiedFields.add('subject');
      if (agenda.trim() !== pristineAgenda)         recorderModifiedFields.add('agenda');
      if (participantsRaw !== pristineParticipants) recorderModifiedFields.add('participants');
    }

    onsubmit?.({
      title:                title.trim() || ($langStore === 'fr' ? 'Session sans titre' : 'Untitled session'),
      session_type:         sessionType,
      capture_profile_id:   profile?.id ?? undefined,
      interaction_subtype:  plannedSess
        ? (plannedSess.interaction_subtype ?? null)
        : (profile?.interaction_subtype ?? null),
      business_context:     plannedSess
        ? (plannedSess.business_context ?? null)
        : (profile?.business_context ?? null),
      subject:              subject.trim(),
      agenda:               agenda.trim(),
      participants:         participantsRaw.split('\n').map(p => p.trim()).filter(Boolean),
      location_label:       location_label.trim() || null,
      geo_lat:              geoFromDevice ? geoLat : null,
      geo_lng:              geoFromDevice ? geoLng : null,
      project_id:           selectedProjectId,
      workspace_id:         selectedWorkspaceId,
      target_corpus_id:     selectedTargetCorpusId,
      thread_id:            selectedThreadId,
      knowledge_intent:     plannedSess
        ? (plannedSess.knowledge_intent ?? undefined)
        : (profile?.knowledge_intent ?? (selectedProjectId ? 'operate_project' : 'undecided')),
      target_type:          selectedTargetCorpusId ? 'corpus' : selectedProjectId ? 'project' : 'inbox',
      audio_source:         audioSource,
      remote_participants:  remoteParticipants,
      knowledge_session_id: selectedSessionId,
      // B2: pass planned session status so the store can pick start / resume / skip
      planned_session_status: selectedSessionStatus || undefined,
      // B3: set of fields the recorder modified — undefined for flow B/C
      recorder_modified_fields: recorderModifiedFields,
      recorder_surface:     selectedSessionId ? 'existing_session_form' : 'new_session_form',
    });
  }
</script>

<form class="metadata-form animate-slide-up" onsubmit={(e) => { e.preventDefault(); void submit(); }}>

  <!-- ── A. Dictaphone / Quick Record ── -->
  <div class="qr-section">
    <button type="button" class="quick-rec-btn" onclick={quickRecord} disabled={loading}>
      <div class="qr-badge-row">
        <span class="qr-mode-badge">DICTAPHONE MODE</span>
      </div>
      <div class="qr-main-row">
        <span class="qr-icon-wrap" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="2" width="6" height="12" rx="3"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="22"/>
            <line x1="8" y1="22" x2="16" y2="22"/>
          </svg>
        </span>
        <div class="quick-rec-text">
          <span class="quick-rec-title">{$langStore === 'fr' ? 'Enregistrer maintenant' : 'Record now'}</span>
          <span class="quick-rec-sub">
            {#if loading}
              {$langStore === 'fr' ? 'Création en cours…' : 'Starting…'}
            {:else}
              {$langStore === 'fr' ? 'Sans remplir — note rapide, idée, interview impro' : 'No form — quick note, idea, unplanned interview'}
            {/if}
          </span>
        </div>
        {#if loading}
          <span class="spinner-xs" style="margin-left:auto; flex-shrink:0"></span>
        {:else}
          <svg class="qr-arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6 3l5 5-5 5"/>
          </svg>
        {/if}
      </div>
    </button>
    <p class="qr-legend">
      {$langStore === 'fr'
        ? "Un tap. L'enregistrement démarre sur l'écran suivant — la localisation et l'heure sont capturées automatiquement."
        : "One tap. It's already listening on the next screen — location and time are captured for you."}
    </p>
  </div>

  <!-- ── B. Separator ── -->
  <div class="or-divider">
    <span>{$langStore === 'fr' ? '— OU PRÉPARER UNE SESSION —' : '— OR PREPARE A SESSION INSTEAD —'}</span>
  </div>

  <!-- ── C. Prepare a session panel ── -->
  <div class="prepare-panel">

    <div class="prepare-header">
      <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="1" y="1" width="12" height="12" rx="1.5"/>
        <line x1="3.5" y1="4.5" x2="10.5" y2="4.5"/>
        <line x1="3.5" y1="7"   x2="10.5" y2="7"/>
        <line x1="3.5" y1="9.5" x2="7.5"  y2="9.5"/>
      </svg>
      <span>{$langStore === 'fr' ? 'PRÉPARER UNE SESSION' : 'PREPARE A SESSION'}</span>
    </div>

    <!-- ── Planned meetings picker ── -->
    {#if isAuthenticated()}
      <div class="planned-section">
        <button
          type="button"
          class="planned-toggle"
          class:is-selected={selectedSessionId !== null}
          onclick={() => showMeetingPicker = !showMeetingPicker}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" style="flex-shrink:0">
            <rect x="1" y="2" width="12" height="11" rx="1.5"/>
            <path d="M4 1v2M10 1v2M1 6h12"/>
          </svg>

          {#if selectedSessionId}
            <span class="planned-toggle-label">
              {recordableSessions.find(s => s.id === selectedSessionId)?.title ?? 'Session selected'}
            </span>
            <span
              class="clear-session-btn"
              role="button"
              tabindex="0"
              aria-label="Clear selection"
              onclick={(e) => { e.stopPropagation(); clearSession(); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); clearSession(); } }}
            >✕</span>
          {:else}
            <span class="planned-toggle-label">Pick a planned meeting</span>
            {#if meetingsLoading}
              <span class="spinner-xs" style="margin-left:auto"></span>
            {:else}
              <span class="toggle-arrow">{showMeetingPicker ? '▲' : '▼'}</span>
            {/if}
          {/if}
        </button>

        {#if showMeetingPicker}
          <div class="meeting-picker animate-fade-in">
            {#if meetingsLoading}
              <div class="picker-empty"><span class="spinner-xs"></span> Loading…</div>
            {:else if sessionsError}
              <div class="picker-empty picker-error">{sessionsError}</div>
            {:else if recordableSessions.length === 0}
              <div class="picker-empty">
                No planned sessions found.<br>
                <span class="picker-hint">Schedule sessions in EigenVertex to see them here.</span>
              </div>
            {:else}
              {#each recordableSessions as s (s.id)}
                <button
                  type="button"
                  class="meeting-item"
                  class:active={s.id === selectedSessionId}
                  onclick={() => applyPlannedMeeting(s)}
                >
                  <div class="mi-header">
                    <span class="mi-title">{s.title}</span>
                    <div class="mi-badges">
                      {#if s.is_live}<span class="badge badge-live">LIVE</span>{/if}
                      {#if s.can_resume_recording}<span class="badge badge-resume">Resume</span>{/if}
                    </div>
                  </div>
                  <div class="mi-meta">
                    {SESSION_TYPE_LABELS[s.session_type] ?? s.session_type}{s.workspace_name ? ' · ' + s.workspace_name : ''}
                  </div>
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Location with autocomplete ── -->
    <div class="form-field">
      <label for="location">{$langStore === 'fr' ? 'Lieu' : 'Location'}</label>
      <div class="autocomplete-wrap">
        <div class="input-wrap">
          <input
            id="location"
            class="input"
            type="text"
            value={location_label}
            placeholder={$langStore === 'fr' ? 'ex. Bureau client, Paris…' : 'e.g. Client office, Paris…'}
            autocomplete="off"
            oninput={onLocationInput}
            onblur={onLocationBlur}
            onfocus={() => { if (suggestions.length) suggestOpen = true; }}
          />
          <span class="geo-status">
            {#if suggestLoading}
              <span class="spinner-xs"></span>
            {:else if geoLoading}
              <span class="spinner-xs"></span>
            {:else if geoAddress}
              <button type="button" class="mic-btn geo-btn"
                title={$langStore === 'fr' ? 'Ma position' : 'My location'}
                onclick={() => pickSuggestion(geoAddress)}>📍</button>
            {:else}
              <button type="button" class="mic-btn geo-btn"
                title={$langStore === 'fr' ? 'Détecter ma position' : 'Detect location'}
                onclick={retryGeo}>🗺</button>
            {/if}
          </span>
        </div>

        <!-- Suggestions dropdown -->
        {#if suggestOpen && suggestions.length > 0}
          <div class="suggest-dropdown" role="listbox">
            {#each suggestions as s}
              <button
                type="button"
                class="suggest-item"
                role="option"
                aria-selected={location_label === s}
                onmousedown={(e) => { e.preventDefault(); pickSuggestion(s); }}
              >
                <span class="suggest-icon">📍</span>
                <span class="suggest-text">{s}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- GPS suggestion chip -->
        {#if geoAddress && location_label !== geoAddress && !suggestOpen}
          <button type="button" class="geo-suggest" onclick={() => pickSuggestion(geoAddress)}>
            📍 {geoAddress}
          </button>
        {/if}
      </div>
    </div>

    <!-- ── Explicit Thread destination ── -->
    {#if isAuthenticated()}
      <div class="form-field">
        <label for="thread-destination">Thread destination <span style="font-weight:400;opacity:.65">(optional)</span></label>
        <select id="thread-destination" class="input" bind:value={selectedThreadId} disabled={threadsLoading}>
          <option value={null}>Let Eigen route automatically</option>
          {#each availableThreads as thread (thread.id)}
            <option value={thread.id}>{thread.title}{thread.workspace_id ? '' : ' · Private'}</option>
          {/each}
        </select>
        <small class="field-hint">Choose a pre-created Thread to skip triage. Leave this empty for automatic routing. Create Threads in Eigen Studio.</small>
      </div>
    {/if}

    <!-- ── Capture profile grid (hidden when a planned session is selected) ── -->
    {#if selectedSessionId === null}
      <div class="form-field">
        <label>Session Type</label>
        <div class="profile-grid">
          {#each CAPTURE_PROFILES as p (p.id)}
            <button
              type="button"
              class="profile-card"
              class:selected={selectedProfile?.id === p.id}
              onclick={() => {
                selectedProfile = p;
                audioSource = 'microphone_only';
                remoteParticipants = null;
                continueWithoutCompanion = false;
              }}
            >
              <span class="profile-icon">{p.icon}</span>
              <span class="profile-label">{$langStore === 'fr' ? p.labelFr : p.label}</span>
            </button>
          {/each}
        </div>
      </div>

      <!-- ── Audio source question (for profiles with online content) ── -->
      {#if showCompanionCheck}
        <div class="form-field companion-section">
          <label>Does this session include remote or online audio?</label>
          <div class="audio-source-btns">
            <button type="button" class="source-btn" class:selected={audioSource === 'microphone_only'}
              onclick={() => { audioSource = 'microphone_only'; continueWithoutCompanion = false; }}>
              No, microphone only
            </button>
            <button type="button" class="source-btn" class:selected={audioSource === 'system_audio_only'}
              onclick={() => { audioSource = 'system_audio_only'; continueWithoutCompanion = false; }}>
              Yes, system audio only
            </button>
            <button type="button" class="source-btn" class:selected={audioSource === 'system_and_microphone'}
              onclick={() => { audioSource = 'system_and_microphone'; continueWithoutCompanion = false; }}>
              Yes, system + microphone
            </button>
          </div>
        </div>
      {/if}

      <!-- ── Remote participants question ── -->
      {#if showRemoteParticipantsQ}
        <div class="form-field">
          <label>Will any participants join remotely?</label>
          <div class="audio-source-btns">
            <button type="button" class="source-btn" class:selected={remoteParticipants === false}
              onclick={() => { remoteParticipants = false; continueWithoutCompanion = false; }}>
              No
            </button>
            <button type="button" class="source-btn" class:selected={remoteParticipants === true}
              onclick={() => { remoteParticipants = true; continueWithoutCompanion = false; }}>
              Yes
            </button>
            <button type="button" class="source-btn" class:selected={remoteParticipants === null}
              onclick={() => { remoteParticipants = null; continueWithoutCompanion = false; }}>
              Not sure
            </button>
          </div>

          <!-- ── D. Mobile + remote warning ── -->
          {#if remoteParticipants === true && isMobileViewport}
            <div class="mobile-remote-warning">
              <svg class="mrw-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div class="mrw-body">
                <strong class="mrw-title">Won't work well on mobile</strong>
                <span class="mrw-text">Capturing a remote participant needs a bigger picture. For hybrid meetings, use Eigen Desktop instead.</span>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      <!-- ── Companion recommendation ── -->
      {#if showCompanionRecommendation}
        <div class="companion-rec">
          <div class="companion-rec-header">
            <span class="companion-rec-icon">💡</span>
            <strong>Recommended: use Eigen Companion for system audio.</strong>
          </div>
          <p class="companion-rec-body">
            It captures computer audio directly, gives better quality and is less sensitive
            to room noise.
            {#if remoteParticipants === true}
              For remote participants, Companion is required to avoid speaker/microphone feedback loops.
            {/if}
          </p>
          <div class="companion-rec-actions">
            <button type="button" class="btn btn-sm btn-primary companion-open-btn" disabled>
              Open Eigen Companion
            </button>
            <button type="button" class="btn btn-sm btn-ghost"
              onclick={() => { continueWithoutCompanion = true; }}>
              Continue without Companion
            </button>
          </div>
        </div>
      {/if}

      <!-- ── Microphone-only quality warning (shown after "Continue without Companion") ── -->
      {#if showMicOnlyWarning}
        <div class="mic-only-warning">
          <span class="mic-only-icon">⚠</span>
          <div class="mic-only-body">
            <strong>Microphone only — recording without system audio.</strong>
            {#if remoteParticipants === true}
              Remote participants' voices will be picked up through your speaker and may be
              difficult to distinguish or transcribe. For clean remote-voice capture,
              Eigen Companion is required.
            {:else}
              System audio (webinar, video, online content) will not be captured separately.
              Quality depends on your microphone's ability to pick up room sound.
            {/if}
            <button type="button" class="mic-only-undo"
              onclick={() => { continueWithoutCompanion = false; }}>
              ← Reconsider
            </button>
          </div>
        </div>
      {/if}
    {:else}
      <!-- Planned session — show its type as a read-only badge, no profile picker -->
      <div class="form-field">
        <label>Session Type</label>
        <div class="planned-type-badge">
          {SESSION_TYPE_LABELS[recordableSessions.find(s => s.id === selectedSessionId)?.session_type ?? ''] ?? 'Session'}
        </div>
      </div>
    {/if}

    <!-- ── Title ── -->
    <div class="form-field">
      <label for="title">Title <span class="required">*</span></label>
      <div class="input-wrap">
        <input
          id="title"
          class="input"
          class:stt-active={sttActive === 'title'}
          type="text"
          bind:value={title}
          placeholder="e.g. Q3 kickoff with Acme"
          autocomplete="off"
          required
        />
        {#if sttSupported}
          <button type="button" class="mic-btn" class:active={sttActive === 'title'}
            onclick={() => startSTT('title')} title="Dictate">
            {sttActive === 'title' ? '🔴' : '🎙'}
          </button>
        {/if}
      </div>
    </div>

    <!-- ── Subject ── -->
    <div class="form-field">
      <label for="subject">Subject</label>
      <div class="input-wrap">
        <input
          id="subject"
          class="input"
          class:stt-active={sttActive === 'subject'}
          type="text"
          bind:value={subject}
          placeholder="Main topic or objective"
          autocomplete="off"
        />
        {#if sttSupported}
          <button type="button" class="mic-btn" class:active={sttActive === 'subject'}
            onclick={() => startSTT('subject')} title="Dictate">
            {sttActive === 'subject' ? '🔴' : '🎙'}
          </button>
        {/if}
      </div>
    </div>

    <!-- ── Agenda ── -->
    <div class="form-field">
      <label for="agenda">Agenda</label>
      <div class="input-wrap textarea-wrap">
        <textarea
          id="agenda"
          class="textarea"
          class:stt-active={sttActive === 'agenda'}
          bind:value={agenda}
          placeholder="Key points to cover…"
          rows="3"
        ></textarea>
        {#if sttSupported}
          <button type="button" class="mic-btn mic-textarea" class:active={sttActive === 'agenda'}
            onclick={() => startSTT('agenda')} title="Dictate">
            {sttActive === 'agenda' ? '🔴' : '🎙'}
          </button>
        {/if}
      </div>
    </div>

    <!-- ── Participants ── -->
    <div class="form-field">
      <label for="participants">Participants</label>
      <div class="input-wrap textarea-wrap">
        <textarea
          id="participants"
          class="textarea"
          class:stt-active={sttActive === 'participants'}
          bind:value={participantsRaw}
          placeholder="One name per line"
          rows="3"
        ></textarea>
        {#if sttSupported}
          <button type="button" class="mic-btn mic-textarea" class:active={sttActive === 'participants'}
            onclick={() => startSTT('participants')} title="Dictate">
            {sttActive === 'participants' ? '🔴' : '🎙'}
          </button>
        {/if}
      </div>
    </div>

    <!-- ── Actions ── -->
    <div class="form-actions">
      <button type="button" class="btn btn-ghost" onclick={() => oncancel?.()} disabled={loading}>
        Cancel
      </button>
      <button type="submit" class="btn btn-primary btn-lg" disabled={!title.trim() || loading}>
        {#if loading}
          <span class="spinner-sm"></span> Starting…
        {:else if selectedSessionStatus === 'paused'}
          ▶ Resume Session
        {:else if selectedSessionStatus === 'recording'}
          ▶ Rejoin Session
        {:else}
          ▶ Start recording
        {/if}
      </button>
    </div>

  </div><!-- /prepare-panel -->

</form>

<style>
  .metadata-form { display: flex; flex-direction: column; gap: var(--sp-4); }
  .required { color: var(--ev-danger); }

  /* ── A. Dictaphone section ── */
  .qr-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .quick-rec-btn {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    background: linear-gradient(135deg, rgba(59,130,246,0.18), rgba(59,130,246,0.08));
    border: 1.5px solid rgba(154,209,255,0.45);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: var(--font-sans);
    transition: background 120ms, border-color 120ms, box-shadow 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .quick-rec-btn:hover:not(:disabled) {
    background: rgba(59,130,246,0.26);
    border-color: var(--blue-bright);
    box-shadow: 0 0 24px rgba(154,209,255,0.14);
  }
  .quick-rec-btn:active:not(:disabled) { transform: scale(0.99); }
  .quick-rec-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .qr-badge-row { display: flex; align-items: center; }
  .qr-mode-badge {
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.13em;
    text-transform: uppercase;
    color: var(--blue-bright);
  }

  .qr-main-row {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
  }

  .qr-icon-wrap {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--ev-blue);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .quick-rec-text { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .quick-rec-title { font-size: 0.95rem; font-weight: 700; color: var(--blue-bright); }
  .quick-rec-sub   { font-size: 0.82rem; color: rgba(255,255,255,0.65); line-height: 1.4; }

  .qr-arrow {
    flex-shrink: 0;
    margin-left: auto;
    color: var(--blue-bright);
    opacity: 0.7;
  }

  .qr-legend {
    font-size: 0.78rem;
    color: var(--ev-text-dim);
    line-height: 1.5;
    margin: 0;
    padding: 0 2px;
  }

  /* ── B. Separator — extra vertical breathing room ── */
  .or-divider {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    color: var(--ev-orange);
    font-size: 0.8rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-block: var(--sp-2);
  }
  .or-divider::before, .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: rgba(245,158,11,0.3);
  }

  /* ── C. Prepare panel ── */
  .prepare-panel {
    display: flex;
    flex-direction: column;
    gap: var(--sp-4);
    background: var(--ev-card, #12121f);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: 18px;
  }

  .prepare-header {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ev-text-dim);
    font-size: 0.66rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--ev-border);
  }

  /* ── D. Mobile remote warning ── */
  .mobile-remote-warning {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.3);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    margin-top: 6px;
  }
  .mrw-icon {
    flex-shrink: 0;
    color: var(--ev-orange, #f59e0b);
    margin-top: 1px;
  }
  .mrw-body {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .mrw-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--ev-orange, #f59e0b);
    display: block;
  }
  .mrw-text {
    font-size: 0.76rem;
    color: var(--ev-text-dim);
    line-height: 1.5;
  }

  /* ── Geo row ── */
  /* ── Autocomplete ── */
  .autocomplete-wrap { position: relative; display: flex; flex-direction: column; gap: 4px; }

  .geo-status {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
  }

  .suggest-dropdown {
    position: absolute;
    top: calc(100% + 2px);
    left: 0; right: 0;
    background: var(--ev-surface);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    z-index: 100;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  }

  .suggest-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 14px;
    border: none;
    border-bottom: 1px solid var(--ev-border);
    background: none;
    color: var(--ev-text);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: var(--font-sans);
    font-size: 0.85rem;
    transition: background 80ms;
    -webkit-tap-highlight-color: transparent;
  }
  .suggest-item:last-child { border-bottom: none; }
  .suggest-item:hover, .suggest-item[aria-selected="true"] { background: rgba(154,209,255,0.08); }

  .suggest-icon { font-size: 0.85rem; flex-shrink: 0; margin-top: 1px; opacity: 0.7; }
  .suggest-text { line-height: 1.4; }

  /* ── Geo button in location field ── */
  .geo-btn { opacity: 0.7; }
  .geo-btn:hover { opacity: 1; }

  .geo-suggest {
    display: flex;
    align-items: center;
    gap: 4px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.2);
    border-radius: var(--radius-sm);
    color: var(--ev-blue);
    font-size: 0.75rem;
    font-family: var(--font-sans);
    padding: 5px 10px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    margin-top: 4px;
    transition: background 120ms;
  }
  .geo-suggest:hover { background: rgba(154,209,255,0.12); }


  /* ── Profile grid ── */
  .profile-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .profile-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 6px 8px;
    background: var(--ev-card, #12121f);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    cursor: pointer;
    font-family: var(--font-sans);
    transition: border-color 120ms, background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .profile-card:hover { border-color: rgba(154,209,255,0.3); background: rgba(154,209,255,0.04); }
  .profile-card.selected {
    border-color: var(--ev-blue);
    background: var(--ev-blue-bg);
  }
  .profile-icon { font-size: 1.2rem; line-height: 1; }
  .profile-label {
    font-size: 0.68rem;
    font-weight: 600;
    color: var(--ev-text-dim);
    text-align: center;
    line-height: 1.25;
  }
  .profile-card.selected .profile-label { color: var(--ev-blue); }

  /* ── Audio source buttons ── */
  .companion-section { }
  .audio-source-btns {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .source-btn {
    flex: 1;
    min-width: 120px;
    padding: 8px 10px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text-dim);
    font-size: 0.78rem;
    font-family: var(--font-sans);
    cursor: pointer;
    text-align: center;
    transition: border-color 120ms, color 120ms, background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .source-btn:hover { border-color: rgba(154,209,255,0.3); color: var(--ev-text); }
  .source-btn.selected { border-color: var(--ev-blue); color: var(--ev-blue); background: var(--ev-blue-bg); }

  /* ── Companion recommendation block ── */
  .companion-rec {
    background: rgba(59,130,246,0.07);
    border: 1px solid rgba(154,209,255,0.25);
    border-radius: var(--radius-lg);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .companion-rec-header {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    font-size: 0.84rem;
    color: var(--ev-text);
  }
  .companion-rec-icon { font-size: 1rem; flex-shrink: 0; }
  .companion-rec-body {
    font-size: 0.78rem;
    color: var(--ev-text-dim);
    line-height: 1.5;
    margin: 0;
  }
  .companion-rec-actions {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
    margin-top: 2px;
  }
  .companion-open-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* ── Mic-only quality warning (shown after "Continue without Companion") ── */
  .mic-only-warning {
    display: flex;
    gap: 10px;
    background: rgba(245,158,11,0.08);
    border: 1px solid rgba(245,158,11,0.3);
    border-radius: var(--radius-lg);
    padding: 12px 14px;
    font-size: 0.8rem;
  }
  .mic-only-icon { font-size: 1rem; flex-shrink: 0; color: var(--ev-orange, #f59e0b); margin-top: 1px; }
  .mic-only-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--ev-text-dim);
    line-height: 1.5;
  }
  .mic-only-body strong { color: var(--ev-orange, #f59e0b); }
  .mic-only-undo {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.75rem;
    font-family: var(--font-sans);
    cursor: pointer;
    padding: 0;
    margin-top: 2px;
    text-decoration: underline;
    -webkit-tap-highlight-color: transparent;
  }

  /* ── Planned session type badge ── */
  .planned-type-badge {
    display: inline-flex;
    align-items: center;
    padding: 5px 12px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-full, 999px);
    font-size: 0.78rem;
    color: var(--ev-text-dim);
    width: fit-content;
  }

  /* ── Planned meetings ── */
  .planned-section { display: flex; flex-direction: column; gap: var(--sp-2); }

  .planned-toggle {
    display: flex;
    align-items: center;
    gap: 7px;
    background: none;
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text-dim);
    font-size: 0.82rem;
    font-family: var(--font-sans);
    padding: 8px 12px;
    cursor: pointer;
    transition: border-color 120ms, color 120ms;
    width: 100%;
    text-align: left;
  }
  .planned-toggle:hover { border-color: var(--ev-blue); color: var(--ev-text); }
  .planned-toggle.is-selected {
    border-color: var(--ev-blue);
    color: var(--ev-text);
    background: var(--ev-blue-bg);
  }
  .planned-toggle-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .toggle-arrow { margin-left: auto; font-size: 0.65rem; flex-shrink: 0; }

  .clear-session-btn {
    margin-left: auto;
    flex-shrink: 0;
    background: none;
    border: none;
    color: var(--ev-text-dim);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
    line-height: 1;
    transition: color 120ms, background 120ms;
  }
  .clear-session-btn:hover { color: var(--ev-text); background: rgba(255,255,255,0.08); }

  .meeting-picker {
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .picker-empty {
    padding: 16px 14px;
    font-size: 0.82rem;
    color: var(--ev-text-dim);
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 4px;
    align-items: center;
  }
  .picker-hint  { font-size: 0.72rem; color: rgba(255,255,255,0.5); }
  .picker-error { color: var(--ev-danger); }

  .meeting-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--ev-border);
    background: none;
    border-left: none; border-right: none; border-top: none;
    color: var(--ev-text);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: var(--font-sans);
    transition: background 120ms;
  }
  .meeting-item:last-child { border-bottom: none; }
  .meeting-item:hover  { background: rgba(255,255,255,0.04); }
  .meeting-item.active { background: var(--ev-blue-bg); }

  .mi-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .mi-title { font-size: 0.88rem; font-weight: 500; flex: 1; }
  .mi-meta  { font-size: 0.72rem; color: var(--ev-text-dim); }
  .mi-badges { display: flex; gap: 4px; flex-shrink: 0; }

  .badge {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 5px;
    border-radius: 3px;
    line-height: 1.4;
  }
  .badge-live   { background: rgba(229,72,77,0.2); color: var(--ev-danger); }
  .badge-resume { background: var(--ev-blue-bg); color: var(--ev-blue); }

  /* ── Input + mic ── */
  .input-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .textarea-wrap { align-items: flex-start; }

  .input-wrap .input,
  .input-wrap .textarea {
    padding-right: 38px; /* space for mic button */
  }

  .mic-btn {
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 28px;
    height: 28px;
    border: none;
    background: none;
    cursor: pointer;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    transition: background 120ms;
    -webkit-tap-highlight-color: transparent;
    padding: 0;
  }
  .mic-textarea {
    top: 10px;
    transform: none;
  }
  .mic-btn:hover  { background: rgba(255,255,255,0.06); }
  .mic-btn.active { animation: pulse-dot 0.6s ease-in-out infinite; }

  .stt-active { border-color: var(--ev-danger) !important; }

  /* ── Form fields ── */
  .form-field { display: flex; flex-direction: column; gap: 6px; margin: 0; }

  /* ── Actions ── */
  .form-actions {
    display: flex;
    gap: var(--sp-3);
    margin-top: var(--sp-2);
  }
  .form-actions .btn-primary { flex: 1; }

  /* ── Spinners ── */
  .spinner-sm {
    display: inline-block; width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff; border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  .spinner-xs {
    display: inline-block; width: 11px; height: 11px;
    border: 2px solid var(--ev-border);
    border-top-color: var(--ev-blue); border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
</style>
