// webScannerHost — the bridge between the engine (plain TypeScript) and the scanner screen (a Svelte component).
// The component registers itself when mounted; the engine asks it to open and waits for the scanned pages.

import type { ScannedPage } from './pdf.js';

export interface WebScannerHost {
  /** Opens the scanner. Resolves with the scanned pages when the user finishes, or null when they abandon. */
  open(): Promise<ScannedPage[] | null>;
}

let current: WebScannerHost | null = null;

export function registerWebScannerHost(host: WebScannerHost): () => void {
  current = host;
  return () => { if (current === host) current = null; };
}

export function getWebScannerHost(): WebScannerHost | null { return current; }
