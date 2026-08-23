<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { langStore } from '$lib/i18n/index';
  import { isAuthenticated, authStore } from '$lib/auth/auth';
  import { startPkceLogin } from '$lib/auth/pkceFlow';

  let busy     = $state(false);
  let errorMsg = $state('');

  function nextUrl(): string {
    return $page.url.searchParams.get('next') ?? '/recorder';
  }

  onMount(() => {
    if (isAuthenticated()) goto(nextUrl(), { replaceState: true });
  });

  $effect(() => {
    if ($authStore && isAuthenticated() && !busy) goto(nextUrl(), { replaceState: true });
  });

  async function login() {
    // UI-level guard — belt-and-suspenders alongside the module-level flag in pkceFlow.ts
    if (busy) return;
    errorMsg = '';
    busy = true;
    try {
      await startPkceLogin();
      // setUser() was already called inside startPkceLogin(); $authStore/$effect will
      // also navigate — calling goto() here too is fine (idempotent in SvelteKit).
      await goto(nextUrl());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Silent: user cancelled or duplicate call (already handled by module guard)
      const silent = msg === 'Cancelled'
        || msg.toLowerCase().includes('cancel')
        || msg === 'Login already in progress';
      if (!silent) {
        errorMsg = $langStore === 'fr'
          ? `Erreur de connexion : ${msg}`
          : `Login error: ${msg}`;
      }
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{$langStore === 'fr' ? 'Connexion' : 'Sign in'} — EIGENVERTEX</title></svelte:head>

<div class="auth-page">
  <div class="auth-card">

    <!-- Back button -->
    <button
      type="button"
      class="auth-back-btn"
      onclick={() => history.length > 1 ? history.back() : goto('/recorder')}
    >
      ← {$langStore === 'fr' ? 'Retour' : 'Back'}
    </button>

    <!-- Brand -->
    <div class="auth-brand">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <polygon points="14,1 27,14 14,27 1,14" stroke="#9ad1ff" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="2.5" fill="#9ad1ff"/>
        <line x1="1"  y1="14" x2="11.5" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="16.5" y1="14" x2="27"  y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="1"   x2="14"   y2="11.5" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="16.5" x2="14"  y2="27"   stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
      </svg>
      <span class="auth-brand-name">EIGENVERTEX</span>
    </div>

    <!-- Headline -->
    <div class="auth-headline">
      <h1>{$langStore === 'fr' ? 'Se connecter' : 'Sign in'}</h1>
      <p>
        {$langStore === 'fr'
          ? 'Votre navigateur s\'ouvrira pour vous authentifier en toute sécurité.'
          : 'Your browser will open to securely authenticate you.'}
      </p>
    </div>

    {#if errorMsg}
      <p class="auth-error">{errorMsg}</p>
    {/if}

    <!-- Single CTA -->
    <button class="auth-submit" onclick={login} disabled={busy}>
      {#if busy}
        <span class="auth-spinner"></span>
        <span>{$langStore === 'fr' ? 'Connexion en cours…' : 'Signing in…'}</span>
      {:else}
        {$langStore === 'fr' ? 'Se connecter avec EigenVertex' : 'Sign in with EigenVertex'}
      {/if}
    </button>

    <p class="auth-note">
      {$langStore === 'fr'
        ? 'OAuth 2.1 · Connexion sécurisée via votre compte EigenVertex'
        : 'OAuth 2.1 · Secure sign-in via your EigenVertex account'}
    </p>

  </div>
</div>

<style>
  .auth-page {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--sp-5) var(--sp-4);
    min-height: calc(100dvh - 52px);
  }

  .auth-card {
    width: 100%;
    max-width: 380px;
    display: flex;
    flex-direction: column;
    gap: var(--sp-5);
    background: var(--ev-surface);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: var(--sp-6);
  }

  .auth-back-btn {
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.85rem;
    font-weight: 600;
    font-family: var(--font-sans);
    cursor: pointer;
    padding: 0;
    align-self: flex-start;
    transition: opacity 120ms;
  }
  .auth-back-btn:hover { opacity: 0.7; }

  .auth-brand { display: flex; align-items: center; gap: 10px; }
  .auth-brand-name {
    font-family: var(--font-display);
    font-weight: 600;
    font-size: 0.85rem;
    letter-spacing: 0.1em;
    color: var(--ev-text);
  }

  .auth-headline h1 {
    font-size: 1.35rem;
    font-family: var(--font-display);
    font-weight: 700;
    color: var(--ev-text);
    margin-bottom: var(--sp-2);
  }
  .auth-headline p {
    font-size: 0.88rem;
    color: var(--ev-text-dim);
    margin: 0;
  }

  .auth-error {
    margin: 0;
    padding: 10px 12px;
    background: rgba(229,72,77,0.08);
    border: 1px solid rgba(229,72,77,0.3);
    border-radius: var(--radius-md);
    font-size: 0.82rem;
    color: var(--ev-danger);
    line-height: 1.5;
  }

  .auth-submit {
    width: 100%;
    padding: 14px;
    background: var(--ev-blue);
    color: var(--ev-black);
    border: none;
    border-radius: var(--radius-md);
    font-size: 0.95rem;
    font-weight: 700;
    font-family: var(--font-display);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    min-height: 52px;
    transition: opacity 120ms, background 120ms;
  }
  .auth-submit:hover:not(:disabled) { background: #b8dcff; }
  .auth-submit:disabled { opacity: 0.6; cursor: default; }

  .auth-spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(0,0,0,0.2);
    border-top-color: var(--ev-black);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .auth-note {
    margin: 0;
    text-align: center;
    font-size: 0.75rem;
    color: var(--ev-text-dim);
    opacity: 0.6;
  }
</style>
