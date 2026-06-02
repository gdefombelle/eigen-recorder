<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { recorderStore } from '$lib/recorder/recorderStore';
  import { initAuth } from '$lib/auth/auth';
  import { loadConfig } from '$lib/auth/config';
  import { loadLang, langStore, t } from '$lib/i18n/index';
  import { page } from '$app/stores';

  onMount(() => {
    loadConfig();
    initAuth();
    loadLang();
    recorderStore.init();
  });

  $: currentPath = $page.url.pathname;
  $: _lang = $langStore; // re-render nav labels on language change

  $: navItems = [
    { href: '/recorder',         label: 'Home',                    icon: '◈' },
    { href: '/recorder/offline', label: t().recorder.sessions,     icon: '📂' },
    { href: '/settings',         label: t().settings.pageTitle,    icon: '⚙' },
  ];

  // Full-screen on session/new page — hide nav
  $: hideNav =
    currentPath.startsWith('/recorder/session/') ||
    currentPath.startsWith('/recorder/new') ||
    currentPath.startsWith('/auth');
</script>

<div class="app-shell">
  <slot />

  {#if !hideNav}
    <nav class="bottom-nav">
      {#each navItems as item}
        <a
          href={item.href}
          class="nav-item"
          class:active={item.href === '/recorder'
            ? currentPath === '/recorder'
            : currentPath.startsWith(item.href)}
        >
          <span class="nav-icon">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>
  {/if}
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    overflow: hidden;
  }

  .bottom-nav {
    display: flex;
    align-items: stretch;
    border-top: 1px solid var(--border-dim);
    background: var(--bg-2);
    flex-shrink: 0;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: var(--sp-2) var(--sp-1);
    text-decoration: none;
    color: var(--text-muted);
    transition: color var(--t);
    -webkit-tap-highlight-color: transparent;
    min-height: 52px;
  }
  .nav-item:hover  { color: var(--text-dim); }
  .nav-item.active { color: var(--blue-bright); }

  .nav-icon  { font-size: 1.2rem; }
  .nav-label { font-size: 0.62rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; }

  :global(main) {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
