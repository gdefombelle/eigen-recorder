<script lang="ts">
  import { onMount, tick } from 'svelte';
  import {
    getLiveState,
    getKnowledgeSessionMinutes,
    updateKnowledgeSessionMinutes,
    listKnowledgeSessionArtifacts,
    createKnowledgeSessionArtifact,
    sendSessionChatMessage,
    type LiveStateResponse,
    type KnowledgeSessionMinutes,
    type KnowledgeSessionArtifact,
  } from '$lib/recorder/knowledgeSessionApi';
  import { Dictation, isDictationSupported, dictationMessage } from '$lib/recorder/dictation';
  import type { DictationError } from '$lib/recorder/dictation';
  import MicLevelMeter from './MicLevelMeter.svelte';
  import { langStore } from '$lib/i18n/index';

  type Tab = 'room' | 'report' | 'map' | 'insights' | 'chat';
  type MapNode = { id?: string; label?: string; summary?: string; children?: MapNode[] };
  type InsightKind = 'decisions' | 'questions' | 'agreements' | 'timeline';

  // Layout types for the SVG mind map
  type LN = { id: string; label: string; summary?: string; cx: number; y: number; depth: number; hasChildren: boolean; isCollapsed: boolean };
  type LE = { x1: number; y1: number; x2: number; y2: number };
  type MapLayout = { lnodes: LN[]; ledges: LE[]; w: number; h: number };

  interface Props { sessionId: string; title?: string; onclose: () => void; initialTab?: Tab; }
  let { sessionId, title = 'Session', onclose, initialTab = 'room' }: Props = $props();

  let activeTab = $state<Tab>(initialTab);
  let liveState    = $state<LiveStateResponse | null>(null);
  let minutes      = $state<KnowledgeSessionMinutes | null>(null);
  let artifacts    = $state<KnowledgeSessionArtifact[]>([]);
  let loading      = $state(true);
  let loadTimedOut = $state(false);
  let roomError    = $state('');
  let reportError  = $state('');
  let artifactsError = $state('');
  let mindMapError = $state('');

  // Report editing
  let editingReport = $state(false);
  let draftSummary  = $state('');
  let draftDetailed = $state('');
  let savingReport  = $state(false);
  let saveError     = $state('');

  // Artifact generation
  let generatingKind = $state<KnowledgeSessionArtifact['kind'] | null>(null);
  let insightErrors  = $state<Partial<Record<InsightKind, string>>>({});

  // Chat
  let chatMessages   = $state<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  let chatInput      = $state('');
  let chatLoading    = $state(false);
  let chatError      = $state('');
  let chatUnavailable = $state(false);
  let chatEl         = $state<HTMLDivElement | undefined>(undefined);

  // Dictation (speech-to-text for the chat composer)
  let sttSupported   = $state(false);
  let dictating      = $state(false);
  let micLevel       = $state(0);
  let dictationError = $state('');
  let chatInputEl    = $state<HTMLInputElement | undefined>(undefined);
  /** Composer text captured at dictation start, so Cancel can restore it. */
  let textBeforeDictation = '';
  let dictation: Dictation | null = null;

  // Mind map
  let collapsedNodes = $state(new Set<string>());
  let mapZoom        = $state(1.0);
  let mapScrollEl    = $state<HTMLDivElement | undefined>(undefined);

  // ── Mind map layout constants ─────────────────────────────────────────────
  const NW = 148, NH = 44, HGAP = 12, VGAP = 68;

  // ── Derived ───────────────────────────────────────────────────────────────
  const mindMap     = $derived(artifacts.find(a => a.kind === 'mind_map') ?? null);
  const insightArtifacts = $derived(
    artifacts.filter((a): a is KnowledgeSessionArtifact =>
      (['decisions', 'questions', 'agreements', 'timeline'] as const).includes(a.kind as InsightKind),
    ),
  );
  const reportContent = $derived(minutes?.content_json ?? {});
  const showChatTab   = $derived(!!minutes);
  const mapModel      = $derived(parseMapJSON(mindMap?.body_markdown ?? '', mindMap?.title ?? title));
  // mapLayout re-derives when collapsedNodes changes (Svelte 5 tracks the $state read)
  const mapLayout     = $derived(mapModel.root ? buildLayout(mapModel.root) : null);

  const INSIGHT_LABELS: Record<InsightKind, string> = {
    decisions: 'Decisions', questions: 'Open questions',
    agreements: 'Agreements', timeline: 'Timeline',
  };
  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'room', label: 'Live Room' }, { id: 'report', label: 'Report' },
    { id: 'map', label: 'Mind map' },  { id: 'insights', label: 'Insights' },
    { id: 'chat', label: 'Chat' },
  ];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function fmtMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 60)).padStart(2,'0')}:${String(s % 60).padStart(2,'0')}`;
  }

  function extractError(e: unknown): string {
    return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
  }

  function parseMapJSON(md: string, fallback: string): { title: string; root: MapNode | null } {
    const block = md.match(/```(?:evtx-mindmap|json)\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (block) {
      try {
        const p = JSON.parse(block) as { title?: string; root?: MapNode };
        if (p.root) return { title: p.title || fallback, root: p.root };
      } catch { /* parse failure → show error */ }
    }
    return { title: fallback, root: null };
  }

  // ── SVG mind map layout ───────────────────────────────────────────────────

  function nid(n: MapNode, i = 0): string { return n.id ?? n.label ?? `n${i}`; }

  function subtreeW(node: MapNode, i = 0): number {
    const id = nid(node, i);
    const kids = collapsedNodes.has(id) ? [] : (node.children ?? []);
    if (!kids.length) return NW;
    const w = kids.reduce((s, k, ki) => s + subtreeW(k, ki) + HGAP, -HGAP);
    return Math.max(NW, w);
  }

  function buildLayout(root: MapNode): MapLayout {
    const lnodes: LN[] = [];
    const ledges: LE[] = [];

    function place(node: MapNode, x: number, y: number, depth: number, idx: number, pCX?: number, pBY?: number) {
      const id = nid(node, idx);
      const sw = subtreeW(node, idx);
      const cx = x + sw / 2;
      const hasKids = !!(node.children?.length);
      const isCollapsed = collapsedNodes.has(id);

      if (pCX !== undefined && pBY !== undefined)
        ledges.push({ x1: pCX, y1: pBY, x2: cx, y2: y });

      lnodes.push({ id, label: node.label ?? '—', summary: node.summary, cx, y, depth, hasChildren: hasKids, isCollapsed });

      if (!isCollapsed && node.children?.length) {
        let childX = x;
        for (let ki = 0; ki < node.children.length; ki++) {
          const kw = subtreeW(node.children[ki], ki);
          place(node.children[ki], childX, y + NH + VGAP, depth + 1, ki, cx, y + NH);
          childX += kw + HGAP;
        }
      }
    }

    place(root, 0, 20, 0, 0);
    const w = Math.max(...lnodes.map(n => n.cx + NW / 2), NW) + 20;
    const h = Math.max(...lnodes.map(n => n.y + NH), NH) + 20;
    return { lnodes, ledges, w, h };
  }

  function toggleMapNode(id: string) {
    const next = new Set(collapsedNodes);
    next.has(id) ? next.delete(id) : next.add(id);
    collapsedNodes = next;
  }

  function fitMap() {
    if (!mapScrollEl || !mapLayout) return;
    const sw = (mapScrollEl.clientWidth - 8) / mapLayout.w;
    const sh = (mapScrollEl.clientHeight - 8) / mapLayout.h;
    mapZoom = Math.max(0.25, Math.min(1, sw, sh));
  }

  // Split long labels for 2-line SVG text
  function splitLabel(label: string): [string, string] {
    if (label.length <= 18) return [label, ''];
    const mid = Math.floor(label.length / 2);
    const sp = label.lastIndexOf(' ', mid);
    const cut = sp > 0 ? sp : 18;
    return [label.slice(0, cut), label.slice(cut + (sp > 0 ? 1 : 0), cut + 19) + (label.length - cut > 19 ? '…' : '')];
  }

  // ── Insight body parser ───────────────────────────────────────────────────

  function parseInsightItems(md: string): string[] {
    // Try JSON fenced block first (structured artifact)
    const jb = md.match(/```(?:json|evtx-[a-z-]+)\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (jb) {
      try {
        const data = JSON.parse(jb) as unknown;
        if (Array.isArray(data)) {
          return (data as unknown[]).map(item =>
            typeof item === 'string' ? item
              : (item as Record<string,unknown>).text as string
                ?? (item as Record<string,unknown>).label as string
                ?? JSON.stringify(item),
          ).filter(Boolean);
        }
      } catch { /* fall through */ }
    }
    // Parse as markdown
    return md.split('\n')
      .map(line => {
        const t = line.trim();
        if (!t || /^#{1,4}\s/.test(t) || /^[-=]{3,}$/.test(t)) return '';
        return t
          .replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '')
          .replace(/\*\*(.*?)\*\*/g, '$1').replace(/\*(.*?)\*/g, '$1')
          .replace(/`(.*?)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .trim();
      })
      .filter(Boolean);
  }

  // ── Report field accessors ────────────────────────────────────────────────

  function textField(key: string): string {
    const v = reportContent[key]; return typeof v === 'string' ? v : '';
  }
  function listField(key: string): Array<Record<string,unknown>> {
    const v = reportContent[key];
    return Array.isArray(v) ? (v as unknown[]).filter((x): x is Record<string,unknown> => !!x && typeof x === 'object') : [];
  }
  function valueText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';
    const r = v as Record<string,unknown>;
    return ([r.title, r.text, r.description, r.action, r.question, r.summary]
      .find(p => typeof p === 'string' && (p as string).trim()) as string) ?? '';
  }

  // ── Data loading ──────────────────────────────────────────────────────────

  // Last-resort ceiling on the whole load. Every request below is already
  // individually bounded, but this panel is where a stuck load is actually
  // visible, and an endless spinner tells the user nothing and offers no way
  // out. If the load has not finished by now, stop waiting and say so.
  const LOAD_CEILING_MS = 25_000;

  async function loadAll() {
    loading = true; roomError = ''; reportError = ''; artifactsError = '';
    loadTimedOut = false;

    const work = Promise.allSettled([
      getLiveState(sessionId),
      getKnowledgeSessionMinutes(sessionId),
      listKnowledgeSessionArtifacts(sessionId),
    ]);
    const ceiling = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), LOAD_CEILING_MS),
    );

    const outcome = await Promise.race([work, ceiling]);
    if (outcome === 'timeout') {
      loadTimedOut = true;
      loading = false;
      return;
    }

    const [sr, mr, ar] = outcome;
    if (sr.status === 'fulfilled') liveState = sr.value; else roomError = extractError(sr.reason);
    if (mr.status === 'fulfilled') minutes = mr.value;   else reportError = extractError(mr.reason);
    if (ar.status === 'fulfilled') artifacts = ar.value; else artifactsError = extractError(ar.reason);
    loading = false;
    if (!artifacts.find(a => a.kind === 'mind_map') && minutes) generateArtifact('mind_map');
  }

  async function reloadSection(s: 'room' | 'report' | 'artifacts') {
    if (s === 'room') { roomError = ''; try { liveState = await getLiveState(sessionId); } catch (e) { roomError = extractError(e); } }
    else if (s === 'report') { reportError = ''; try { minutes = await getKnowledgeSessionMinutes(sessionId); } catch (e) { reportError = extractError(e); } }
    else { artifactsError = ''; try { artifacts = await listKnowledgeSessionArtifacts(sessionId); } catch (e) { artifactsError = extractError(e); } }
  }

  async function generateArtifact(kind: KnowledgeSessionArtifact['kind']) {
    generatingKind = kind; if (kind !== 'mind_map') insightErrors = { ...insightErrors, [kind]: '' }; else mindMapError = '';
    try { const a = await createKnowledgeSessionArtifact(sessionId, kind, 'en'); artifacts = [...artifacts.filter(x => x.kind !== kind), a]; }
    catch (e) { if (kind === 'mind_map') mindMapError = extractError(e); else insightErrors = { ...insightErrors, [kind]: extractError(e) }; }
    finally { generatingKind = null; }
  }

  // ── Report editing ────────────────────────────────────────────────────────

  function startEditing() { draftSummary = textField('executive_summary'); draftDetailed = textField('detailed_report'); editingReport = true; saveError = ''; }

  async function saveReport() {
    savingReport = true; saveError = '';
    try {
      const patch: Record<string,unknown> = {};
      if (draftSummary !== textField('executive_summary'))  patch.executive_summary = draftSummary;
      if (draftDetailed !== textField('detailed_report'))   patch.detailed_report   = draftDetailed;
      if (Object.keys(patch).length) minutes = await updateKnowledgeSessionMinutes(sessionId, { content_json: { ...reportContent, ...patch } });
      editingReport = false;
    } catch (e) { saveError = extractError(e); }
    finally { savingReport = false; }
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  async function sendChat() {
    const msg = chatInput.trim(); if (!msg || chatLoading || dictating) return;
    chatInput = ''; chatError = ''; dictationError = '';
    chatMessages = [...chatMessages, { role: 'user', content: msg }];
    chatLoading = true; await tick(); if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    try {
      const r = await sendSessionChatMessage(sessionId, msg, chatMessages.slice(0, -1).slice(-12));
      chatMessages = [...chatMessages, { role: 'assistant', content: r.answer }];
    } catch (e) {
      const err = extractError(e);
      if (err.includes('404') || err.toLowerCase().includes('not found')) chatUnavailable = true;
      else chatError = err;
      chatMessages = chatMessages.slice(0, -1); chatInput = msg;
    } finally {
      chatLoading = false; await tick(); if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
    }
  }

  // ── Dictation ─────────────────────────────────────────────────────────────
  // Recognized text lands in the composer for review — it is never auto-sent,
  // and no audio is ever sent to the chat API.

  async function startDictation() {
    if (dictating || chatLoading) return;
    dictationError = '';
    textBeforeDictation = chatInput;

    dictation = new Dictation({
      onTranscript: (text) => {
        chatInput = textBeforeDictation
          ? `${textBeforeDictation.trimEnd()} ${text}`
          : text;
      },
      onLevel: (l) => { micLevel = l; },
      onEnd:   () => { finishDictation(); },
      onError: (err: DictationError) => {
        dictationError = err.message;
        if (err.kind === 'unsupported') sttSupported = false;
        dictating = false;
        micLevel  = 0;
        dictation = null;
        chatInput = textBeforeDictation;
      },
    });

    dictating = true;
    const ok = await dictation.start($langStore);
    if (!ok) dictating = false;
  }

  /** Stop listening and keep the recognized text for review. */
  async function finishDictation() {
    const active = dictation;
    if (!active) return;
    dictation = null;
    const text = await active.stop();
    dictating  = false;
    micLevel   = 0;
    if (!text) {
      chatInput = textBeforeDictation;
      dictationError = dictationMessage('no_speech');
      return;
    }
    chatInput = textBeforeDictation ? `${textBeforeDictation.trimEnd()} ${text}` : text;
    await tick();
    chatInputEl?.focus();
  }

  /** Abort listening and restore the composer to its pre-dictation text. */
  async function cancelDictation() {
    const active = dictation;
    dictation = null;
    dictating = false;
    micLevel  = 0;
    dictationError = '';
    chatInput = textBeforeDictation;
    await active?.cancel();
  }

  onMount(() => {
    sttSupported = isDictationSupported();
    loadAll();
    return () => dictation?.cancel();
  });
</script>

<!-- ── Overlay ────────────────────────────────────────────────────────────── -->
<div class="ws-overlay" role="dialog" aria-modal="true" aria-label="Session content">
<div class="ws-panel">

  <!-- ── Header ── -->
  <header class="ws-header">
    <div class="ws-header-text">
      <span class="ws-eyebrow">SESSION CONTENT</span>
      <h2 class="ws-title">{title}</h2>
    </div>
    <!-- Close — 44 × 44 px touch target, high-contrast, respects safe area -->
    <button class="ws-close" onclick={onclose} aria-label="Close panel" type="button">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
        <line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/>
      </svg>
    </button>
  </header>

  <!-- ── Tab bar ── -->
  <nav class="ws-tabs" aria-label="Session sections">
    {#each TABS as tab}
      {#if tab.id !== 'chat' || showChatTab}
        <button class="ws-tab" class:active={activeTab === tab.id}
          onclick={() => (activeTab = tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined}
        >{tab.label}</button>
      {/if}
    {/each}
  </nav>

  <!-- ── Content ── -->
  <div class="ws-content" class:chat-layout={activeTab === 'chat'}>

    {#if loading}
      <div class="ws-center" role="status" aria-live="polite"><span class="spinner"></span>Loading session content…</div>

    {:else if loadTimedOut}
      <div class="ws-err" role="alert">
        <p>Session content did not load.</p>
        <p class="ws-hint">The server did not respond in time. Check Settings › Diagnostics for the last refresh result.</p>
        <button class="ws-retry" onclick={loadAll}>Retry</button>
      </div>

    {:else if activeTab === 'room'}
      <!-- ── Live Room ── -->
      {#if roomError}
        <div class="ws-err" role="alert"><p>{roomError}</p><button class="ws-retry" onclick={() => reloadSection('room')}>Retry</button></div>
      {:else if !liveState}
        <div class="ws-empty"><p>Transcript not yet available.</p><p class="ws-hint">Check back after processing completes.</p><button class="ws-retry" onclick={() => reloadSection('room')}>Refresh</button></div>
      {:else}
        {#if liveState.participants?.filter(p => p.display_name).length}
          <section class="ws-section">
            <h3 class="ws-section-title">Participants</h3>
            <div class="chip-row">{#each liveState.participants!.filter(p => p.display_name) as p}<span class="chip">{p.display_name}</span>{/each}</div>
          </section>
        {/if}
        {#if liveState.summary_text}
          <section class="ws-section"><h3 class="ws-section-title">Summary</h3><p class="ws-text">{liveState.summary_text}</p></section>
        {/if}
        {#if liveState.actions?.length}
          <section class="ws-section">
            <h3 class="ws-section-title">Action items</h3>
            <ul class="ws-list">{#each liveState.actions as item}<li>{item.text ?? JSON.stringify(item)}</li>{/each}</ul>
          </section>
        {/if}
        {#if liveState.transcript_segments?.length}
          <section class="ws-section">
            <h3 class="ws-section-title">Transcript</h3>
            <div class="segments">
              {#each liveState.transcript_segments as seg}
                <div class="segment">
                  {#if seg.speaker_name || seg.start_ms != null}
                    <span class="seg-meta">{seg.speaker_name ?? ''}{seg.start_ms != null ? ` · ${fmtMs(seg.start_ms)}` : ''}</span>
                  {/if}
                  <p class="seg-text">{seg.text}</p>
                </div>
              {/each}
            </div>
          </section>
        {/if}
        {#if !liveState.summary_text && !liveState.transcript_segments?.length && !liveState.actions?.length && !liveState.participants?.length}
          <div class="ws-empty"><p>Live Room data is being processed.</p><button class="ws-retry" onclick={() => reloadSection('room')}>Refresh</button></div>
        {/if}
      {/if}

    {:else if activeTab === 'report'}
      <!-- ── Report ── -->
      {#if reportError}
        <div class="ws-err" role="alert"><p>{reportError}</p><button class="ws-retry" onclick={() => reloadSection('report')}>Retry</button></div>
      {:else if !minutes}
        <div class="ws-empty"><p>Report not yet available.</p><p class="ws-hint">Generated after sync completes.</p><button class="ws-retry" onclick={() => reloadSection('report')}>Refresh</button></div>
      {:else if editingReport}
        <div class="report-edit">
          <div class="report-edit-field">
            <label for="edit-sum" class="ws-section-title">Executive summary</label>
            <textarea id="edit-sum" class="ws-textarea" bind:value={draftSummary} rows="5" placeholder="Write a summary…"></textarea>
          </div>
          <div class="report-edit-field">
            <label for="edit-det" class="ws-section-title">Full report</label>
            <textarea id="edit-det" class="ws-textarea" bind:value={draftDetailed} rows="10" placeholder="Write the full report…"></textarea>
          </div>
          {#if saveError}<p class="inline-err" role="alert">{saveError}</p>{/if}
          <div class="edit-actions">
            <button class="ws-btn ws-btn-ghost" onclick={() => (editingReport = false)} disabled={savingReport}>Cancel</button>
            <button class="ws-btn ws-btn-primary" onclick={saveReport} disabled={savingReport}>{savingReport ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      {:else}
        <div class="report-hdr">
          <span class="ws-badge">Rev {minutes.revision} · {minutes.status === 'draft' ? 'Draft' : minutes.status === 'approved' ? 'Approved' : 'In review'}</span>
          <button class="ws-btn ws-btn-ghost ws-btn-sm" onclick={startEditing}>
            <svg width="11" height="11" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l2 2-9 9H2.5v-2l9-9z"/></svg>
            Edit
          </button>
        </div>
        {#if textField('executive_summary')}<section class="ws-section"><h3 class="ws-section-title">Executive summary</h3><p class="ws-text">{textField('executive_summary')}</p></section>{/if}
        {#if textField('detailed_report')}<section class="ws-section"><h3 class="ws-section-title">Full report</h3><p class="ws-text">{textField('detailed_report')}</p></section>{/if}
        {#each ([['discussion_sections','Discussion'],['conclusions','Conclusions'],['decisions','Decisions'],['action_items','Action items'],['open_questions','Open questions']] as const) as [key,label]}
          {@const rows = listField(key)}
          {#if rows.length}<section class="ws-section"><h3 class="ws-section-title">{label}</h3><ul class="ws-list">{#each rows as row, i (`${key}-${i}`)}<li>{valueText(row)||JSON.stringify(row)}</li>{/each}</ul></section>{/if}
        {/each}
        {#if !textField('executive_summary') && !textField('detailed_report') && !['discussion_sections','conclusions','decisions','action_items','open_questions'].some(k => listField(k).length)}
          <div class="ws-empty"><p>Report has no sections to display yet.</p></div>
        {/if}
      {/if}

    {:else if activeTab === 'map'}
      <!-- ── Mind map (SVG tree) ── -->
      {#if generatingKind === 'mind_map'}
        <div class="ws-center" role="status" aria-live="polite"><span class="spinner"></span>Generating mind map…</div>
      {:else if mindMapError}
        <div class="ws-err" role="alert"><p>{mindMapError}</p><button class="ws-retry" onclick={() => generateArtifact('mind_map')}>Try again</button></div>
      {:else if !mindMap}
        <div class="ws-empty"><p>No mind map yet.</p><button class="ws-btn ws-btn-primary" onclick={() => generateArtifact('mind_map')} disabled={!!generatingKind}>Generate mind map</button></div>
      {:else if !mapModel.root}
        <div class="ws-err" role="alert"><p>Could not parse mind map data.</p><button class="ws-retry" onclick={() => generateArtifact('mind_map')}>Regenerate</button></div>
      {:else if mapLayout}
        <!-- Controls -->
        <div class="map-controls">
          <span class="map-title-label">{mapModel.title}</span>
          <div class="map-zoom-btns">
            <button class="map-zoom-btn" onclick={() => mapZoom = Math.min(2, mapZoom + 0.15)} aria-label="Zoom in">+</button>
            <button class="map-zoom-btn" onclick={fitMap} aria-label="Fit to screen">Fit</button>
            <button class="map-zoom-btn" onclick={() => mapZoom = Math.max(0.25, mapZoom - 0.15)} aria-label="Zoom out">−</button>
          </div>
        </div>
        <!-- Scrollable SVG canvas -->
        <div class="map-scroll" bind:this={mapScrollEl} style="overflow:auto;flex:1;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y">
          <svg
            width={mapLayout.w}
            height={mapLayout.h}
            style="transform:scale({mapZoom});transform-origin:top left;transition:transform 180ms;display:block"
            role="img"
            aria-label="Mind map: {mapModel.title}"
          >
            <!-- Edges -->
            {#each mapLayout.ledges as e}
              <path
                d="M {e.x1} {e.y1} C {e.x1} {e.y1 + VGAP * 0.55} {e.x2} {e.y2 - VGAP * 0.55} {e.x2} {e.y2}"
                fill="none" stroke="rgba(116,188,231,0.35)" stroke-width="1.5"
              />
            {/each}
            <!-- Nodes -->
            {#each mapLayout.lnodes as n}
              {@const [l1, l2] = splitLabel(n.label)}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <g
                transform="translate({n.cx - NW / 2},{n.y})"
                onclick={() => n.hasChildren && toggleMapNode(n.id)}
                style={n.hasChildren ? 'cursor:pointer' : ''}
              >
                <!-- Node background -->
                <rect
                  x="0" y="0" width={NW} height={NH} rx="12"
                  fill={n.depth === 0 ? 'rgba(21,62,74,0.9)' : n.depth === 1 ? 'rgba(21,62,74,0.65)' : 'rgba(21,62,74,0.45)'}
                  stroke={n.depth === 0 ? 'rgba(87,184,222,0.8)' : 'rgba(116,188,231,0.4)'}
                  stroke-width={n.depth === 0 ? '1.5' : '1'}
                />
                <!-- Label -->
                {#if l2}
                  <text x={NW / 2} y={NH / 2 - 6} text-anchor="middle" fill={n.depth === 0 ? '#b6e4ff' : 'var(--ev-text,#e0f0ff)'} font-size="12" font-weight={n.depth === 0 ? '700' : '500'} font-family="system-ui,-apple-system,sans-serif">{l1}</text>
                  <text x={NW / 2} y={NH / 2 + 9} text-anchor="middle" fill={n.depth === 0 ? '#b6e4ff' : 'var(--ev-text,#e0f0ff)'} font-size="12" font-weight={n.depth === 0 ? '700' : '500'} font-family="system-ui,-apple-system,sans-serif">{l2}</text>
                {:else}
                  <text x={NW / 2} y={NH / 2 + 5} text-anchor="middle" fill={n.depth === 0 ? '#b6e4ff' : 'var(--ev-text,#e0f0ff)'} font-size="12" font-weight={n.depth === 0 ? '700' : '500'} font-family="system-ui,-apple-system,sans-serif">{l1}</text>
                {/if}
                <!-- Collapse indicator -->
                {#if n.hasChildren}
                  <circle cx={NW - 11} cy={NH - 11} r="8" fill="rgba(87,184,222,0.2)" stroke="rgba(87,184,222,0.6)" stroke-width="1"/>
                  <text x={NW - 11} y={NH - 7} text-anchor="middle" fill="#74bce7" font-size="12" font-weight="700" font-family="system-ui">{n.isCollapsed ? '+' : '−'}</text>
                {/if}
              </g>
            {/each}
          </svg>
        </div>
        {#if mindMap.citations?.length}<p class="ws-source-note" style="flex-shrink:0;padding:6px 16px">{mindMap.citations.length} reference{mindMap.citations.length !== 1 ? 's' : ''} from transcript</p>{/if}
      {/if}

    {:else if activeTab === 'insights'}
      <!-- ── Insights ── -->
      {#if artifactsError}
        <div class="ws-err" role="alert"><p>{artifactsError}</p><button class="ws-retry" onclick={() => reloadSection('artifacts')}>Retry</button></div>
      {:else}
        {#each (['decisions','questions','agreements','timeline'] as InsightKind[]) as kind}
          {@const artifact = insightArtifacts.find(a => a.kind === kind)}
          {@const isGen = generatingKind === kind}
          {@const kindErr = insightErrors[kind]}
          <section class="ws-section insight-section">
            <div class="insight-hdr">
              <h3 class="ws-section-title">{INSIGHT_LABELS[kind]}</h3>
              {#if !artifact && !isGen}
                <button class="ws-btn ws-btn-ghost ws-btn-sm" onclick={() => generateArtifact(kind)} disabled={!!generatingKind}>Generate</button>
              {:else if isGen}
                <span class="spinner spinner-sm"></span>
              {/if}
            </div>
            {#if kindErr}
              <p class="inline-err">{kindErr}</p>
            {:else if artifact}
              {@const items = parseInsightItems(artifact.body_markdown)}
              {#if items.length}
                <div class="insight-cards">
                  {#each items as item, i (i)}<div class="insight-card">{item}</div>{/each}
                </div>
                {#if artifact.citations?.length}<p class="ws-source-note">{artifact.citations.length} source ref{artifact.citations.length !== 1 ? 's' : ''}</p>{/if}
              {:else}
                <p class="ws-hint">No items found in this artifact.</p>
              {/if}
            {:else if !isGen}
              <p class="ws-hint">Not yet generated for this session.</p>
            {/if}
          </section>
        {/each}
      {/if}

    {:else if activeTab === 'chat'}
      <!-- ── Session-scoped Chat ── -->
      {#if chatUnavailable}
        <div class="ws-empty"><p>Session chat is not yet available.</p><p class="ws-hint">This feature requires a backend update.</p></div>
      {:else}
        <div class="chat-msgs" bind:this={chatEl}>
          {#if !chatMessages.length}
            <div class="ws-empty chat-ph"><p>Ask anything about this session.</p><p class="ws-hint">Grounded in session content only — not Thread content.</p></div>
          {/if}
          {#each chatMessages as m, i (i)}
            <div class="chat-msg chat-{m.role}">
              <span class="chat-role">{m.role === 'user' ? 'You' : 'EigenVertex'}</span>
              <p class="chat-text">{m.content}</p>
            </div>
          {/each}
          {#if chatLoading}<div class="chat-msg chat-assistant chat-thinking" role="status"><span class="spinner spinner-sm"></span></div>{/if}
        </div>
        {#if chatError}<p class="inline-err chat-err" role="alert">{chatError}</p>{/if}
        {#if dictationError}<p class="inline-err chat-err" role="alert">{dictationError}</p>{/if}

        <form class="chat-bar" onsubmit={(e) => { e.preventDefault(); sendChat(); }}>
          <div class="chat-row">
            <input
              class="chat-input" type="text" bind:this={chatInputEl} bind:value={chatInput}
              placeholder={dictating ? 'Listening…' : 'Ask about this session…'}
              disabled={chatLoading} readonly={dictating}
              autocomplete="off" autocorrect="on"
            />
            {#if sttSupported && !dictating}
              <button class="chat-mic" type="button" onclick={startDictation}
                disabled={chatLoading} aria-label="Dictate" title="Dictate">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="9" y="2" width="6" height="11" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/>
                </svg>
              </button>
            {/if}
            {#if !dictating}
              <button class="chat-send" type="submit" disabled={!chatInput.trim() || chatLoading} aria-label="Send">
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 7.5h13M8.5 2l6 5.5-6 5.5"/></svg>
              </button>
            {/if}
          </div>

          {#if dictating}
            <!-- Live waveform + explicit Stop / Cancel, same meter as the recorder -->
            <div class="dictation-row" role="status" aria-live="polite">
              <div class="dictation-meter"><MicLevelMeter level={micLevel} active={true} /></div>
              <button class="dict-btn dict-cancel" type="button" onclick={cancelDictation}>Cancel</button>
              <button class="dict-btn dict-stop" type="button" onclick={finishDictation}>Stop</button>
            </div>
          {/if}
        </form>
      {/if}
    {/if}

  </div><!-- /ws-content -->
</div><!-- /ws-panel -->
</div><!-- /ws-overlay -->

<style>
  /* ── Overlay & panel ─────────────────────────────────────────────────────── */
  .ws-overlay {
    position: fixed; inset: 0; z-index: 200;
    background: var(--bg, #0d1a22);
    display: flex; flex-direction: column; overflow: hidden;
    /* iOS safe area */
    padding-bottom: env(safe-area-inset-bottom);
  }
  .ws-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

  /* ── Header ──────────────────────────────────────────────────────────────── */
  .ws-header {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 12px; flex-shrink: 0;
    padding: max(14px, calc(env(safe-area-inset-top) + 14px)) 16px 10px;
    border-bottom: 1px solid var(--ev-border);
  }
  .ws-eyebrow { display: block; font-size: .6rem; letter-spacing: .18em; font-weight: 700; color: #74bce7; margin-bottom: 2px; }
  .ws-title { font-size: 1rem; font-weight: 600; color: var(--ev-text); margin: 0; line-height: 1.3; }

  /* ── Close button — 44 × 44 px minimum, high contrast ─────────────────── */
  .ws-close {
    flex-shrink: 0;
    min-width: 44px; min-height: 44px;
    display: flex; align-items: center; justify-content: center;
    border-radius: 12px;
    background: rgba(87,184,222,0.15);
    border: 1.5px solid rgba(87,184,222,0.55);
    color: #b6e4ff;
    cursor: pointer;
    transition: background 120ms;
    -webkit-tap-highlight-color: transparent;
  }
  .ws-close:hover, .ws-close:active { background: rgba(87,184,222,0.28); }

  /* ── Tabs ─────────────────────────────────────────────────────────────────── */
  .ws-tabs {
    display: flex; gap: 0; overflow-x: auto; flex-shrink: 0;
    border-bottom: 1px solid var(--ev-border); scrollbar-width: none;
    -webkit-overflow-scrolling: touch;
  }
  .ws-tabs::-webkit-scrollbar { display: none; }
  .ws-tab {
    flex-shrink: 0; padding: 12px 16px; font-size: .8rem; font-weight: 600;
    color: var(--ev-text-muted); background: transparent; border: none;
    border-bottom: 2px solid transparent; cursor: pointer; white-space: nowrap;
    transition: color 100ms, border-color 100ms;
    -webkit-tap-highlight-color: transparent;
    min-height: 44px;
  }
  .ws-tab.active { color: #74bce7; border-bottom-color: #74bce7; }
  .ws-tab:hover:not(.active) { color: var(--ev-text); }

  /* ── Content area ─────────────────────────────────────────────────────────── */
  .ws-content {
    flex: 1; overflow-y: auto; padding: 16px;
    display: flex; flex-direction: column; gap: 14px;
    -webkit-overflow-scrolling: touch;
    min-height: 0;
  }
  .ws-content.chat-layout { padding: 0; gap: 0; }

  /* ── States ───────────────────────────────────────────────────────────────── */
  .ws-center { flex: 1; display: flex; align-items: center; justify-content: center; gap: 12px; color: var(--ev-text-muted); font-size: .88rem; padding: 40px; }
  .ws-err { display: grid; gap: 12px; text-align: center; padding: 32px 12px; color: #ff9a9a; font-size: .86rem; }
  .ws-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 40px 16px; color: var(--ev-text-muted); font-size: .88rem; }
  .ws-hint { font-size: .78rem; opacity: .7; margin: 0; }
  .ws-retry { border: 1px solid var(--ev-border); border-radius: 12px; padding: 10px 18px; background: var(--ev-card); color: var(--ev-text); font-size: .82rem; cursor: pointer; min-height: 44px; }
  .inline-err { color: #ff9a9a; font-size: .8rem; margin: 4px 0 0; }
  .ws-badge { font-size: .7rem; color: var(--ev-text-muted); }
  .ws-source-note { font-size: .7rem; color: var(--ev-text-muted); text-align: center; }

  /* ── Sections ─────────────────────────────────────────────────────────────── */
  .ws-section { border: 1px solid var(--ev-border); border-radius: 14px; padding: 13px; background: var(--ev-card); display: flex; flex-direction: column; gap: 8px; }
  .ws-section-title { font-size: .67rem; letter-spacing: .1em; text-transform: uppercase; color: #74bce7; font-weight: 700; margin: 0; }
  .ws-text { font-size: .87rem; line-height: 1.6; color: var(--ev-text); white-space: pre-wrap; margin: 0; }
  .ws-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 7px; font-size: .86rem; line-height: 1.45; color: var(--ev-text); }

  /* ── Participants ─────────────────────────────────────────────────────────── */
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { border: 1px solid rgba(116,188,231,.3); border-radius: 20px; padding: 4px 11px; font-size: .75rem; color: #b6e4ff; background: rgba(21,62,74,.5); }

  /* ── Transcript segments ──────────────────────────────────────────────────── */
  .segments { display: flex; flex-direction: column; gap: 10px; }
  .segment { display: flex; flex-direction: column; gap: 2px; }
  .seg-meta { font-size: .68rem; font-weight: 700; color: #74bce7; letter-spacing: .04em; }
  .seg-text { font-size: .86rem; line-height: 1.55; color: var(--ev-text); margin: 0; }

  /* ── Report editing ───────────────────────────────────────────────────────── */
  .report-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-shrink: 0; }
  .report-edit { display: flex; flex-direction: column; gap: 16px; }
  .report-edit-field { display: flex; flex-direction: column; gap: 6px; }
  .ws-textarea { border: 1px solid var(--ev-border); border-radius: 10px; padding: 10px 12px; background: var(--ev-card); color: var(--ev-text); font-size: .86rem; line-height: 1.55; resize: vertical; font-family: inherit; min-height: 80px; }
  .ws-textarea:focus { outline: none; border-color: rgba(116,188,231,.5); }
  .edit-actions { display: flex; gap: 8px; justify-content: flex-end; }

  /* ── Buttons ──────────────────────────────────────────────────────────────── */
  .ws-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 12px; padding: 10px 16px; font-size: .82rem; font-weight: 600; cursor: pointer; border: 1px solid var(--ev-border); transition: all 100ms; min-height: 44px; }
  .ws-btn:disabled { opacity: .5; cursor: not-allowed; }
  .ws-btn-primary { background: #153e4a; border-color: #57b8de; color: #b6e4ff; }
  .ws-btn-primary:hover:not(:disabled) { background: #1a4f5f; }
  .ws-btn-ghost { background: var(--ev-card); color: var(--ev-text); }
  .ws-btn-ghost:hover:not(:disabled) { background: var(--ev-surface); }
  .ws-btn-sm { padding: 6px 12px; font-size: .76rem; border-radius: 10px; min-height: 36px; }

  /* ── Mind map ─────────────────────────────────────────────────────────────── */
  .map-controls { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 0 10px; flex-shrink: 0; }
  .map-title-label { font-size: .7rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: #74bce7; }
  .map-zoom-btns { display: flex; gap: 6px; }
  .map-zoom-btn { width: 44px; height: 36px; border: 1px solid rgba(116,188,231,.35); border-radius: 10px; background: var(--ev-card); color: var(--ev-text); font-size: 1rem; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .map-zoom-btn:hover { background: var(--ev-surface); }

  /* ── Insights ─────────────────────────────────────────────────────────────── */
  .insight-section { gap: 10px; }
  .insight-hdr { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .insight-cards { display: flex; flex-direction: column; gap: 8px; }
  .insight-card {
    background: rgba(21,62,74,.45); border: 1px solid rgba(116,188,231,.25); border-radius: 10px;
    padding: 10px 13px; font-size: .86rem; line-height: 1.5; color: var(--ev-text);
    /* left accent bar */
    border-left: 3px solid rgba(87,184,222,.5);
  }

  /* ── Chat ─────────────────────────────────────────────────────────────────── */
  .chat-msgs { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; -webkit-overflow-scrolling: touch; min-height: 0; }
  .chat-ph { min-height: 120px; }
  .chat-msg { display: flex; flex-direction: column; gap: 4px; max-width: 88%; }
  .chat-user { align-self: flex-end; align-items: flex-end; }
  .chat-assistant { align-self: flex-start; }
  .chat-role { font-size: .65rem; letter-spacing: .05em; color: var(--ev-text-muted); }
  .chat-text { font-size: .86rem; line-height: 1.55; margin: 0; padding: 10px 13px; border-radius: 16px; white-space: pre-wrap; word-break: break-word; }
  .chat-user .chat-text { background: #153e4a; border: 1px solid #57b8de; color: #b6e4ff; border-radius: 16px 16px 4px 16px; }
  .chat-assistant .chat-text { background: var(--ev-card); border: 1px solid var(--ev-border); color: var(--ev-text); border-radius: 16px 16px 16px 4px; }
  .chat-thinking { opacity: .6; }
  .chat-err { padding: 8px 14px; }
  .chat-bar { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px calc(14px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--ev-border); flex-shrink: 0; background: var(--bg, #0d1a22); }
  .chat-row { display: flex; gap: 8px; align-items: center; }
  .chat-input { flex: 1; border: 1px solid var(--ev-border); border-radius: 20px; padding: 10px 14px; background: var(--ev-card); color: var(--ev-text); font-size: .86rem; font-family: inherit; min-height: 44px; }
  .chat-input:focus { outline: none; border-color: rgba(116,188,231,.5); }
  .chat-send { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; background: #153e4a; border: 1px solid #57b8de; color: #b6e4ff; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 100ms; }
  .chat-send:hover:not(:disabled) { background: #1a4f5f; }
  .chat-send:disabled { opacity: .4; cursor: not-allowed; }

  /* ── Dictation ────────────────────────────────────────────────────────────── */
  .chat-mic {
    width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%;
    background: var(--ev-card); border: 1px solid var(--ev-border); color: var(--ev-text-muted);
    display: flex; align-items: center; justify-content: center; cursor: pointer;
    transition: color 100ms, border-color 100ms;
    -webkit-tap-highlight-color: transparent;
  }
  .chat-mic:hover:not(:disabled), .chat-mic:active:not(:disabled) { color: #b6e4ff; border-color: rgba(87,184,222,.55); }
  .chat-mic:disabled { opacity: .4; cursor: not-allowed; }

  .dictation-row { display: flex; align-items: center; gap: 8px; }
  .dictation-meter { flex: 1; min-width: 0; }
  .dict-btn {
    flex-shrink: 0; min-height: 44px; padding: 0 16px; border-radius: 12px;
    font-size: .82rem; font-weight: 600; cursor: pointer; border: 1px solid var(--ev-border);
    -webkit-tap-highlight-color: transparent;
  }
  .dict-cancel { background: var(--ev-card); color: var(--ev-text-muted); }
  .dict-cancel:hover { color: var(--ev-text); }
  .dict-stop { background: #153e4a; border-color: #57b8de; color: #b6e4ff; }
  .dict-stop:hover { background: #1a4f5f; }

  /* ── Spinner ──────────────────────────────────────────────────────────────── */
  .spinner { width: 20px; height: 20px; flex-shrink: 0; border: 2px solid rgba(87,184,222,.3); border-right-color: #57b8de; border-radius: 50%; animation: spin .7s linear infinite; }
  .spinner-sm { width: 14px; height: 14px; border-width: 1.5px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
