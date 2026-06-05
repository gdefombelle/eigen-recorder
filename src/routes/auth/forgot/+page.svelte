<script lang="ts">
  import { goto } from '$app/navigation';
  import { t, langStore } from '$lib/i18n/index';
  import { apiForgotPassword, ApiError } from '$lib/auth/api';

  let email    = '';
  let busy     = false;
  let errorMsg = '';
  let sent     = false;

  $: _lang = $langStore;

  async function submit() {
    if (!email.trim()) return;
    busy = true; errorMsg = '';
    try {
      await apiForgotPassword(email.trim());
      sent = true;
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 0)                                              errorMsg = t().auth.errorNetwork;
        else if (e.status === 404 || e.status === 405 || e.status === 501) errorMsg = t().auth.forgotNotAvailable;
        else                                                             errorMsg = e.message;
      } else {
        errorMsg = String(e);
      }
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{t().auth.forgotTitle} — EIGENVERTEX</title></svelte:head>

<div class="auth-page">
  <div class="auth-card">

    <button type="button" class="auth-back-btn"
      on:click={() => history.length > 1 ? history.back() : goto('/auth')}>
      ← Retour
    </button>

    <div class="auth-brand">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <polygon points="14,1 27,14 14,27 1,14" stroke="#9ad1ff" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="2.5" fill="#9ad1ff"/>
        <line x1="1" y1="14" x2="11.5" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="16.5" y1="14" x2="27" y2="14" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="1" x2="14" y2="11.5" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
        <line x1="14" y1="16.5" x2="14" y2="27" stroke="#9ad1ff" stroke-width="1" opacity=".55"/>
      </svg>
      <span class="auth-brand-name">EIGENVERTEX</span>
    </div>

    <h2 class="auth-title">{t().auth.forgotTitle}</h2>

    {#if sent}
      <div class="auth-success-box">
        <span class="auth-check">✓</span>
        <p>{t().auth.forgotSuccess}</p>
      </div>
    {:else}
      <p class="auth-desc">{t().auth.forgotDesc}</p>

      <form class="auth-form" on:submit|preventDefault={submit}>
        <div class="auth-field">
          <label for="forgot-email">{t().auth.email}</label>
          <input
            id="forgot-email"
            type="email"
            autocomplete="email"
            required
            bind:value={email}
            disabled={busy}
            placeholder="you@example.com"
          />
        </div>

        {#if errorMsg}
          <p class="auth-error">{errorMsg}</p>
        {/if}

        <button type="submit" class="auth-submit" disabled={busy}>
          {#if busy}<span class="auth-spinner"></span>{:else}{t().auth.forgotSubmit}{/if}
        </button>
      </form>
    {/if}

    <button class="auth-back" on:click={() => goto('/auth')}>
      {t().auth.backToLogin}
    </button>
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
    background: none; border: none;
    color: var(--ev-blue); font-size: 0.85rem; font-weight: 600;
    font-family: var(--font-sans); cursor: pointer; padding: 0;
    align-self: flex-start; transition: opacity 120ms;
  }
  .auth-back-btn:hover { opacity: 0.7; }
  .auth-brand { display: flex; align-items: center; gap: 10px; }
  .auth-brand-name { font-family: var(--font-display); font-weight: 600; font-size: 0.85rem; letter-spacing: 0.1em; }
  .auth-title { margin: 0; font-family: var(--font-display); font-size: 1.1rem; font-weight: 600; }
  .auth-desc  { margin: 0; font-size: 0.85rem; color: var(--ev-text-dim); line-height: 1.6; }
  .auth-form  { display: flex; flex-direction: column; gap: var(--sp-3); }
  .auth-field { display: flex; flex-direction: column; gap: 6px; }
  .auth-field label { font-size: 0.82rem; font-weight: 500; margin: 0; color: var(--ev-text); }
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
  .auth-field input:focus { border-color: var(--ev-blue); }
  .auth-field input::placeholder { color: rgba(255,255,255,0.55); }
  .auth-error {
    margin: 0;
    padding: 10px 12px;
    background: rgba(229,72,77,0.08);
    border: 1px solid rgba(229,72,77,0.3);
    border-radius: var(--radius-md);
    font-size: 0.82rem;
    color: var(--ev-danger);
  }
  .auth-success-box {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-3);
    padding: var(--sp-4);
    background: rgba(70,167,88,0.08);
    border: 1px solid rgba(70,167,88,0.3);
    border-radius: var(--radius-md);
  }
  .auth-check { font-size: 1.2rem; color: var(--ev-success); flex-shrink: 0; }
  .auth-success-box p { margin: 0; font-size: 0.85rem; color: var(--ev-text); line-height: 1.6; }
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
  .auth-back {
    background: none;
    border: none;
    color: var(--ev-blue);
    font-size: 0.82rem;
    cursor: pointer;
    padding: 0;
    text-align: left;
    font-family: var(--font-sans);
  }
  .auth-back:hover { text-decoration: underline; }
</style>
