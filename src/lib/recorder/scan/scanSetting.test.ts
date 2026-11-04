import { describe, it, expect } from 'vitest';
import { isScanEnabled, setScanEnabled, SCAN_SETTING_KEY, type KeyValue } from './scanSetting';

const memory = (): KeyValue & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};

describe('scan setting', () => {
  it('is OFF by default (nothing stored)', () => {
    expect(isScanEnabled(memory())).toBe(false);
  });
  it('can be switched on and off again', () => {
    const kv = memory();
    setScanEnabled(true, kv);
    expect(kv.map.get(SCAN_SETTING_KEY)).toBe('1');
    expect(isScanEnabled(kv)).toBe(true);
    setScanEnabled(false, kv);
    expect(isScanEnabled(kv)).toBe(false);
    expect(kv.map.has(SCAN_SETTING_KEY)).toBe(false);
  });
  it('only the exact value "1" enables it', () => {
    const kv = memory();
    for (const v of ['true', '0', '', 'yes']) { kv.setItem(SCAN_SETTING_KEY, v); expect(isScanEnabled(kv), v).toBe(false); }
  });
  it('unavailable or throwing storage means OFF, never a crash', () => {
    expect(isScanEnabled(null)).toBe(false);
    const broken: KeyValue = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
    expect(isScanEnabled(broken)).toBe(false);
    expect(() => setScanEnabled(true, broken)).not.toThrow();
  });
});
