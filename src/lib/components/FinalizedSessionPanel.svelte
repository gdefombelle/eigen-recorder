<script lang="ts">
  import type { LiveStateResponse } from '$lib/recorder/knowledgeSessionApi';

  interface Props {
    data:    LiveStateResponse;
    title?:  string;
    onclose: () => void;
  }
  let { data, title, onclose }: Props = $props();

  function fmtDuration(ms: number | null | undefined): string {
    if (!ms) return '';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0
      ? `${h}h ${String(m).padStart(2,'0')}min`
      : `${m}min ${String(s).padStart(2,'0')}s`;
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium', timeStyle: 'short',
      });
    } catch { return iso; }
  }

  const displayTitle = $derived(data.title ?? title ?? 'Réunion');
  const duration     = $derived(fmtDuration(data.duration_ms));
  const startedAt    = $derived(fmtDate(data.started_at));
  const participants = $derived(data.participants?.filter(p => p.display_name) ?? []);
  const hasContent   = $derived(!!(data.summary || data.transcript || data.action_items?.length));
</script>

<div class="panel-overlay" role="dialog" aria-modal="true" aria-label="Réunion finalisée">
  <div class="panel">
    <!-- Header -->
    <div class="panel-header">
      <div class="panel-title-wrap">
        <span class="panel-icon">◫</span>
        <h2 class="panel-title">{displayTitle}</h2>
      </div>
      <button class="close-btn" onclick={onclose} aria-label="Fermer">✕</button>
    </div>

    <!-- Meta row -->
    <div class="panel-meta">
      {#if startedAt}<span class="meta-item">📅 {startedAt}</span>{/if}
      {#if duration}<span class="meta-item">⏱ {duration}</span>{/if}
      {#if participants.length}
        <span class="meta-item">👥 {participants.map(p => p.display_name).join(', ')}</span>
      {/if}
    </div>

    <!-- Body -->
    <div class="panel-body">
      {#if !hasContent}
        <p class="empty-msg">Le compte rendu est en cours de traitement par EigenVertex.</p>
      {:else}
        {#if data.summary}
          <section class="section">
            <h3 class="section-title">Résumé</h3>
            <p class="section-text">{data.summary}</p>
          </section>
        {/if}

        {#if data.action_items?.length}
          <section class="section">
            <h3 class="section-title">Actions</h3>
            <ul class="action-list">
              {#each data.action_items as item}
                <li>{item}</li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if data.transcript}
          <section class="section">
            <h3 class="section-title">Transcription</h3>
            <pre class="transcript">{data.transcript}</pre>
          </section>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .panel-overlay {
    position: absolute;
    inset: 0;
    z-index: 50;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .panel {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--ev-border);
    flex-shrink: 0;
    gap: 8px;
  }

  .panel-title-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .panel-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
    opacity: 0.7;
  }

  .panel-title {
    font-size: 0.95rem;
    font-weight: 600;
    font-family: var(--font-sans);
    color: var(--ev-text);
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .close-btn {
    background: none;
    border: none;
    color: var(--ev-text-muted);
    font-size: 1rem;
    cursor: pointer;
    padding: 4px 6px;
    border-radius: var(--r-sm);
    flex-shrink: 0;
    transition: background 100ms;
  }
  .close-btn:hover { background: var(--ev-surface); }

  .panel-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--ev-border);
    flex-shrink: 0;
  }

  .meta-item {
    font-size: 0.78rem;
    color: var(--ev-text-muted);
  }

  .panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .empty-msg {
    font-size: 0.88rem;
    color: var(--ev-text-muted);
    text-align: center;
    padding: 40px 0;
  }

  .section { display: flex; flex-direction: column; gap: 8px; }

  .section-title {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--ev-text-muted);
    margin: 0;
  }

  .section-text {
    font-size: 0.88rem;
    line-height: 1.6;
    color: var(--ev-text);
    margin: 0;
    white-space: pre-wrap;
  }

  .action-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .action-list li {
    font-size: 0.88rem;
    line-height: 1.5;
    color: var(--ev-text);
  }

  .transcript {
    font-size: 0.8rem;
    line-height: 1.7;
    color: var(--ev-text-muted);
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--font-mono, monospace);
    margin: 0;
    background: var(--ev-surface);
    padding: 12px;
    border-radius: var(--r-sm);
    overflow-x: auto;
  }
</style>
