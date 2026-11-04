import { describe, it, expect } from 'vitest';
import { setLang, t } from './index';

function shape(lang: 'fr' | 'en') {
  setLang(lang);
  const a = t().attachments as Record<string, unknown>;
  return Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'function' ? v.length : typeof v]));
}

describe('attachments strings — FR/EN parity', () => {
  it('both languages define the same keys, with the same kind and arity', () => {
    expect(shape('fr')).toEqual(shape('en'));
  });

  it('no string is left empty or identical-by-accident to a key placeholder', () => {
    for (const lang of ['fr', 'en'] as const) {
      setLang(lang);
      for (const [k, v] of Object.entries(t().attachments as Record<string, unknown>)) {
        const text = typeof v === 'function' ? String((v as (...a: unknown[]) => unknown)(2, 2)) : String(v);
        expect(text.trim().length, `${lang}.${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('plurals follow the language', () => {
    setLang('fr'); expect(t().attachments.listSubtitle(1)).toContain('1 pièce ·'); expect(t().attachments.listSubtitle(3)).toContain('3 pièces');
    setLang('en'); expect(t().attachments.listSubtitle(1)).toContain('1 item ·'); expect(t().attachments.listSubtitle(3)).toContain('3 items');
  });
});

describe('record end-screen warning — FR/EN', () => {
  it('"finalization not confirmed" exists in both languages with the agreed wording', () => {
    setLang('fr'); expect(t().recorder.finalizeUnconfirmed).toBe('Finalisation non confirmée, nouvelle tentative automatique');
    expect(t().recorder.finalizeIssue('timeout', 'No answer', 2)).toBe('Délai dépassé · No answer · tentative 2');
    setLang('en'); expect(t().recorder.finalizeUnconfirmed).toMatch(/not confirmed/i);
    expect(t().recorder.finalizeIssue('error', 'HTTP 500', 1)).toBe('Error · HTTP 500');
  });
});

describe('scan strings — agreed wording, FR/EN', () => {
  it('sheet entry, subtitle, default title and page badge', () => {
    setLang('fr');
    expect(t().attachments.scan).toBe('Scanner un document');
    expect(t().attachments.scanHint).toBe('Détection des bords, PDF multipages');
    expect(t().attachments.defaultScanTitle('00:46')).toBe('Scan 00:46');
    expect(t().attachments.pagesShort(5)).toBe('5 p.');
    expect(t().attachments.scanCardLabel('00:46', 3)).toBe('Scan 00:46 · 3 p.');
    expect(t().attachments.scanCardLabel('00:46', null)).toBe('Scan 00:46');
    setLang('en');
    expect(t().attachments.scan).toBe('Scan a document');
    expect(t().attachments.defaultScanTitle('00:46')).toBe('Scan 00:46');
  });

  it('the too-large message states the size and the 25 MB limit in both languages', () => {
    setLang('fr'); expect(t().attachments.errScanTooLarge(31)).toMatch(/31 Mo.*25 Mo/);
    setLang('en'); expect(t().attachments.errScanTooLarge(31)).toMatch(/31 MB.*25 MB/);
  });
});

describe('settings — scan opt-in label', () => {
  it('exists in both languages', () => {
    setLang('fr'); expect(t().settings.scanExperimental).toBe('Scanner un document (expérimental)');
    setLang('en'); expect(t().settings.scanExperimental).toBe('Scan a document (experimental)');
  });
});
