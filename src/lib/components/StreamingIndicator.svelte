<!-- StreamingIndicator — live PCM16 WebSocket stream status badge -->
<script lang="ts">
  import type { LiveStreamState } from '$lib/recorder/types';
  import { langStore } from '$lib/i18n/index';

  export let liveStreamState: LiveStreamState = 'idle';
  export let framesStreamed:   number          = 0;
  export let pulse:            boolean         = false;
  export let online:           boolean         = true;

  $: isFr = $langStore === 'fr';

  $: label = (() => {
    if (!online) return isFr ? 'Hors-ligne — stocké localement' : 'Offline — stored locally';
    switch (liveStreamState) {
      case 'connecting':    return isFr ? 'Connexion au stream…'      : 'Connecting stream…';
      case 'streaming':     return isFr ? `En direct · ${framesStreamed} frames` : `Live · ${framesStreamed} frames`;
      case 'reconnecting':  return isFr ? 'Reconnexion…'              : 'Reconnecting…';
      case 'failed':        return isFr ? 'Stream interrompu'          : 'Stream interrupted';
      default:              return isFr ? 'Stream EigenVertex actif'   : 'EigenVertex stream active';
    }
  })();

  $: dotClass = (() => {
    if (!online)                            return 'dot-orange';
    if (liveStreamState === 'streaming')    return 'dot-green';
    if (liveStreamState === 'failed')       return 'dot-red';
    if (liveStreamState === 'reconnecting') return 'dot-orange';
    return 'dot-blue'; // connecting / idle
  })();
</script>

<div
  class="streaming-bar"
  class:offline={!online}
  class:reconnecting={liveStreamState === 'reconnecting'}
  class:failed={liveStreamState === 'failed'}
>
  <span class="ev-icon" class:pulse>◈</span>
  <span class="streaming-text">{label}</span>
  <span class="status-dot {dotClass}"></span>
</div>

<style>
  .streaming-bar {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 7px 12px;
    background: var(--ev-blue-bg);
    border: 1px solid rgba(154,209,255,0.25);
    border-radius: var(--radius-md);
    font-size: 0.75rem;
    color: var(--ev-text-dim);
    transition: background 200ms, border-color 200ms;
  }

  .streaming-bar.offline {
    background: rgba(245,158,11,0.06);
    border-color: rgba(245,158,11,0.2);
  }
  .streaming-bar.reconnecting {
    background: rgba(245,158,11,0.06);
    border-color: rgba(245,158,11,0.25);
  }
  .streaming-bar.failed {
    background: rgba(229,72,77,0.06);
    border-color: rgba(229,72,77,0.25);
  }

  .ev-icon {
    font-size: 1rem;
    color: var(--ev-blue);
    flex-shrink: 0;
  }
  .ev-icon.pulse {
    animation: pulse-send 0.4s ease-out;
    color: #60c4ff;
  }
  @keyframes pulse-send {
    0%   { transform: scale(1.3); color: #9ad1ff; }
    100% { transform: scale(1);   color: var(--ev-blue); }
  }

  .failed .ev-icon, .offline .ev-icon { color: var(--ev-danger); }
  .reconnecting .ev-icon              { color: var(--ev-orange); }

  .streaming-text { flex: 1; }

  /* Status dot — mirrors ConnectionStatus style */
  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-green  { background: var(--green);      animation: pulse-dot 2s ease-in-out infinite; }
  .dot-blue   { background: var(--blue-bright); animation: pulse-dot 1s ease-in-out infinite; }
  .dot-orange { background: var(--orange);     animation: pulse-dot 0.6s ease-in-out infinite; }
  .dot-red    { background: var(--ev-danger); }
</style>
