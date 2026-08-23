<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { SESSION_TYPE_LABELS } from '$lib/recorder/types';
  import type { LocalKnowledgeSession } from '$lib/recorder/types';
  import { formatDuration, formatBytes, formatDate } from '$lib/recorder/utils';
  import ShareAudioButton from './ShareAudioButton.svelte';

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

  // ── Single delete (trash icon, outside select mode) ──────────
  async function del(session: LocalKnowledgeSession, e: MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${session.title}"?`)) return;
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
      synced:            { cls: 'badge-green',  label: '◈ Synced' },
      mock_uploading:    { cls: 'badge-blue',   label: 'Syncing' },
      mock_synced:       { cls: 'badge-green',  label: 'Synced' },
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
                <span class="badge badge-green">↑ Synced</span>
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
              {#if stats.chunkCount > 0}
                <ShareAudioButton
                  sessionId={session.local_session_id}
                  chunkCount={stats.chunkCount}
                  variant="icon"
                />
              {/if}
              <button
                class="del-btn"
                onclick={(e) => del(session, e)}
                title="Delete session"
                aria-label="Delete"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                  <path d="M2 4h11M6 4V2h3v2M5 4l.5 9M10 4l-.5 9M7.5 4v9"/>
                </svg>
              </button>
            </div>
          {/if}
        </div>
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

  .del-btn {
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
    margin-left: auto;
    flex-shrink: 0;
  }
  .del-btn:hover {
    border-color: var(--ev-danger);
    color: var(--ev-danger);
    background: rgba(229,72,77,0.08);
  }

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
