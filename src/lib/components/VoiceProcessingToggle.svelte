<!--
  VoiceProcessingToggle — shown in ready state before pressing REC, iOS only
  (Voice Processing I/O is an AVAudioSession mode; nothing web/PWA can offer).

  Defaults ON for solo Dictaphone Mode (recorderStore.ts computes the default
  from session_type === 'voice_note'); this component is the user-visible,
  overridable switch, not the decision itself.
-->
<script lang="ts">
  import { langStore } from '$lib/i18n/index';

  let { enabled = false, onchange }: {
    enabled?: boolean;
    onchange?: (v: boolean) => void;
  } = $props();

  let isFr = $derived($langStore === 'fr');
</script>

<div class="vp-toggle">
  <button
    type="button"
    class="vp-row"
    role="switch"
    aria-checked={enabled}
    onclick={() => onchange?.(!enabled)}
  >
    <div class="vp-text">
      <span class="vp-name">{isFr ? 'Amélioration vocale' : 'Voice enhancement'}</span>
      <span class="vp-desc">
        {isFr
          ? 'Réduit le bruit de fond — pour une voix seule, pas pour une interview'
          : 'Reduces background noise — for a single voice, not for interviews'}
      </span>
    </div>
    <span class="vp-switch" class:on={enabled} aria-hidden="true"><span class="vp-knob"></span></span>
  </button>
</div>

<style>
  .vp-toggle {
    padding: 3px;
    background: var(--ev-card);
    border: 1px solid var(--ev-border);
    border-radius: var(--radius-md);
  }
  .vp-row {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 11px 12px;
    border: none;
    border-radius: calc(var(--radius-md) - 2px);
    background: none;
    cursor: pointer;
    text-align: left;
    -webkit-tap-highlight-color: transparent;
  }
  .vp-row:hover { background: rgba(255,255,255,0.05); }

  .vp-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .vp-name { font-size: 0.82rem; font-weight: 600; color: var(--ev-text); }
  .vp-desc { font-size: 0.65rem; color: var(--ev-text-dim); opacity: 0.8; }

  .vp-switch {
    flex-shrink: 0;
    width: 38px;
    height: 22px;
    border-radius: 11px;
    background: rgba(255,255,255,0.15);
    position: relative;
    transition: background 150ms;
  }
  .vp-switch.on { background: var(--ev-blue); }
  .vp-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: white;
    transition: transform 150ms;
  }
  .vp-switch.on .vp-knob { transform: translateX(16px); }
</style>
