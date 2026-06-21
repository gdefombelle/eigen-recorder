// audioEngine — persists the user's audio engine preference.
// Only meaningful on native iOS (Capacitor), where both engines are available.
// On web / PWA the AudioRecorder (MediaRecorder) is always used regardless.

import { writable, get } from 'svelte/store';

export type AudioEngine = 'native' | 'web';

const KEY = 'ev_audio_engine';

function _load(): AudioEngine {
  if (typeof localStorage === 'undefined') return 'native';
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'web' || v === 'native') return v;
  } catch { /* SSR / private browsing */ }
  return 'native';
}

const _store = writable<AudioEngine>(_load());

export const audioEngineStore = { subscribe: _store.subscribe };

export function getAudioEngine(): AudioEngine { return get(_store); }

export function setAudioEngine(engine: AudioEngine): void {
  _store.set(engine);
  try { localStorage.setItem(KEY, engine); } catch { /* ignore */ }
}
