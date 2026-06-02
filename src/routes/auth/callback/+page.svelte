<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { t, langStore } from '$lib/i18n/index';
  import { tokenToUser, setUser, type EVUser } from '$lib/auth/auth';
  import { apiMeWithToken } from '$lib/auth/api';

  type Status = 'loading' | 'error';
  let status: Status = 'loading';
  let errorDetail    = '';

  $: _lang = $langStore;

  onMount(async () => {
    const qp   = new URLSearchParams(window.location.search);
    const hash = window.location.hash.startsWith('#')
      ? new URLSearchParams(window.location.hash.slice(1))
      : new URLSearchParams();

    const next = qp.get('next') ?? hash.get('next') ?? '/recorder';

    const rawToken =
      qp.get('session_token') ?? qp.get('token') ?? qp.get('ev_token') ??
      qp.get('access_token')  ?? qp.get('id_token') ??
      hash.get('session_token') ?? hash.get('token') ?? hash.get('access_token');

    if (!rawToken) {
      errorDetail = `Params: ${[...qp.entries()].map(([k,v]) => `${k}=${v.slice(0,20)}`).join(' | ') || '(none)'}`;
      status = 'error';
      return;
    }

    let user: EVUser | null = tokenToUser(rawToken);

    if (!user) {
      try {
        const me = await apiMeWithToken(rawToken);
        user = { token: rawToken, email: me.email, name: me.name, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 };
      } catch (e) {
        errorDetail = `/auth/me failed: ${e instanceof Error ? e.message : String(e)}`;
        status = 'error';
        return;
      }
    }

    setUser(user);
    goto(next, { replaceState: true });
  });
</script>

<svelte:head><title>EIGENVERTEX — {t().auth.callbackLoading}</title></svelte:head>

<div class="cb-page">
  {#if status === 'loading'}
    <span class="cb-spinner"></span>
    <p>{t().auth.callbackLoading}</p>
  {:else}
    <div class="cb-card">
      <svg width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true">
        <polygon points="14,1 27,14 14,27 1,14" stroke="#e5484d" stroke-width="1.5"/>
        <circle cx="14" cy="14" r="2.5" fill="#e5484d"/>
      </svg>
      <p class="cb-title">{t().auth.callbackError}</p>
      {#if errorDetail}
        <code class="cb-detail">{errorDetail}</code>
      {/if}
      <a href="/auth" class="cb-retry">{t().auth.backToLogin}</a>
    </div>
  {/if}
</div>

<style>
  .cb-page {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-4);
    padding: var(--sp-4);
    color: var(--ev-text-dim);
    font-size: 0.9rem;
    min-height: calc(100dvh - 52px);
  }
  .cb-page p { margin: 0; }
  .cb-spinner {
    width: 28px; height: 28px;
    border: 2px solid var(--ev-border);
    border-top-color: var(--ev-blue);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .cb-card {
    width: 100%;
    max-width: 380px;
    background: var(--ev-surface);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-lg);
    padding: var(--sp-5);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .cb-title { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: 1rem; color: var(--ev-danger); }
  .cb-detail {
    font-family: var(--font-mono);
    font-size: 0.72rem;
    color: var(--ev-text-dim);
    word-break: break-all;
    background: var(--ev-card);
    padding: var(--sp-2);
    border-radius: var(--radius-sm);
  }
  .cb-retry {
    display: inline-flex;
    align-items: center;
    padding: 10px 16px;
    background: var(--ev-blue);
    color: var(--ev-black);
    border-radius: var(--radius-md);
    text-decoration: none;
    font-weight: 600;
    font-size: 0.88rem;
    align-self: flex-start;
  }
</style>
