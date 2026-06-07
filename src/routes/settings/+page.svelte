<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { t, langStore, setLang, type Lang } from '$lib/i18n/index';
  import { authStore, isAuthenticated, clearUser, getUser } from '$lib/auth/auth';
  import { getServerUrl, getDefaultServerUrl, isProxyMode, setServerUrl, resetServerUrl } from '$lib/auth/config';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import { offlineStorage } from '$lib/recorder/offlineStorage';
  import { getSupportedMimeType, isSafariLimited } from '$lib/recorder/audioRecorder';
  import { getBrowserName, isIOS, formatBytes } from '$lib/recorder/utils';

  $: _auth  = $authStore;
  $: _lang  = $langStore;
  $: store  = $recorderStore;
  $: authed = isAuthenticated();
  $: user   = getUser();

  // Server URL form
  let urlInput  = '';
  let urlError  = '';
  let saveState: 'idle' | 'saved' = 'idle';

  // Storage
  let totalBytes   = 0;
  let sessionCount = 0;
  let clearing     = false;
  let clearDone    = false;

  // Chunk duration
  let chunkSec = 5;

  const MIME_TYPE  = getSupportedMimeType();
  const BROWSER    = typeof navigator !== 'undefined' ? getBrowserName() : '—';
  const ON_IOS     = typeof navigator !== 'undefined' ? isIOS() : false;
  const SAFARI_LTD = typeof navigator !== 'undefined' ? isSafariLimited() : false;

  onMount(async () => {
    urlInput     = isProxyMode() ? '' : getServerUrl();
    totalBytes   = await offlineStorage.getTotalStorageBytes();
    const all    = await offlineStorage.getAllSessions();
    sessionCount = all.length;
  });

  function validate(url: string): string {
    if (!url.trim()) return t().settings.errorEmpty;
    try { new URL(url); return ''; }
    catch { return t().settings.errorInvalid; }
  }

  function save() {
    const err = validate(urlInput);
    if (err) { urlError = err; return; }
    urlError = '';
    setServerUrl(urlInput.trim());
    saveState = 'saved';
    setTimeout(() => { saveState = 'idle'; }, 2000);
  }

  function reset() {
    if (!confirm(t().settings.resetBtn + ' ?')) return;
    resetServerUrl();
    urlInput  = '';
    urlError  = '';
    saveState = 'saved';
    setTimeout(() => { saveState = 'idle'; }, 2000);
  }

  function deleteAccount() {
    if (!confirm(t().settings.deleteAccountConfirm)) return;
    window.open('https://app.eigenvertex.com/account/delete', '_blank');
  }

  async function signOut() {
    clearUser();
  }

  async function clearAllData() {
    if (!confirm(t().settings.clearAllConfirm)) return;
    clearing = true;
    const sessions = await offlineStorage.getAllSessions();
    for (const s of sessions) await offlineStorage.deleteSession(s.local_session_id);
    totalBytes   = 0;
    sessionCount = 0;
    clearing     = false;
    clearDone    = true;
    setTimeout(() => { clearDone = false; }, 3000);
  }

  function applyChunk() {
    recorderStore.setChunkDuration(chunkSec * 1000);
  }

  function switchLang(lang: Lang) { setLang(lang); }
</script>

<svelte:head><title>{t().settings.pageTitle} — EIGENVERTEX</title></svelte:head>

<main>
  <div class="page">
    <!-- ── Branded nav bar ── -->
    <nav class="page-nav">
      <button class="back-btn" on:click={() => goto('/recorder')}>
        <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M9 3L4 7.5 9 12"/>
        </svg>
        Back
      </button>

      <div class="brand">
        <svg width="20" height="20" viewBox="0 0 28 28" fill="none">
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

      <div style="width: 64px; flex-shrink: 0;"></div>
    </nav>

    <!-- ── Page title ── -->
    <div class="s-page-title-row">
      <h1 class="s-title">{t().settings.pageTitle}</h1>
    </div>

    <div class="content">

      <!-- ── Account ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.accountSection}</p>

        {#if authed && user}
          <div class="account-row">
            <div class="account-info">
              <div class="account-avatar">{user.email[0].toUpperCase()}</div>
              <div>
                {#if user.name}<div class="account-name">{user.name}</div>{/if}
                <div class="account-email">{user.email}</div>
              </div>
            </div>
            <button class="s-ghost-btn" on:click={signOut}>{t().auth.logout}</button>
          </div>
          <button class="s-danger-btn" on:click={deleteAccount}>
            {t().settings.deleteAccountBtn}
          </button>
        {:else}
          <div class="signin-cta">
            <p class="signin-hint">{t().auth.signInHint}</p>
            <button
              class="auth-submit-btn"
              on:click={() => goto('/auth?next=/settings')}
            >
              {t().auth.signInToSync}
            </button>
          </div>
        {/if}
      </section>

      <!-- ── Language ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.langSection}</p>
        <div class="lang-row">
          <button
            class="lang-btn"
            class:active={$langStore === 'fr'}
            on:click={() => switchLang('fr')}
          >🇫🇷 {t().settings.langFr}</button>
          <button
            class="lang-btn"
            class:active={$langStore === 'en'}
            on:click={() => switchLang('en')}
          >🇬🇧 {t().settings.langEn}</button>
        </div>
      </section>

      <!-- ── Recording ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.recordingSection}</p>
        <label class="s-label" for="chunk-dur">{t().settings.chunkDuration}</label>
        <div class="s-input-row">
          <select
            id="chunk-dur"
            class="s-select"
            bind:value={chunkSec}
            on:change={applyChunk}
          >
            <option value={2}>2 s</option>
            <option value={5}>5 s</option>
            <option value={10}>10 s</option>
            <option value={30}>30 s</option>
          </select>
        </div>
        <p class="s-help">{t().settings.chunkDurationHelp}</p>
      </section>

      <!-- ── Server URL ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.serverSection}</p>

        {#if isProxyMode()}
          <div class="s-proxy-badge">
            <span class="s-proxy-dot"></span>
            {t().settings.proxyModeLabel}
          </div>
          <p class="s-help">{t().settings.proxyModeHelp(getDefaultServerUrl())}</p>
        {:else}
          <p class="s-active">{t().settings.currentOverride(getServerUrl())}</p>
        {/if}

        <label class="s-label" for="server-url">{t().settings.serverUrlLabel}</label>
        <div class="s-input-row">
          <input
            id="server-url"
            class="s-input"
            class:error={!!urlError}
            type="url"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
            bind:value={urlInput}
            on:input={() => { urlError = ''; saveState = 'idle'; }}
            on:keydown={(e) => e.key === 'Enter' && save()}
            placeholder={t().settings.urlPlaceholder}
          />
          <button class="s-save-btn" on:click={save} disabled={saveState === 'saved' || !urlInput.trim()}>
            {saveState === 'saved' ? t().settings.saved : t().settings.save}
          </button>
        </div>
        {#if urlError}
          <p class="s-error">{urlError}</p>
        {/if}
        <p class="s-help">{t().settings.serverUrlHelp}</p>
        <p class="s-default">{t().settings.defaultLabel(getDefaultServerUrl())}</p>
      </section>

      <!-- ── Storage ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.storageSection}</p>
        <p class="s-help">{t().settings.storageSummary(sessionCount, formatBytes(totalBytes))}</p>
        <button
          class="s-danger-btn"
          on:click={clearAllData}
          disabled={clearing || sessionCount === 0}
        >
          {clearing ? t().settings.clearing : clearDone ? t().settings.cleared : t().settings.clearAll}
        </button>
      </section>

      <!-- ── Reset server ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.resetSection}</p>
        <p class="s-help">{t().settings.resetHelp}</p>
        <button class="s-danger-btn" on:click={reset} disabled={isProxyMode()}>
          {t().settings.resetBtn}
        </button>
      </section>

      <!-- ── Diagnostics ── -->
      <section class="s-section">
        <p class="s-eyebrow">{t().settings.diagnosticsSection}</p>
        <div class="diag-grid">
          <span class="diag-key">Browser</span>   <span class="diag-val">{BROWSER}</span>
          <span class="diag-key">Platform</span>  <span class="diag-val">{ON_IOS ? 'iOS / iPadOS' : (typeof navigator !== 'undefined' ? navigator.platform : '—')}</span>
          <span class="diag-key">Network</span>   <span class="diag-val" class:online={store.isOnline} class:offline={!store.isOnline}>{store.isOnline ? '● Online' : '● Offline'}</span>
          <span class="diag-key">Audio MIME</span><span class="diag-val">{MIME_TYPE || '⚠ none'}</span>
          <span class="diag-key">MediaRecorder</span><span class="diag-val">{typeof MediaRecorder !== 'undefined' ? '✓' : '✗'}</span>
          <span class="diag-key">IndexedDB</span> <span class="diag-val">{typeof indexedDB !== 'undefined' ? '✓' : '✗'}</span>
          <span class="diag-key">Auth</span>       <span class="diag-val" class:online={authed} class:offline={!authed}>{authed ? '● Signed in' : '● Signed out'}</span>
        </div>
      </section>

      <!-- ── iOS notes ── -->
      {#if SAFARI_LTD || ON_IOS}
        <section class="s-section">
          <p class="s-eyebrow">{t().settings.iosSection}</p>
          <ul class="ios-list">
            <li>Safari requires iOS ≥ 14.5 for MediaRecorder.</li>
            <li>Only <code>audio/mp4</code> is supported (not webm/opus).</li>
            <li><strong>Add to Home Screen</strong> for reliable recording.</li>
            <li>Future Capacitor build removes these restrictions.</li>
          </ul>
        </section>
      {/if}

      <!-- Footer -->
      <div class="version-footer">
        <div class="ev-brand"><span class="ev-dot"></span>EIGENVERTEX</div>
        <div class="version-str">Eigen Recorder v0.1.0</div>
      </div>

    </div>
  </div>
</main>

<style>
  main { flex: 1; display: flex; flex-direction: column; background: var(--ev-black); }

  .page {
    flex: 1;
    display: flex;
    flex-direction: column;
    max-width: 480px;
    margin: 0 auto;
    width: 100%;
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

  .brand {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }
  .brand-name {
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ev-text);
    white-space: nowrap;
  }

  /* ── Page title ── */
  .s-page-title-row {
    padding: var(--sp-4) var(--sp-4) 0;
    border-bottom: none;
  }
  .s-title {
    font-family: var(--font-display);
    font-size: 1.4rem;
    font-weight: 700;
    margin: 0;
  }

  /* Sections */
  .s-section {
    padding: var(--sp-5) 0;
    border-bottom: 1px solid var(--ev-border);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .s-eyebrow {
    margin: 0;
    font-family: var(--font-display);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--ev-blue);
  }

  /* Account */
  .account-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
  }
  .account-info { display: flex; align-items: center; gap: var(--sp-3); }
  .account-avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.3);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--ev-blue);
    flex-shrink: 0;
  }
  .account-name  { font-size: 0.85rem; font-weight: 600; color: var(--ev-text); }
  .account-email { font-size: 0.78rem; color: var(--ev-text-dim); }

  /* Sign-in CTA */
  .signin-cta { display: flex; flex-direction: column; gap: var(--sp-3); }
  .signin-hint { margin: 0; font-size: 0.85rem; color: var(--ev-text-dim); line-height: 1.6; }
  .auth-submit-btn {
    padding: 12px;
    background: var(--ev-blue);
    color: var(--ev-black);
    border: none;
    border-radius: var(--radius-md);
    font-size: 0.95rem;
    font-weight: 700;
    font-family: var(--font-display);
    cursor: pointer;
    align-self: stretch;
    transition: opacity 120ms;
  }
  .auth-submit-btn:hover { opacity: 0.88; }

  /* Language */
  .lang-row { display: flex; gap: var(--sp-2); }
  .lang-btn {
    flex: 1;
    padding: 9px 12px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text-dim);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 120ms;
    font-family: var(--font-sans);
  }
  .lang-btn.active { border-color: var(--ev-blue); color: var(--ev-blue); background: var(--ev-blue-bg); }

  /* Proxy badge */
  .s-proxy-badge {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 12px;
    background: rgba(70,167,88,0.1);
    border: 1px solid rgba(70,167,88,0.3);
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--ev-success);
    align-self: flex-start;
  }
  .s-proxy-dot {
    width: 6px; height: 6px;
    background: var(--ev-success);
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  .s-active {
    margin: 0;
    font-size: 0.8rem;
    font-family: var(--font-mono);
    color: var(--ev-blue);
  }

  /* Input row */
  .s-label { font-size: 0.88rem; font-weight: 500; margin: 0; color: var(--ev-text); }
  .s-input-row { display: flex; gap: var(--sp-2); }
  .s-input, .s-select {
    flex: 1;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text);
    font-size: 0.85rem;
    font-family: var(--font-mono);
    padding: 10px 12px;
    outline: none;
    transition: border-color 150ms;
    -webkit-appearance: none;
    appearance: none;
  }
  .s-input:focus, .s-select:focus  { border-color: var(--ev-blue); }
  .s-input.error   { border-color: var(--ev-danger); }
  .s-select { font-family: var(--font-sans); cursor: pointer; }

  .s-save-btn {
    padding: 10px 18px;
    background: var(--ev-blue);
    color: var(--ev-black);
    border: none;
    border-radius: var(--radius-md);
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
    font-family: var(--font-sans);
  }
  .s-save-btn:disabled { opacity: 0.5; cursor: default; }

  .s-error   { margin: 0; font-size: 0.8rem; color: var(--ev-danger); }
  .s-help    { margin: 0; font-size: 0.82rem; color: var(--ev-text-dim); line-height: 1.6; }
  .s-default { margin: 0; font-size: 0.78rem; font-family: var(--font-mono); color: var(--ev-text-dim); opacity: 0.5; }

  .s-ghost-btn {
    background: none;
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text-dim);
    font-size: 0.82rem;
    padding: 6px 12px;
    cursor: pointer;
    font-family: var(--font-sans);
    white-space: nowrap;
  }
  .s-ghost-btn:hover { background: rgba(255,255,255,0.06); color: var(--ev-text); }

  .s-danger-btn {
    align-self: flex-start;
    padding: 9px 16px;
    background: none;
    border: 1px solid var(--ev-danger);
    border-radius: var(--radius-md);
    color: var(--ev-danger);
    font-size: 0.85rem;
    cursor: pointer;
    transition: background 150ms;
    font-family: var(--font-sans);
  }
  .s-danger-btn:hover:not(:disabled) { background: rgba(229,72,77,0.08); }
  .s-danger-btn:disabled { opacity: 0.35; cursor: default; }

  /* Diagnostics */
  .diag-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 6px 16px;
    align-items: center;
  }
  .diag-key  { font-size: 0.8rem; color: var(--ev-text-dim); }
  .diag-val  { font-family: var(--font-mono); font-size: 0.75rem; color: var(--ev-text); }
  .diag-val.online  { color: var(--ev-success); }
  .diag-val.offline { color: var(--ev-danger); }

  /* iOS list */
  .ios-list {
    padding-left: var(--sp-4);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
  }
  .ios-list li { font-size: 0.82rem; color: var(--ev-orange); line-height: 1.5; }
  .ios-list code {
    font-family: var(--font-mono);
    background: rgba(245,158,11,0.1);
    padding: 1px 5px;
    border-radius: 3px;
  }

  /* Footer */
  .version-footer {
    padding: var(--sp-5) 0 var(--sp-8);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }
  .ev-brand {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--ev-blue);
    font-family: var(--font-display);
  }
  .ev-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ev-blue); }
  .version-str { font-size: 0.7rem; color: rgba(255,255,255,0.25); }
</style>
