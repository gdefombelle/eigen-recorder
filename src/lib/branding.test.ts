/**
 * Guards the display-name rename to "Eigen Pocket" with "by EigenVertex"
 * (one word, capital V) in the screens where the brand is shown.
 *
 * No component-rendering infra exists in this project (no jsdom/
 * testing-library) — these read the source files as text, matching how the
 * rest of the suite tests logic rather than rendered output.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('branding — app.html', () => {
  it('uses "Eigen Pocket" for the iOS home-screen title, not a stale abbreviation', () => {
    const html = read('src/app.html');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Eigen Pocket" />');
    expect(html).not.toContain('EigenMtg');
  });

  it('keeps the browser tab title as the short product name', () => {
    expect(read('src/app.html')).toContain('<title>Eigen Pocket</title>');
  });
});

describe('branding — Settings footer (About-style screen)', () => {
  it('shows "by EigenVertex" next to the version string, smaller than it', () => {
    const svelte = read('src/routes/settings/+page.svelte');
    expect(svelte).toContain('Eigen Pocket v0.1.0 <span class="version-by">by EigenVertex</span>');
    expect(svelte).not.toMatch(/by\s+Eigen\s+Vertex\b/); // never the two-word company name
  });

  it('never resizes the EIGENVERTEX wordmark row — that is the untouched logo text', () => {
    const svelte = read('src/routes/settings/+page.svelte');
    expect(svelte).toContain('<div class="ev-brand"><span class="ev-dot"></span>EIGENVERTEX</div>');
  });

  it('styles the "by" caption smaller and dimmer than the version line it sits on', () => {
    const css = read('src/routes/settings/+page.svelte');
    const versionSize = Number(css.match(/\.version-str\s*{\s*font-size:\s*([\d.]+)rem/)?.[1]);
    const bySize       = Number(css.match(/\.version-by\s*{\s*font-size:\s*([\d.]+)rem/)?.[1]);
    expect(bySize).toBeGreaterThan(0);
    expect(bySize).toBeLessThan(versionSize);
  });
});
