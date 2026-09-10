<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { SESSION_TYPE_LABELS } from '$lib/recorder/types';
  import type { LocalKnowledgeSession } from '$lib/recorder/types';
  import { formatDuration, formatBytes, formatDate } from '$lib/recorder/utils';
  import ShareAudioButton from './ShareAudioButton.svelte';
  import SessionPlayer from './SessionPlayer.svelte';

  let {
    compact  = false,
    onchange = undefined,
  }: {
    compact?:  boolean;
    /** Called after every load (initial + post-delete) with fresh storage stats. */
    onchange?: (stats: { sessionCount: number; totalBytes: number }) => void;
  } = $props();

  let sessions: LocalKnowledgeSession[] = $state([]);
  let statsBySession: Record<string, { chunkCount: number; totalBytes: number }> = $state({});
  let loading     = $state(true);
  let selectMode  = $state(false);
  let selected    = $state<Set<string>>(new Set());
  let deleting    = $state(false);

  // Track which card has its player expanded
  let expandedPlayer: string | null = $state(null);

  // Track which card has the action menu open
  let openMenu: string | null = $state(null);

  // Grouped sessions: sessions sharing the same knowledge_session_id → played together
  let sessionGroups = $derived((() => {
    const groups = new Map<string, LocalKnowledgeSession[]>();
    for (const s of sessions) {
      const key = s.knowledge_session_id ?? s.local_session_id;
      const arr = groups.get(key) ?? [];
      arr.push(s);
      groups.set(key, arr);
    }
    return groups;
  })());

  function playerSessions(session: LocalKnowledgeSession): LocalKnowledgeSession[] {
    const key = session.knowledge_session_id ?? session.local_session_id;
    return sessionGroups.get(key) ?? [session];
  }

  async function load() {
    loading = true;
    sessions = await offlineStorage.getAllSessions();
    const statsMap: typeof statsBySession = {};
    for (const s of sessions) {
      statsMap[s.local_session_id] = await offlineStorage.getSessionStats(s.local_session_id);
    }
    statsBySession = statsMap;
    loading = false;

    // Notify parent with fresh totals so storage display stays in sync
    if (onchange) {
      const totalBytes = Object.values(statsMap).reduce((acc, s) => acc + s.totalBytes, 0);
      onchange({ sessionCount: sessions.length, totalBytes });
    }
  }

  onMount(load);

  // ── Action menu ──────────────────────────────────────────────
  function openActionMenu(id: string, e: MouseEvent) {
    e.stopPropagation();
    openMenu = openMenu === id ? null : id;
  }

  // Action 1 — purge audio blobs only (D-02)
  async function purgeAudio(session: LocalKnowledgeSession, e: MouseEvent) {
    e.stopPropagation();
    openMenu = null;
    const stats = statsBySession[session.local_session_id];
    if (!stats?.totalBytes) return; // nothing to purge
    if (!confirm(
      `Supprimer les fichiers audio de « ${session.title} » ?\n` +
      `Les métadonnées et l'historique de transport sont conservés.\n` +
      `Cette action est irréversible.`
    )) return;
    await offlineStorage.purgeAudio(session.local_session_id);
    await load();
  }

  // Action 2 — delete session entirely (D-02)
  async function del(session: LocalKnowledgeSession, e: MouseEvent) {
    e.stopPropagation();
    openMenu = null;
    if (!confirm(
      `Supprimer définitivement la session « ${session.title} » ?\n` +
      `Toutes les données (audio et métadonnées) seront effacées.\n` +
      `Cette action est irréversible.`
    )) return;
    await offlineStorage.deleteSession(session.local_session_id);
    await load();
  }

  // ── Selection mode helpers ────────────────────────────────────
  function enterSelectMode() {
    selectMode = true;
    selected   = new Set();
  }

  function exitSelectMode() {
    selectMode = false;
    selected   = new Set();
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selected = next;
  }

  function toggleAll() {
    if (selected.size === sessions.length) {
      selected = new Set();
    } else {
      selected = new Set(sessions.map((s) => s.local_session_id));
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} session${selected.size > 1 ? 's' : ''}?`)) return;
    deleting = true;
    await Promise.all([...selected].map((id) => offlineStorage.deleteSession(id)));
    deleting = false;
    exitSelectMode();
    await load();
  }

  function statusBadge(status: string): { cls: string; label: string } {
    const map: Record<string, { cls: string; label: string }> = {
      draft:             { cls: 'badge-gray',   label: 'Draft' },
      ready:             { cls: 'badge-gray',   label: 'Ready' },
      recording_offline: { cls: 'badge-red',    label: 'Interrupted' },
      paused:            { cls: 'badge-orange', label: 'Paused' },
      stopped_local:     { cls: 'badge-orange', label: 'Local' },
      synced:            { cls: 'badge-green',  label: '◈ Envoyé' },
      mock_uploading:    { cls: 'badge-blue',   label: 'Envoi…' },
      mock_synced:       { cls: 'badge-green',  label: '◈ Envoyé' },
      error:             { cls: 'badge-red',    label: 'Error' },
    };
    return map[status] ?? { cls: 'badge-gray', label: status };
  }
</script>

<div class="sessions-list">
  {#if loading}
    <div class="loading">
      <span class="spinner-sm"></span> Loading…
    </div>

  {:else if sessions.length === 0}
    <div class="empty-state">
      <div class="empty-state-icon">🎙</div>
      <h3>No recordings yet</h3>
      <p>Start a new session to begin recording.</p>
    </div>

  {:else}
    <!-- ── List header: Select toggle ── -->
    {#if !compact}
      <div class="list-header">
        {#if selectMode}
          <button class="header-btn" onclick={toggleAll}>
            {selected.size === sessions.length ? 'Deselect all' : 'Select all'}
          </button>
          <span class="select-count">{selected.size} selected</span>
          <button class="header-btn cancel-btn" onclick={exitSelectMode}>Cancel</button>
        {:else}
          <button class="header-btn" onclick={enterSelectMode}>Select</button>
        {/if}
      </div>
    {/if}

    <div class="list">
      {#each sessions as session (session.local_session_id)}
        {@const stats = statsBySession[session.local_session_id] ?? { chunkCount: 0, totalBytes: 0 }}
        {@const badge = statusBadge(session.status)}
        {@const isSelected = selected.has(session.local_session_id)}

        <div
          class="session-card"
          class:is-selected={isSelected}
          role="button"
          tabindex="0"
          onclick={() => {
            if (selectMode) {
              toggleSelect(session.local_session_id);
            } else {
              goto(`/recorder/session/${session.local_session_id}`);
            }
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              selectMode ? toggleSelect(session.local_session_id) : goto(`/recorder/session/${session.local_session_id}`);
            }
          }}
        >
          <!-- Top row: checkbox (select mode) or type + status badges -->
          <div class="card-top">
            {#if selectMode && !compact}
              <span class="check-box" class:checked={isSelected}>
                {#if isSelected}
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="1.5 6 4.5 9 10.5 3"/>
                  </svg>
                {/if}
              </span>
            {/if}
            <span class="type-label">{SESSION_TYPE_LABELS[session.session_type] ?? session.session_type}</span>
            <div class="badges">
              <span class="badge {badge.cls}">{badge.label}</span>
              {#if session.status === 'mock_synced'}
                <span class="badge badge-green">↑ Envoyé</span>
              {/if}
            </div>
          </div>

          <!-- Title -->
          <div class="card-title">{session.title}</div>

          <!-- Meta row: date · duration · chunks · size -->
          <div class="card-meta">
            <span>{formatDate(session.created_at)}</span>
            {#if session.duration_ms > 0}
              <span class="sep">·</span>
              <span>{formatDuration(session.duration_ms)}</span>
            {/if}
            {#if stats.chunkCount > 0}
              <span class="sep">·</span>
              <span>{stats.chunkCount} chunk{stats.chunkCount > 1 ? 's' : ''}</span>
              <span class="sep">·</span>
              <span>{formatBytes(stats.totalBytes)}</span>
            {/if}
          </div>

          <!-- Actions (hidden in select mode) -->
          {#if !compact && !selectMode}
            <div class="card-actions" role="none" onclick={(e) => e.stopPropagation()}>
              <!-- Play button (only when audio is available locally) -->
              {#if stats.chunkCount > 0}
                <button
                  class="action-btn play-inline-btn"
                  class:active={expandedPlayer === session.local_session_id}
                  onclick={(e) => { e.stopPropagation(); expandedPlayer = expandedPlayer === session.local_session_id ? null : session.local_session_id; }}
                  title={expandedPlayer === session.local_session_id ? 'Fermer le lecteur' : 'Écouter'}
                  aria-label="Écouter"
                >
                  {#if expandedPlayer === session.local_session_id}
                    <!-- close icon -->
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                      <line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/>
                    </svg>
                  {:else}
                    <!-- play icon -->
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                      <polygon points="3 2 12 7 3 12"/>
                    </svg>
                  {/if}
                </button>
                <ShareAudioButton
                  sessionId={session.local_session_id}
                  chunkCount={stats.chunkCount}
                  variant="icon"
                />
              {/if}

              <!-- ⋮ overflow menu: purge audio / delete entirely -->
              <div class="menu-wrap" role="none">
                <button
                  class="action-btn menu-trigger"
                  onclick={(e) => openActionMenu(session.local_session_id, e)}
                  aria-label="Actions"
                  title="Actions"
                >
                  <svg width="4" height="14" viewBox="0 0 4 16" fill="currentColor">
                    <circle cx="2" cy="2"  r="1.5"/>
                    <circle cx="2" cy="8"  r="1.5"/>
                    <circle cx="2" cy="14" r="1.5"/>
                  </svg>
                </button>

                {#if openMenu === session.local_session_id}
                  <!-- svelte-ignore a11y_no_static_element_interactions -->
                  <div class="action-menu animate-fade-in" role="menu" onclick={(e) => e.stopPropagation()}>
                    {#if stats.totalBytes > 0}
                      <button
                        class="menu-item"
                        role="menuitem"
                        onclick={(e) => purgeAudio(session, e)}
                      >
                        <svg width="13" height="13" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                          <path d="M2 4h11M6 4V2h3v2M5 4l.5 9M10 4l-.5 9M7.5 4v9"/>
                        </svg>
                        Purger l'audio
                        <span class="menu-hint">{formatBytes(stats.totalBytes)}</span>
                      </button>
                    {/if}
                    <button
                      class="menu-item menu-item-danger"
                      role="menuitem"
                      onclick={(e) => del(session, e)}
                    >
                      <svg width="13" height="13" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                        <path d="M2 4h11M6 4V2h3v2M5 4l.5 9M10 4l-.5 9M7.5 4v9"/>
                      </svg>
                      Supprimer entièrement
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Inline player (shown when expanded) -->
        {#if !compact && expandedPlayer === session.local_session_id}
          <div class="player-wrap" role="none" onclick={(e) => e.stopPropagation()}>
            <SessionPlayer sessions={playerSessions(session)} />
          </div>
        {/if}
      {/each}
    </div>

    <!-- ── Bottom action bar (select mode only) ── -->
    {#if selectMode && !compact}
      <div class="select-bar">
        <button
          class="delete-selected-btn"
          onclick={deleteSelected}
          disabled={selected.size === 0 || deleting}
        >
          {#if deleting}
            <span class="spinner-sm"></span> Deleting…
          {:else}
            <svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
              <path d="M2 4h11M6 4V2h3v2M5 4l.5 9M10 4l-.5 9M7.5 4v9"/>
            </svg>
            Delete{selected.size > 0 ? ` ${selected.size}` : ''}
          {/if}
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .sessions-list { display: flex; flex-direction: column; }

  .loading {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    color: var(--ev-text-dim);
    font-size: 0.875rem;
    padding: var(--sp-8) 0;
    justify-content: center;
  }

  .list { display: flex; flex-direction: column; gap: var(--sp-2); }

  /* ── Card ── */
  .session-card {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    cursor: pointer;
    transition: border-color 120ms, background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .session-card:hover  { border-color: rgba(154,209,255,0.25); background: var(--ev-surface); }
  .session-card:active { opacity: 0.85; }

  /* ── Top row ── */
  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }

  .type-label {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ev-text-dim);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  /* ── Title ── */
  .card-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: var(--ev-text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.3;
  }

  /* ── Meta ── */
  .card-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 5px;
    font-size: 0.72rem;
    color: var(--ev-text-dim);
    line-height: 1;
  }
  .sep { color: rgba(255,255,255,0.2); }

  /* ── Actions ── */
  .card-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--ev-border);
  }

  /* ── Action buttons (play inline, share, menu trigger) ── */
  .action-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--ev-text-dim);
    cursor: pointer;
    transition: all 120ms;
    flex-shrink: 0;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .action-btn:hover { border-color: rgba(255,255,255,0.12); color: var(--ev-text); background: rgba(255,255,255,0.04); }
  .action-btn.active { color: var(--ev-blue); border-color: rgba(154,209,255,0.3); background: var(--ev-blue-bg); }

  .play-inline-btn { color: var(--ev-blue); }
  .play-inline-btn:hover { border-color: rgba(154,209,255,0.35); background: var(--ev-blue-bg); }

  .menu-trigger { margin-left: auto; }

  /* ── Overflow action menu ── */
  .menu-wrap {
    position: relative;
    flex-shrink: 0;
  }
  .action-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 4px);
    background: var(--ev-surface, #1a1a2e);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    overflow: hidden;
    z-index: 200;
    min-width: 180px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  }
  .menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border: none;
    border-bottom: 1px solid var(--ev-border);
    background: none;
    color: var(--ev-text);
    font-size: 0.82rem;
    font-family: var(--font-sans);
    cursor: pointer;
    text-align: left;
    width: 100%;
    transition: background 80ms;
    -webkit-tap-highlight-color: transparent;
  }
  .menu-item:last-child { border-bottom: none; }
  .menu-item:hover { background: rgba(255,255,255,0.05); }
  .menu-item-danger { color: var(--ev-danger, #e5484d); }
  .menu-item-danger:hover { background: rgba(229,72,77,0.08); }
  .menu-hint { margin-left: auto; font-size: 0.7rem; color: var(--ev-text-dim); }

  /* ── Inline player ── */
  .player-wrap {
    margin-top: var(--sp-2);
    padding: 0 2px;
  }

  @keyframes animate-fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .animate-fade-in { animation: animate-fade-in 120ms ease-out; }

  /* ── List header ── */
  .list-header {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    padding-bottom: var(--sp-2);
    margin-bottom: var(--sp-1);
  }

  .header-btn {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--ev-blue);
    background: none;
    border: none;
    padding: 4px 2px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .header-btn:active { opacity: 0.65; }
  .cancel-btn { color: var(--ev-text-dim); margin-left: auto; }

  .select-count {
    flex: 1;
    text-align: center;
    font-size: 0.78rem;
    color: var(--ev-text-dim);
  }

  /* ── Checkbox ── */
  .check-box {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--ev-border);
    background: transparent;
    flex-shrink: 0;
    transition: border-color 100ms, background 100ms;
    color: #fff;
  }
  .check-box.checked {
    border-color: var(--ev-blue);
    background: var(--ev-blue);
  }

  /* ── Selected card highlight ── */
  .session-card.is-selected {
    border-color: var(--ev-blue);
    background: rgba(154,209,255,0.07);
  }

  /* ── Bottom delete bar ── */
  .select-bar {
    position: sticky;
    bottom: 0;
    padding: var(--sp-3) 0 var(--sp-2);
    background: linear-gradient(to bottom, transparent, var(--ev-bg) 40%);
  }

  .delete-selected-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    width: 100%;
    padding: 13px;
    border: none;
    border-radius: var(--radius-lg);
    background: var(--ev-danger);
    color: #fff;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 120ms;
  }
  .delete-selected-btn:disabled { opacity: 0.45; cursor: default; }
  .delete-selected-btn:not(:disabled):active { opacity: 0.8; }

  .spinner-sm {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--ev-border);
    border-top-color: var(--ev-blue);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
</style>
