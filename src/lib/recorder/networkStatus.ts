import { writable } from 'svelte/store';

function createNetworkStore() {
  const { subscribe, set } = writable<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  function init() {
    if (typeof window === 'undefined') return;
    window.addEventListener('online',  () => set(true));
    window.addEventListener('offline', () => set(false));
  }

  return { subscribe, init };
}

export const networkStatus = createNetworkStore();
