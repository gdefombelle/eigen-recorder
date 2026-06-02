<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { onMount } from 'svelte';
  import { t, langStore } from '$lib/i18n/index';
  import { apiLogin, apiRegister, apiMeWithToken, getGoogleLoginUrl, getAppleLoginUrl, apiAppleNativeLogin, ApiError } from '$lib/auth/api';
  import { tokenToUser, setUser, isAuthenticated, authStore } from '$lib/auth/auth';
  import { isNative } from '$lib/platform';
  import { isIOS as isIOSDevice } from '$lib/recorder/utils'; // userAgent-based — true on any iPhone/iPad
  import { registerPlugin } from '@capacitor/core';

  interface AppleSignInPlugin {
    signIn(): Promise<{ identityToken: string; authorizationCode: string; email?: string; fullName?: string }>;
  }
  const AppleSignIn = registerPlugin<AppleSignInPlugin>('AppleSignInPlugin');

  type Tab = 'login' | 'register';

  let tab: Tab      = ($page.url.searchParams.get('tab') ?? 'login') as Tab;
  let email         = '';
  let password      = '';
  let busy          = false;
  let errorMsg      = '';
  let success       = '';

  $: _lang = $langStore; // reactive language

  function nextUrl(): string {
    return $page.url.searchParams.get('next') ?? '/recorder';
  }

  onMount(() => {
    if (isAuthenticated()) goto(nextUrl(), { replaceState: true });
  });

  $: if ($authStore && isAuthenticated() && !busy) goto(nextUrl(), { replaceState: true });

  function switchTab(newTab: Tab) {
    tab = newTab; errorMsg = ''; success = '';
  }

  function mapError(e: unknown): string {
    if (e instanceof ApiError) {
      if (e.status === 0)                       return t().auth.errorNetwork;
      if (e.status === 401 || e.status === 400) return t().auth.errorCredentials;
      if (e.status === 409)                     return t().auth.errorEmailTaken;
      return e.message;
    }
    return String(e);
  }

  async function submit() {
    errorMsg = ''; success = '';
    if (!email.trim() || !password) return;
    busy = true;
    try {
      const res = tab === 'login'
        ? await apiLogin(email.trim(), password)
        : await apiRegister(email.trim(), password);

      const rawToken = res.token ?? res.session_token ?? '';
      let user = tokenToUser(rawToken);
      if (!user) {
        const me = await apiMeWithToken(rawToken);
        user = {
          token:     rawToken,
          email:     me.email,
          name:      me.name,
          expiresAt: res.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
        };
      }
      setUser(user);
      if (tab === 'register') {
        success = t().auth.successRegister;
        await new Promise(r => setTimeout(r, 800));
      }
      await goto(nextUrl());
    } catch (e) {
      errorMsg = mapError(e);
    } finally {
      busy = false;
    }
  }

  function loginWithGoogle() {
    window.location.href = getGoogleLoginUrl();
  }

  async function loginWithApple() {
    errorMsg = '';

    // Native iOS (Capacitor) — use the plugin directly
    if (isNative()) {
      busy = true;
      try {
        const cred = await AppleSignIn.signIn();
        const res  = await apiAppleNativeLogin({
          identityToken:     cred.identityToken,
          authorizationCode: cred.authorizationCode,
          email:             cred.email,
          fullName:          cred.fullName,
        });
        const rawToken = res.token ?? res.session_token ?? '';
        let user = tokenToUser(rawToken);
        if (!user) {
          const me = await apiMeWithToken(rawToken);
          user = { token: rawToken, email: me.email, name: me.name, expiresAt: res.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000 };
        }
        setUser(user);
        await goto(nextUrl());
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== 'Cancelled') errorMsg = mapError(e);
      } finally {
        busy = false;
      }
      return;
    }

    // Web iOS (Safari) — OAuth redirect, same pattern as Google
    window.location.href = getAppleLoginUrl();
  }

  $: onIOS    = isIOSDevice(); // userAgent-based: true on any iPhone/iPad (web + native)
  $: onNative = isNative();   // true only inside Capacitor WebView
</script>

<svelte:head><title>{t().auth.pageTitle} — EIGENVERTEX</title></svelte:head>

<div class="auth-page">
  <div class="auth-card">

    <!-- Back button -->
    <button
      type="button"
      class="auth-back-btn"
      on:click={() => history.length > 1 ? history.back() : goto('/recorder')}
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

    <!-- Tabs -->
    <div class="auth-tabs">
      <button
        class="auth-tab"
        class:active={tab === 'login'}
        on:click={() => switchTab('login')}
      >{t().auth.loginTab}</button>
      <button
        class="auth-tab"
        class:active={tab === 'register'}
        on:click={() => switchTab('register')}
      >{t().auth.registerTab}</button>
    </div>

    <!-- Form -->
    <form class="auth-form" on:submit|preventDefault={submit}>
      <div class="auth-field">
        <label for="auth-email">{t().auth.email}</label>
        <input
          id="auth-email"
          type="email"
          autocomplete="email"
          required
          bind:value={email}
          disabled={busy}
          placeholder="you@example.com"
        />
      </div>

      <div class="auth-field">
        <label for="auth-password">{t().auth.password}</label>
        <input
          id="auth-password"
          type="password"
          autocomplete={tab === 'login' ? 'current-password' : 'new-password'}
          required
          bind:value={password}
          disabled={busy}
          placeholder="••••••••"
        />
        {#if tab === 'login'}
          <button
            type="button"
            class="auth-forgot"
            on:click={() => goto('/auth/forgot')}
          >{t().auth.forgotPassword}</button>
        {/if}
      </div>

      {#if errorMsg}
        <p class="auth-error">{errorMsg}</p>
      {/if}
      {#if success}
        <p class="auth-success">{success}</p>
      {/if}

      <button type="submit" class="auth-submit" disabled={busy}>
        {#if busy}
          <span class="auth-spinner"></span>
        {:else}
          {tab === 'login' ? t().auth.loginBtn : t().auth.registerBtn}
        {/if}
      </button>
    </form>

    <!-- Divider -->
    <div class="auth-divider"><span>{t().auth.or}</span></div>

    <!-- Google -->
    <button class="auth-google" on:click={loginWithGoogle} disabled={busy}>
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.16 7.09-10.36 7.09-17.65z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        <path fill="#FBBC05" d="M10.53 28.59a14.97 14.97 0 0 1 0-9.19l-7.98-6.19A23.86 23.86 0 0 0 0 24c0 3.77.9 7.34 2.56 10.78l7.97-6.19z"/>
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      </svg>
      {t().auth.googleBtn}
    </button>

    <!-- Apple — tout appareil iOS (guideline 4.8) : plugin natif Capacitor ou redirect web -->
    {#if onIOS}
      <button class="auth-apple" on:click={loginWithApple} disabled={busy}>
        <svg width="18" height="18" viewBox="0 0 814 1000" aria-hidden="true" fill="currentColor">
          <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 411.3 0 226.8 0 152.7c0-101.5 66.2-155.5 130.5-155.5 50 0 91.7 32.8 121.9 32.8 28.7 0 75.7-34.9 132.6-34.9 21.4.3 123.7 7.7 175.5 83.2zm-470-260.8c-18.5-24.7-49.2-42.6-84.3-42.6-3.8 0-7.7.3-11.5.9 1.2 38.4 18.1 76.3 44.2 103.1 24.1 24.7 56.3 40.5 89.3 40.5 3.2 0 6.4-.3 9.6-.6-1.1-37.8-19.1-74-47.3-101.3z"/>
        </svg>
        {t().auth.appleBtn}
      </button>
    {/if}

    <!-- Switch -->
    <p class="auth-switch">
      {#if tab === 'login'}
        <button type="button" class="auth-switch-btn" on:click={() => switchTab('register')}>
          {t().auth.registerLink}
        </button>
      {:else}
        <button type="button" class="auth-switch-btn" on:click={() => switchTab('login')}>
          {t().auth.loginLink}
        </button>
      {/if}
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
    gap: var(--sp-4);
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

  .auth-tabs {
    display: flex;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    padding: 3px;
    gap: 3px;
  }
  .auth-tab {
    flex: 1;
    padding: 8px;
    background: none;
    border: none;
    border-radius: calc(var(--radius-md) - 2px);
    font-size: 0.85rem;
    font-weight: 500;
    color: var(--ev-text-dim);
    cursor: pointer;
    transition: all 120ms;
  }
  .auth-tab.active {
    background: var(--ev-surface);
    color: var(--ev-text);
    box-shadow: 0 1px 3px rgba(0,0,0,0.4);
  }

  .auth-form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .auth-field { display: flex; flex-direction: column; gap: 6px; }
  .auth-field label { font-size: 0.82rem; font-weight: 500; color: var(--ev-text); margin: 0; }
  .auth-field input {
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text);
    font-size: 0.9rem;
    padding: 10px 12px;
    outline: none;
    transition: border-color 150ms;
    font-family: var(--font-sans);
    width: 100%;
  }
  .auth-field input:focus  { border-color: var(--ev-blue); }
  .auth-field input:disabled { opacity: 0.5; }
  .auth-field input::placeholder { color: rgba(255,255,255,0.25); }

  .auth-forgot {
    align-self: flex-end;
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.78rem;
    cursor: pointer;
    padding: 0;
    margin-top: 2px;
    font-family: var(--font-sans);
  }
  .auth-forgot:hover { text-decoration: underline; }

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
  .auth-success { margin: 0; font-size: 0.82rem; color: var(--ev-success); }

  .auth-submit {
    width: 100%;
    padding: 12px;
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
    min-height: 44px;
    transition: opacity 120ms;
  }
  .auth-submit:disabled { opacity: 0.6; cursor: default; }

  .auth-spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(0,0,0,0.2);
    border-top-color: var(--ev-black);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .auth-divider {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    color: var(--ev-text-dim);
    font-size: 0.78rem;
  }
  .auth-divider::before, .auth-divider::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--ev-border);
  }

  .auth-google {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
    color: var(--ev-text);
    font-size: 0.88rem;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 150ms;
    font-family: var(--font-sans);
  }
  .auth-google:hover:not(:disabled) { border-color: rgba(255,255,255,0.2); }
  .auth-google:disabled { opacity: 0.5; cursor: default; }

  .auth-apple {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    padding: 11px;
    background: #fff;
    border: 1px solid #fff;
    border-radius: var(--radius-md);
    color: #000;
    font-size: 0.88rem;
    font-weight: 500;
    cursor: pointer;
    font-family: var(--font-sans);
  }
  .auth-apple:disabled { opacity: 0.5; cursor: not-allowed; }

  .auth-switch { margin: 0; text-align: center; }
  .auth-switch-btn {
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.82rem;
    cursor: pointer;
    padding: 0;
    font-family: var(--font-sans);
  }
  .auth-switch-btn:hover { text-decoration: underline; }
</style>
