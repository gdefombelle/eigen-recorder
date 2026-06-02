<script lang="ts">
  import { goto } from '$app/navigation';
  import { langStore, t } from '$lib/i18n/index';
  import { authStore, isAuthenticated, getUser } from '$lib/auth/auth';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import OfflineSessionsList from '$lib/components/OfflineSessionsList.svelte';
  import ConnectionStatus from '$lib/components/ConnectionStatus.svelte';

  $: _lang  = $langStore;
  $: _auth  = $authStore;
  $: store  = $recorderStore;
  $: authed = isAuthenticated();
  $: user   = getUser();

  $: isFr = $langStore === 'fr';

  $: HERO = isFr ? {
    badge:     "Gratuit · Offline-first · Données locales",
    title:     "Capturez vos sessions.",
    accent:    "Sans réseau. Sans perdre un mot.",
    lead:      "Un enregistreur audio intelligent pour vos réunions, interviews, visites terrain et audits — sauvegarde immédiate en local, synchronisation EigenVertex quand le réseau revient.",
    ev_line:   "Connectez-le à",
    ev_after:  ", la plateforme de Domain Intelligence, pour indexer et exploiter chaque session.",
    hint:      "Gratuit · Sans inscription obligatoire · Audio stocké sur votre appareil",
    cta_rec:   "Nouvelle session",
    cta_sess:  "Mes enregistrements",
    cta_reg:   "Créer un compte gratuit",
    cta_try:   "Enregistrer sans compte",
  } : {
    badge:     "Free · Offline-first · Data stays local",
    title:     "Capture your sessions.",
    accent:    "Offline. Every word.",
    lead:      "An intelligent audio recorder for your meetings, interviews, field visits and audits — instant local save, EigenVertex sync when network comes back.",
    ev_line:   "Connect it to",
    ev_after:  ", the Domain Intelligence platform, to index and leverage every session.",
    hint:      "Free · No sign-up required · Audio stored on your device",
    cta_rec:   "New session",
    cta_sess:  "My recordings",
    cta_reg:   "Create a free account",
    cta_try:   "Record without an account",
  };

  $: FEATURES = isFr ? [
    { icon: '◈', title: "Offline-first",         desc: "Aucune connexion requise pour enregistrer. Chaque chunk audio est sauvegardé immédiatement dans IndexedDB." },
    { icon: '⬡', title: "Traitement local",       desc: "L'audio ne quitte jamais votre appareil sans votre accord. Aucun serveur impliqué pendant l'enregistrement." },
    { icon: '▤', title: "Types de sessions",      desc: "Réunion projet, interview expert, visite terrain, audit, workshop, follow-up — le contexte est capturé avec l'audio." },
    { icon: '⇡', title: "Sync EigenVertex",       desc: "Synchronisez vos sessions vers votre workspace EigenVertex pour transcription, indexation et exploitation." },
    { icon: '⬓', title: "Export & partage",       desc: "Partagez l'audio via la feuille native iOS ou exportez en webm/m4a directement depuis l'app." },
    { icon: '◎', title: "iOS natif ready",        desc: "Architecture Capacitor-ready. Le build natif iOS donnera accès aux APIs audio avancées et au stockage fiable." },
  ] : [
    { icon: '◈', title: "Offline-first",          desc: "No network required to record. Each audio chunk is saved immediately to IndexedDB on your device." },
    { icon: '⬡', title: "Local processing",       desc: "Audio never leaves your device without your consent. No server involved during recording." },
    { icon: '▤', title: "Session types",          desc: "Project meeting, expert interview, field visit, audit, workshop, follow-up — context is captured with the audio." },
    { icon: '⇡', title: "EigenVertex sync",       desc: "Sync your sessions to your EigenVertex workspace for transcription, indexing and exploitation." },
    { icon: '⬓', title: "Export & share",         desc: "Share audio via the native iOS share sheet or download as webm/m4a directly from the app." },
    { icon: '◎', title: "Native iOS ready",       desc: "Capacitor-ready architecture. The native iOS build unlocks advanced audio APIs and reliable background recording." },
  ];

  $: SESSION_TYPES = isFr ? [
    { icon: '🗓', label: 'Réunion projet' },
    { icon: '🎙', label: 'Interview expert' },
    { icon: '👥', label: 'Interview client' },
    { icon: '🔬', label: 'Workshop' },
    { icon: '🏗', label: 'Visite terrain' },
    { icon: '📋', label: 'Session audit' },
    { icon: '🔄', label: 'Follow-up' },
    { icon: '📻', label: 'Enregistrement libre' },
  ] : [
    { icon: '🗓', label: 'Project Meeting' },
    { icon: '🎙', label: 'Expert Interview' },
    { icon: '👥', label: 'Client Interview' },
    { icon: '🔬', label: 'Workshop' },
    { icon: '🏗', label: 'Field Visit' },
    { icon: '📋', label: 'Audit Session' },
    { icon: '🔄', label: 'Follow-Up' },
    { icon: '📻', label: 'Free Recording' },
  ];
</script>

<svelte:head>
  <title>Eigen Recorder — {isFr ? 'Enregistreur audio offline-first' : 'Offline-first audio recorder'}</title>
  <meta name="description" content="{isFr ? 'Enregistreur audio intelligent pour Eigen Meeting. Offline-first, sync EigenVertex.' : 'Intelligent audio recorder for Eigen Meeting. Offline-first, EigenVertex sync.'}" />
</svelte:head>

<main>
<div class="lp">

  <!-- ─── Hero ─────────────────────────────────────────────────────────────── -->
  <section class="hero">
    <div class="hero-inner">

      <div class="hero-topbar">
        <div class="ev-wordmark">
          <svg width="18" height="18" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <polygon points="14,1 27,14 14,27 1,14" stroke="#9ad1ff" stroke-width="1.5"/>
            <circle cx="14" cy="14" r="2.5" fill="#9ad1ff"/>
            <line x1="1" y1="14" x2="11.5" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
            <line x1="16.5" y1="14" x2="27" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
            <line x1="14" y1="1" x2="14" y2="11.5" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
            <line x1="14" y1="16.5" x2="14" y2="27" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
          </svg>
          <span>EIGENVERTEX</span>
        </div>
        <ConnectionStatus online={store.isOnline} />
      </div>

      <p class="badge">
        <span class="badge-dot"></span>
        {HERO.badge}
      </p>

      <h1 class="display">
        {HERO.title}<br>
        <span class="accent">{HERO.accent}</span>
      </h1>

      <p class="lead">
        {HERO.lead}<br>
        {HERO.ev_line}
        <a href="https://eigenvertex.com" target="_blank" rel="noopener noreferrer" class="ev-inline-link">EigenVertex</a>{HERO.ev_after}
      </p>

      <div class="cta-row">
        {#if authed}
          <button class="btn-primary" on:click={() => goto('/recorder/new')}>
            {HERO.cta_rec}
            <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
              <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>
          </button>
          <a href="/recorder/offline" class="btn-secondary">{HERO.cta_sess}</a>
        {:else}
          <a href="/auth?tab=register" class="btn-primary">
            {HERO.cta_reg}
            <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
              <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
            </svg>
          </a>
          <button class="btn-secondary" on:click={() => goto('/recorder/new')}>
            {HERO.cta_try}
          </button>
        {/if}
      </div>

      <p class="hero-hint">{HERO.hint}</p>
    </div>

    <!-- EigenVertex mark -->
    <div class="hero-mark" aria-hidden="true">
      <svg viewBox="0 0 140 140" fill="none">
        <polygon points="70,4 136,70 70,136 4,70"   stroke="#9ad1ff" stroke-width="1.5" opacity="0.14"/>
        <polygon points="70,20 120,70 70,120 20,70"  stroke="#9ad1ff" stroke-width="1"   opacity="0.09"/>
        <polygon points="70,36 104,70 70,104 36,70"  stroke="#9ad1ff" stroke-width="0.8" opacity="0.06"/>
        <circle cx="70" cy="70" r="7" fill="#9ad1ff" opacity="0.16"/>
        <line x1="4"  y1="70" x2="63" y2="70" stroke="#9ad1ff" stroke-width="0.8" opacity="0.13"/>
        <line x1="77" y1="70" x2="136" y2="70" stroke="#9ad1ff" stroke-width="0.8" opacity="0.13"/>
        <line x1="70" y1="4"  x2="70" y2="63" stroke="#9ad1ff" stroke-width="0.8" opacity="0.13"/>
        <line x1="70" y1="77" x2="70" y2="136" stroke="#9ad1ff" stroke-width="0.8" opacity="0.13"/>
      </svg>
    </div>
  </section>

  <!-- ─── Features ─────────────────────────────────────────────────────────── -->
  <section class="features">
    <p class="section-eyebrow">{isFr ? 'Fonctionnalités' : 'Features'}</p>
    <h2 class="section-title">{isFr ? 'Tout ce dont vous avez besoin, rien de plus' : 'Everything you need, nothing more'}</h2>
    <div class="feature-grid">
      {#each FEATURES as f}
        <article class="feature-card">
          <div class="feature-icon">{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.desc}</p>
        </article>
      {/each}
    </div>
  </section>

  <!-- ─── How it works ─────────────────────────────────────────────────────── -->
  <section class="how">
    <p class="section-eyebrow">{isFr ? 'Comment ça marche' : 'How it works'}</p>
    <h2 class="section-title">{isFr ? 'En 3 étapes' : 'In 3 steps'}</h2>
    <ol class="steps">
      <li>
        <span class="step-num">1</span>
        <div>
          <strong>{isFr ? 'Créez une session' : 'Create a session'}</strong>
          <p>
            {isFr
              ? "Choisissez le type (réunion, interview, terrain…), renseignez titre, participants et agenda. La session est créée localement en une seconde — même sans réseau."
              : "Choose the type (meeting, interview, field visit…), fill in title, participants and agenda. The session is created locally in one second — even without network."}
          </p>
        </div>
      </li>
      <li>
        <span class="step-num">2</span>
        <div>
          <strong>{isFr ? 'Appuyez sur REC' : 'Tap REC'}</strong>
          <p>
            {isFr
              ? "L'audio est capturé via MediaRecorder et découpé en chunks de 5 secondes. Chaque chunk est sauvegardé immédiatement dans IndexedDB — aucun chunk ne se perd, même en cas de plantage."
              : "Audio is captured via MediaRecorder and sliced into 5-second chunks. Each chunk is saved immediately to IndexedDB — no chunk is ever lost, even on crash."}
          </p>
        </div>
      </li>
      <li>
        <span class="step-num">3</span>
        <div>
          <strong>{isFr ? 'Synchronisez ou partagez' : 'Sync or share'}</strong>
          <p>
            {isFr
              ? "Synchronisez vers votre workspace "
              : "Sync to your "}
            <a href="https://eigenvertex.com" target="_blank" rel="noopener noreferrer" class="ev-inline-link">EigenVertex</a>
            {isFr
              ? " pour transcription et indexation automatiques, ou exportez l'audio directement via la feuille de partage native."
              : " for automatic transcription and indexing, or export the audio directly via the native share sheet."}
          </p>
        </div>
      </li>
    </ol>
  </section>

  <!-- ─── Session types ────────────────────────────────────────────────────── -->
  <section class="usecases">
    <p class="section-eyebrow">{isFr ? 'Types de sessions' : 'Session types'}</p>
    <h2 class="section-title">{isFr ? 'Pour quoi l\'utiliser ?' : 'What to use it for?'}</h2>
    <div class="uc-grid">
      {#each SESSION_TYPES as s}
        <div class="uc-card">
          <span class="uc-icon">{s.icon}</span>
          <span class="uc-label">{s.label}</span>
        </div>
      {/each}
    </div>
  </section>

  <!-- ─── Deployment ───────────────────────────────────────────────────────── -->
  <section class="deploy">
    <p class="section-eyebrow">{isFr ? 'Déploiement' : 'Deployment'}</p>
    <h2 class="section-title">{isFr ? 'Cloud ou on-premises — votre choix' : 'Cloud or on-premises — your choice'}</h2>
    <div class="deploy-grid">
      <div class="deploy-card">
        <div class="deploy-badge cloud">Cloud</div>
        <h3>EigenVertex Cloud</h3>
        <p>
          {isFr
            ? "Créez un compte et synchronisez vos sessions audio vers l'infrastructure EigenVertex managée. Transcription et indexation automatiques."
            : "Create an account and sync your audio sessions to managed EigenVertex infrastructure. Automatic transcription and indexing."}
        </p>
        <a href="/auth?tab=register" class="btn-outline-blue">
          {isFr ? 'Créer un compte →' : 'Create an account →'}
        </a>
      </div>
      <div class="deploy-card">
        <div class="deploy-badge onprem">On-premises</div>
        <h3>EigenVertex On-premises</h3>
        <p>
          {isFr
            ? "Installez EigenVertex sur vos propres serveurs. Le recorder se connecte à votre instance via l'URL configurée dans les paramètres."
            : "Install EigenVertex on your own servers. The recorder connects to your instance via the URL configured in Settings."}
        </p>
        <a href="/settings" class="btn-outline">
          {isFr ? "Configurer l'URL →" : 'Configure URL →'}
        </a>
      </div>
    </div>
  </section>

  <!-- ─── Recent sessions (if any) ────────────────────────────────────────── -->
  <section class="recent-sessions">
    <div class="recent-header">
      <p class="section-eyebrow">{isFr ? 'Sessions récentes' : 'Recent sessions'}</p>
      <a href="/recorder/offline" class="see-all-link">{isFr ? 'Tout voir →' : 'See all →'}</a>
    </div>
    <OfflineSessionsList compact />
  </section>

  <!-- ─── Final CTA ────────────────────────────────────────────────────────── -->
  {#if !authed}
    <section class="final-cta">
      <svg width="36" height="36" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <polygon points="14,1 27,14 14,27 1,14" stroke="#9ad1ff" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="2.5" fill="#9ad1ff"/>
        <line x1="1" y1="14" x2="11.5" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="16.5" y1="14" x2="27" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="1" x2="14" y2="11.5" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="16.5" x2="14" y2="27" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
      </svg>
      <h2>
        {isFr ? 'Commencez gratuitement dès maintenant' : 'Get started for free today'}
      </h2>
      <p>
        {isFr
          ? "L'enregistreur est gratuit et fonctionne sans compte. Créez un compte EigenVertex pour débloquer la synchronisation et la transcription automatique."
          : "The recorder is free and works without an account. Create an EigenVertex account to unlock sync and automatic transcription."}
      </p>
      <div class="cta-row">
        <a href="/auth?tab=register" class="btn-primary">
          {isFr ? 'Créer un compte gratuit' : 'Create a free account'}
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
            <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
          </svg>
        </a>
        <button class="btn-secondary" on:click={() => goto('/recorder/new')}>
          {isFr ? 'Enregistrer sans compte' : 'Record without account'}
        </button>
      </div>
    </section>
  {:else}
    <section class="final-cta">
      <div class="account-welcome">
        <div class="welcome-avatar">{user?.email?.[0]?.toUpperCase() ?? '?'}</div>
        <div>
          <h2>{isFr ? `Bienvenue, ${user?.name ?? user?.email} !` : `Welcome, ${user?.name ?? user?.email}!`}</h2>
          <p>{isFr ? 'Vous êtes connecté. Commencez à enregistrer.' : 'You are signed in. Start recording.'}</p>
        </div>
      </div>
      <div class="cta-row">
        <button class="btn-primary" on:click={() => goto('/recorder/new')}>
          {isFr ? 'Nouvelle session' : 'New session'}
          <svg width="16" height="16" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none">
            <path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>
          </svg>
        </button>
        <a href="/recorder/offline" class="btn-secondary">{isFr ? 'Mes sessions' : 'My sessions'}</a>
      </div>
    </section>
  {/if}

  <!-- ─── Footer ───────────────────────────────────────────────────────────── -->
  <footer class="lp-footer">
    <span>© 2026 EIGENVERTEX</span>
    <span class="sep">·</span>
    <a href="/recorder/new">{isFr ? 'Enregistrer' : 'Record'}</a>
    <span class="sep">·</span>
    <a href="/recorder/offline">{isFr ? 'Sessions' : 'Sessions'}</a>
    <span class="sep">·</span>
    <a href="/auth">{isFr ? 'Mon compte' : 'My account'}</a>
    <span class="sep">·</span>
    <a href="/settings">{isFr ? 'Paramètres' : 'Settings'}</a>
    <span class="sep">·</span>
    <a href="https://eigenvertex.com" target="_blank" rel="noopener noreferrer">eigenvertex.com</a>
  </footer>

</div>
</main>

<style>
  main { flex: 1; background: var(--ev-black); overflow-y: auto; }

  .lp { max-width: 760px; margin: 0 auto; padding: 0 var(--sp-4); }

  /* ─── Hero ─── */
  .hero {
    position: relative;
    min-height: 58vh;
    display: flex;
    align-items: center;
    padding: var(--sp-8) 0;
    overflow: hidden;
  }
  .hero-inner { position: relative; z-index: 1; max-width: 500px; }

  .hero-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--sp-6);
  }
  .ev-wordmark {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 0.72rem;
    letter-spacing: 0.14em;
    color: var(--ev-blue);
  }

  .hero-mark {
    position: absolute;
    right: -80px;
    top: 50%;
    transform: translateY(-50%);
    width: 340px;
    height: 340px;
    pointer-events: none;
    z-index: 0;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 var(--sp-4);
    padding: 5px 12px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.2);
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--ev-blue);
    font-family: var(--font-display);
    letter-spacing: 0.03em;
  }
  .badge-dot {
    width: 6px; height: 6px;
    background: var(--ev-blue);
    border-radius: 50%;
    animation: pulse-dot 2s ease-in-out infinite;
  }
  @keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  .display {
    font-family: var(--font-display);
    font-size: clamp(1.9rem, 6vw, 3rem);
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.12;
    margin: 0 0 var(--sp-4);
    color: var(--ev-text);
  }
  .accent { color: var(--ev-blue); }

  .lead {
    font-size: 1rem;
    color: var(--ev-text-dim);
    line-height: 1.7;
    margin: 0 0 var(--sp-5);
  }
  .ev-inline-link {
    color: var(--ev-blue);
    text-decoration: none;
    font-weight: 500;
    border-bottom: 1px solid rgba(154,209,255,0.4);
    transition: border-color 120ms;
  }
  .ev-inline-link:hover { border-color: var(--ev-blue); }

  .cta-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    align-items: center;
  }
  .hero-hint {
    margin: var(--sp-3) 0 0;
    font-size: 0.72rem;
    color: rgba(255,255,255,0.28);
    font-family: var(--font-display);
    letter-spacing: 0.04em;
  }

  /* ─── Buttons ─── */
  .btn-primary {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 12px 22px;
    background: var(--ev-blue);
    color: var(--ev-black);
    border-radius: var(--radius-md);
    text-decoration: none;
    font-weight: 700;
    font-size: 0.9rem;
    font-family: var(--font-display);
    letter-spacing: 0.02em;
    border: none;
    cursor: pointer;
    transition: opacity 120ms;
  }
  .btn-primary:hover { opacity: 0.9; }

  .btn-secondary {
    display: inline-flex;
    align-items: center;
    padding: 12px 22px;
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text);
    text-decoration: none;
    font-size: 0.9rem;
    background: none;
    cursor: pointer;
    font-family: var(--font-sans);
    transition: border-color 120ms;
  }
  .btn-secondary:hover { border-color: rgba(255,255,255,0.2); }

  .btn-outline {
    display: inline-flex;
    align-items: center;
    padding: 9px 16px;
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text-dim);
    text-decoration: none;
    font-size: 0.85rem;
    background: none;
    margin-top: var(--sp-3);
    transition: all 120ms;
  }
  .btn-outline:hover { border-color: rgba(255,255,255,0.2); color: var(--ev-text); }

  .btn-outline-blue {
    display: inline-flex;
    align-items: center;
    padding: 9px 16px;
    border: 1px solid rgba(154,209,255,0.35);
    border-radius: var(--radius-md);
    color: var(--ev-blue);
    text-decoration: none;
    font-size: 0.85rem;
    background: var(--ev-blue-bg);
    margin-top: var(--sp-3);
    transition: background 120ms;
  }
  .btn-outline-blue:hover { background: rgba(154,209,255,0.13); }

  /* ─── Section base ─── */
  section {
    padding: var(--sp-8) 0;
    border-top: 1px solid var(--ev-border);
  }
  .section-eyebrow {
    margin: 0 0 var(--sp-2);
    font-family: var(--font-display);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ev-blue);
  }
  .section-title {
    font-family: var(--font-display);
    font-size: clamp(1.3rem, 4vw, 1.7rem);
    font-weight: 600;
    margin: var(--sp-2) 0 var(--sp-5);
    letter-spacing: -0.01em;
    color: var(--ev-text);
  }

  /* ─── Feature grid ─── */
  .feature-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: var(--sp-3);
  }
  .feature-card {
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    transition: border-color 120ms;
  }
  .feature-card:hover { border-color: rgba(154,209,255,0.25); }
  .feature-icon { font-size: 1.3rem; color: var(--ev-blue); line-height: 1; font-family: var(--font-mono); }
  .feature-card h3 { margin: 0; font-size: 0.9rem; font-weight: 600; color: var(--ev-text); }
  .feature-card p  { margin: 0; font-size: 0.82rem; color: var(--ev-text-dim); line-height: 1.6; }

  /* ─── Steps ─── */
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-5); }
  .steps li { display: flex; gap: var(--sp-4); align-items: flex-start; }
  .step-num {
    flex-shrink: 0;
    width: 34px; height: 34px;
    border-radius: 50%;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.3);
    color: var(--ev-blue);
    display: grid;
    place-items: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 0.85rem;
  }
  .steps strong { display: block; font-size: 0.95rem; margin-bottom: 4px; color: var(--ev-text); }
  .steps p { margin: 0; font-size: 0.85rem; color: var(--ev-text-dim); line-height: 1.65; }

  /* ─── Session types ─── */
  .uc-grid { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
  .uc-card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: 999px;
    font-size: 0.85rem;
    transition: border-color 120ms;
  }
  .uc-card:hover { border-color: rgba(154,209,255,0.25); }
  .uc-label { color: var(--ev-text-dim); }

  /* ─── Recent sessions ─── */
  .recent-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--sp-4);
  }
  .recent-header .section-eyebrow { margin: 0; }
  .see-all-link {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--ev-blue);
    text-decoration: none;
  }
  .see-all-link:hover { text-decoration: underline; }

  /* ─── Deploy ─── */
  .deploy-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--sp-4); }
  .deploy-card {
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: var(--sp-5);
    display: flex;
    flex-direction: column;
  }
  .deploy-badge {
    align-self: flex-start;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    font-family: var(--font-display);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: var(--sp-3);
  }
  .deploy-badge.cloud  { background: var(--ev-blue-bg); color: var(--ev-blue); border: 1px solid rgba(154,209,255,0.3); }
  .deploy-badge.onprem { background: rgba(70,167,88,0.1); color: var(--ev-success); border: 1px solid rgba(70,167,88,0.3); }
  .deploy-card h3 { margin: 0 0 var(--sp-2); font-size: 1rem; font-weight: 600; color: var(--ev-text); }
  .deploy-card p  { margin: 0; font-size: 0.85rem; color: var(--ev-text-dim); line-height: 1.65; flex: 1; }

  /* ─── Final CTA ─── */
  .final-cta {
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.14);
    border-radius: var(--radius-lg);
    padding: var(--sp-6);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--sp-4);
  }
  .final-cta h2 {
    margin: 0;
    font-family: var(--font-display);
    font-size: clamp(1.2rem, 3.5vw, 1.5rem);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ev-text);
  }
  .final-cta > p {
    margin: 0;
    font-size: 0.9rem;
    color: var(--ev-text-dim);
    line-height: 1.65;
    max-width: 460px;
  }

  .account-welcome { display: flex; align-items: center; gap: var(--sp-4); }
  .welcome-avatar {
    width: 44px; height: 44px;
    border-radius: 50%;
    background: rgba(154,209,255,0.12);
    border: 1px solid rgba(154,209,255,0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: 1.1rem;
    color: var(--ev-blue);
    flex-shrink: 0;
  }
  .account-welcome h2 { margin: 0 0 2px; font-size: 1.1rem; }
  .account-welcome p  { margin: 0; font-size: 0.85rem; color: var(--ev-text-dim); }

  /* ─── Footer ─── */
  .lp-footer {
    padding: var(--sp-5) 0 var(--sp-8);
    border-top: 1px solid var(--ev-border);
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-3);
    font-size: 0.78rem;
    color: var(--ev-text-dim);
    align-items: center;
  }
  .sep { opacity: 0.25; }
  .lp-footer a { color: var(--ev-text-dim); text-decoration: none; transition: color 120ms; }
  .lp-footer a:hover { color: var(--ev-blue); }
</style>
