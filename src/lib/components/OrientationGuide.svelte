<!-- OrientationGuide — conseil de positionnement iPhone avant d'enregistrer -->
<script lang="ts">
  import { langStore } from '$lib/i18n/index';
  export let dismissed = false;

  $: isFr = $langStore === 'fr';

  // Détection orientation actuelle
  let currentOrientation: 'portrait' | 'landscape' = 'portrait';
  import { onMount } from 'svelte';
  onMount(() => {
    const detect = () => {
      if (typeof screen !== 'undefined' && screen.orientation?.type) {
        currentOrientation = screen.orientation.type.startsWith('landscape') ? 'landscape' : 'portrait';
      } else {
        currentOrientation = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
      }
    };
    detect();
    const onOC = () => setTimeout(detect, 150);
    window.addEventListener('orientationchange', onOC);
    window.addEventListener('resize', detect);
    screen.orientation?.addEventListener('change', detect);
    return () => {
      window.removeEventListener('orientationchange', onOC);
      window.removeEventListener('resize', detect);
      screen.orientation?.removeEventListener('change', detect);
    };
  });
</script>

{#if !dismissed}
<div class="guide animate-fade-in">
  <button class="dismiss" on:click={() => dismissed = true} aria-label="Fermer">×</button>

  <div class="guide-title">
    {isFr ? '📱 Positionnez votre iPhone' : '📱 Position your iPhone'}
  </div>

  <div class="modes">

    <!-- Mode portrait -->
    <div class="mode" class:active={currentOrientation === 'portrait'}>
      <div class="phone-svg portrait-svg" aria-hidden="true">
        <svg viewBox="0 0 44 80" fill="none">
          <!-- Corps iPhone -->
          <rect x="2" y="2" width="40" height="76" rx="7" stroke="currentColor" stroke-width="1.5"/>
          <!-- Encoche -->
          <rect x="14" y="2" width="16" height="4" rx="2" fill="currentColor" opacity=".3"/>
          <!-- Bouton home / bar -->
          <rect x="17" y="74" width="10" height="2" rx="1" fill="currentColor" opacity=".3"/>
          <!-- Micro bas — surligné -->
          <circle cx="22" cy="72" r="2" fill="#9ad1ff" opacity=".9"/>
          <line x1="22" y1="70" x2="22" y2="66" stroke="#9ad1ff" stroke-width="1" stroke-dasharray="2 2"/>
          <!-- Micro haut — surligné -->
          <circle cx="22" cy="8" r="2" fill="rgba(154,209,255,0.4)" opacity=".7"/>
          <line x1="22" y1="10" x2="22" y2="14" stroke="rgba(154,209,255,0.4)" stroke-width="1" stroke-dasharray="2 2"/>
        </svg>
      </div>
      <div class="mode-info">
        <div class="mode-label">{isFr ? 'Vertical' : 'Portrait'}</div>
        <div class="mode-use">
          {isFr ? 'Interview · Prise de note · Terrain' : 'Interview · Field note · Solo'}
        </div>
        <div class="mode-channels">
          <span class="ch ch-a">● {isFr ? 'Bas → voix directe' : 'Bottom → direct voice'}</span>
          <span class="ch ch-b">○ {isFr ? 'Haut → ambiance salle' : 'Top → room ambiance'}</span>
        </div>
      </div>
    </div>

    <div class="sep">—</div>

    <!-- Mode landscape -->
    <div class="mode" class:active={currentOrientation === 'landscape'}>
      <div class="phone-svg landscape-svg" aria-hidden="true">
        <svg viewBox="0 0 80 44" fill="none">
          <!-- Corps iPhone paysage -->
          <rect x="2" y="2" width="76" height="40" rx="7" stroke="currentColor" stroke-width="1.5"/>
          <!-- Encoche gauche -->
          <rect x="2" y="14" width="4" height="16" rx="2" fill="currentColor" opacity=".3"/>
          <!-- Bouton droit -->
          <rect x="74" y="17" width="2" height="10" rx="1" fill="currentColor" opacity=".3"/>
          <!-- Micro gauche — surligné -->
          <circle cx="8" cy="22" r="2" fill="#9ad1ff" opacity=".9"/>
          <line x1="10" y1="22" x2="14" y2="22" stroke="#9ad1ff" stroke-width="1" stroke-dasharray="2 2"/>
          <!-- Micro droit — surligné -->
          <circle cx="72" cy="22" r="2" fill="#9ad1ff" opacity=".9"/>
          <line x1="70" y1="22" x2="66" y2="22" stroke="#9ad1ff" stroke-width="1" stroke-dasharray="2 2"/>
        </svg>
      </div>
      <div class="mode-info">
        <div class="mode-label">{isFr ? 'Horizontal' : 'Landscape'}</div>
        <div class="mode-use">
          {isFr ? 'Réunion · Table ronde · Face-à-face' : 'Meeting · Round table · Face-to-face'}
        </div>
        <div class="mode-channels">
          <span class="ch ch-a">● {isFr ? 'Gauche → interlocuteur 1' : 'Left → speaker 1'}</span>
          <span class="ch ch-a">● {isFr ? 'Droite → interlocuteur 2' : 'Right → speaker 2'}</span>
        </div>
      </div>
    </div>

  </div>

  <div class="note">
    {isFr
      ? '🎙 Stéréo native disponible sur iPhone XS+ via app Capacitor.'
      : '🎙 Native stereo available on iPhone XS+ via Capacitor app.'}
  </div>
</div>
{/if}

<style>
  .guide {
    background: rgba(154,209,255,0.04);
    border: 1px solid rgba(154,209,255,0.15);
    border-radius: var(--radius-lg);
    padding: var(--sp-4);
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }

  .dismiss {
    position: absolute;
    top: var(--sp-2);
    right: var(--sp-3);
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }

  .guide-title {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--ev-blue);
    letter-spacing: 0.02em;
    padding-right: var(--sp-5);
  }

  .modes {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
  }

  .sep {
    color: var(--text-subtle);
    font-size: 0.8rem;
    flex-shrink: 0;
  }

  .mode {
    flex: 1;
    display: flex;
    gap: var(--sp-3);
    align-items: flex-start;
    opacity: 0.6;
    transition: opacity var(--t);
  }
  .mode.active { opacity: 1; }

  /* iPhone SVGs */
  .phone-svg { flex-shrink: 0; color: var(--ev-text-dim); }
  .portrait-svg  { width: 28px; height: 50px; }
  .landscape-svg { width: 50px; height: 28px; }

  .mode-info {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .mode-label {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--ev-text);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .mode-use {
    font-size: 0.72rem;
    color: var(--ev-text-dim);
    line-height: 1.4;
  }

  .mode-channels {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 2px;
  }

  .ch {
    font-size: 0.65rem;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .ch-a { color: var(--ev-blue); opacity: 0.9; }
  .ch-b { color: rgba(154,209,255,0.5); }

  .note {
    font-size: 0.68rem;
    color: var(--text-muted);
    border-top: 1px solid var(--ev-border);
    padding-top: var(--sp-2);
    line-height: 1.5;
  }
</style>
