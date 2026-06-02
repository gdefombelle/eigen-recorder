<script context="module" lang="ts">
  // Persists across component remounts — one geolocation request per session
  const _geoCache = { done: false, address: '', error: '' };
</script>

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { KnowledgeSessionType, CreateSessionParams } from '$lib/recorder/types';
  import { SESSION_TYPE_LABELS } from '$lib/recorder/types';
  import { getCurrentPosition, formatCoords } from '$lib/recorder/geolocation';
  import { langStore, t } from '$lib/i18n/index';
  import { isAuthenticated } from '$lib/auth/auth';

  const dispatch = createEventDispatcher<{ submit: CreateSessionParams; cancel: void }>();

  export let loading = false;

  // ── Form fields ──────────────────────────────────────────────
  let title:           string               = '';
  let session_type:    KnowledgeSessionType = 'project_meeting';
  let subject:         string               = '';
  let agenda:          string               = '';
  let participantsRaw: string               = '';
  let location_label:  string               = '';

  const SESSION_TYPES = Object.entries(SESSION_TYPE_LABELS) as [KnowledgeSessionType, string][];

  $: _lang = $langStore;

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

  let suggestions: string[]  = [];
  let suggestOpen = false;
  let suggestLoading = false;
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
  let geoLoading = false;
  let geoAddress = '';
  let geoError   = '';

  onMount(() => {
    if (_geoCache.done) {
      geoLoading = false;
      geoAddress = _geoCache.address;
      geoError   = _geoCache.error;
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
      _geoCache.address = coords;
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

  // ── Planned meetings (EigenVertex backend — mock) ─────────────
  let showMeetingPicker = false;
  let meetingSearch     = '';
  let plannedMeetings: { id: string; title: string; time: string; participants: string[] }[] = [];
  let meetingsLoading   = false;

  async function loadPlannedMeetings() {
    if (!isAuthenticated()) return;
    meetingsLoading = true;
    // TODO: replace with real EigenVertex API call
    // const res = await request('/sessions/planned?q=' + meetingSearch);
    // plannedMeetings = res.items;
    await new Promise(r => setTimeout(r, 600)); // simulate latency
    plannedMeetings = []; // empty until backend connected
    meetingsLoading = false;
  }

  function applyPlannedMeeting(m: typeof plannedMeetings[0]) {
    title            = m.title;
    participantsRaw  = m.participants.join('\n');
    showMeetingPicker = false;
  }

  $: if (showMeetingPicker) loadPlannedMeetings();

  // ── STT (Web Speech API) ─────────────────────────────────────
  type FieldName = 'title' | 'subject' | 'agenda' | 'participants';
  let sttActive: FieldName | null = null;
  let sttSupported = false;

  onMount(() => {
    sttSupported = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window;
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
      _geoCache.address = coords;
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

  // ── Quick Record — no metadata, starts immediately ───────────
  function quickRecord() {
    const now  = new Date();
    const time = now.toLocaleTimeString($langStore === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    dispatch('submit', {
      title:          $langStore === 'fr' ? `Note ${time}` : `Note ${time}`,
      session_type:   'free_recording',
      subject:        '',
      agenda:         '',
      participants:   [],
      location_label: location_label.trim() || null,
    });
  }

  // ── Submit ───────────────────────────────────────────────────
  function submit() {
    if (!title.trim()) return;
    dispatch('submit', {
      title:          title.trim(),
      session_type,
      subject:        subject.trim(),
      agenda:         agenda.trim(),
      participants:   participantsRaw.split('\n').map(p => p.trim()).filter(Boolean),
      location_label: location_label.trim() || null,
    });
  }
</script>

<form class="metadata-form animate-slide-up" on:submit|preventDefault={submit}>

  <!-- ── Quick Record ── -->
  <button type="button" class="quick-rec-btn" on:click={quickRecord} disabled={loading}>
    <span class="quick-rec-icon">⚡</span>
    <div class="quick-rec-text">
      <span class="quick-rec-title">{$langStore === 'fr' ? 'Enregistrer maintenant' : 'Record now'}</span>
      <span class="quick-rec-sub">{$langStore === 'fr' ? 'Sans remplir — note rapide, idée, interview impro' : 'No form — quick note, idea, unplanned interview'}</span>
    </div>
    <span class="quick-rec-arrow">▶</span>
  </button>

  <div class="or-divider"><span>{$langStore === 'fr' ? 'ou préparer la session' : 'or prepare session'}</span></div>

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
          on:input={onLocationInput}
          on:blur={onLocationBlur}
          on:focus={() => { if (suggestions.length) suggestOpen = true; }}
        />
        <span class="geo-status">
          {#if suggestLoading}
            <span class="spinner-xs"></span>
          {:else if geoLoading}
            <span class="spinner-xs"></span>
          {:else if geoAddress}
            <button type="button" class="mic-btn geo-btn"
              title={$langStore === 'fr' ? 'Ma position' : 'My location'}
              on:click={() => pickSuggestion(geoAddress)}>📍</button>
          {:else}
            <button type="button" class="mic-btn geo-btn"
              title={$langStore === 'fr' ? 'Détecter ma position' : 'Detect location'}
              on:click={retryGeo}>🗺</button>
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
              on:mousedown|preventDefault={() => pickSuggestion(s)}
            >
              <span class="suggest-icon">📍</span>
              <span class="suggest-text">{s}</span>
            </button>
          {/each}
        </div>
      {/if}

      <!-- GPS suggestion chip -->
      {#if geoAddress && location_label !== geoAddress && !suggestOpen}
        <button type="button" class="geo-suggest" on:click={() => pickSuggestion(geoAddress)}>
          📍 {geoAddress}
        </button>
      {/if}
    </div>
  </div>

  <!-- ── Planned meetings picker ── -->
  {#if isAuthenticated()}
    <div class="planned-section">
      <button
        type="button"
        class="planned-toggle"
        on:click={() => showMeetingPicker = !showMeetingPicker}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4">
          <rect x="1" y="2" width="12" height="11" rx="1.5"/>
          <path d="M4 1v2M10 1v2M1 6h12"/>
        </svg>
        {showMeetingPicker ? 'Hide planned meetings' : 'Pick a planned meeting'}
        <span class="toggle-arrow">{showMeetingPicker ? '▲' : '▼'}</span>
      </button>

      {#if showMeetingPicker}
        <div class="meeting-picker animate-fade-in">
          {#if meetingsLoading}
            <div class="picker-empty"><span class="spinner-xs"></span> Loading…</div>
          {:else if plannedMeetings.length === 0}
            <div class="picker-empty">
              No planned meetings found.<br>
              <span class="picker-hint">Connect to EigenVertex to see your schedule.</span>
            </div>
          {:else}
            {#each plannedMeetings as m}
              <button type="button" class="meeting-item" on:click={() => applyPlannedMeeting(m)}>
                <div class="mi-title">{m.title}</div>
                <div class="mi-time">{m.time} · {m.participants.length} participants</div>
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  <!-- ── Session type ── -->
  <div class="form-field">
    <label for="session-type">Session Type</label>
    <select id="session-type" class="select" bind:value={session_type}>
      {#each SESSION_TYPES as [val, label]}
        <option value={val}>{label}</option>
      {/each}
    </select>
  </div>

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
          on:click={() => startSTT('title')} title="Dictate">
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
          on:click={() => startSTT('subject')} title="Dictate">
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
          on:click={() => startSTT('agenda')} title="Dictate">
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
          on:click={() => startSTT('participants')} title="Dictate">
          {sttActive === 'participants' ? '🔴' : '🎙'}
        </button>
      {/if}
    </div>
  </div>

  <!-- ── Actions ── -->
  <div class="form-actions">
    <button type="button" class="btn btn-ghost" on:click={() => dispatch('cancel')} disabled={loading}>
      Cancel
    </button>
    <button type="submit" class="btn btn-primary btn-lg" disabled={!title.trim() || loading}>
      {#if loading}
        <span class="spinner-sm"></span> Creating…
      {:else}
        ▶ Start Session
      {/if}
    </button>
  </div>

</form>

<style>
  .metadata-form { display: flex; flex-direction: column; gap: var(--sp-4); }
  .required { color: var(--ev-danger); }

  /* ── Quick Record ── */
  .quick-rec-btn {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    padding: 14px 16px;
    background: linear-gradient(135deg, rgba(229,72,77,0.12), rgba(229,72,77,0.06));
    border: 1px solid rgba(229,72,77,0.35);
    border-radius: var(--radius-lg);
    cursor: pointer;
    text-align: left;
    width: 100%;
    font-family: var(--font-sans);
    transition: background 120ms, border-color 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .quick-rec-btn:hover:not(:disabled) {
    background: rgba(229,72,77,0.18);
    border-color: var(--ev-danger);
  }
  .quick-rec-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .quick-rec-icon { font-size: 1.4rem; flex-shrink: 0; }
  .quick-rec-text { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .quick-rec-title { font-size: 0.92rem; font-weight: 700; color: var(--ev-danger); }
  .quick-rec-sub   { font-size: 0.72rem; color: var(--ev-text-dim); line-height: 1.4; }
  .quick-rec-arrow { font-size: 0.85rem; color: var(--ev-danger); flex-shrink: 0; }

  .or-divider {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    color: rgba(255,255,255,0.25);
    font-size: 0.72rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .or-divider::before, .or-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--ev-border);
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
  .toggle-arrow { margin-left: auto; font-size: 0.65rem; }

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
  .picker-hint { font-size: 0.72rem; color: rgba(255,255,255,0.3); }
  .meeting-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
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
  .meeting-item:hover { background: rgba(255,255,255,0.04); }
  .mi-title { font-size: 0.88rem; font-weight: 500; }
  .mi-time  { font-size: 0.72rem; color: var(--ev-text-dim); }

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
