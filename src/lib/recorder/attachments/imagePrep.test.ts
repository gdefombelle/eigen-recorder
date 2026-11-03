import { describe, it, expect } from 'vitest';
import { fitWithin, sha256Hex, PHOTO_MAX_SIDE } from './imagePrep';

describe('fitWithin — long side ≤ 2048', () => {
  it('landscape larger than the limit is scaled by its long side', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
  });
  it('portrait larger than the limit is scaled by its long side', () => {
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
  });
  it('never upscales a small image', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it('an image exactly at the limit is untouched', () => {
    expect(fitWithin(PHOTO_MAX_SIDE, 1000)).toEqual({ width: 2048, height: 1000 });
  });
  it('extreme panorama keeps a ≥ 1 px short side', () => {
    expect(fitWithin(20000, 10).height).toBeGreaterThanOrEqual(1);
  });
});

describe('sha256Hex', () => {
  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex(new Blob(['abc']))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('is computed over the exact bytes (different bytes → different hash)', async () => {
    expect(await sha256Hex(new Blob(['abc']))).not.toBe(await sha256Hex(new Blob(['abd'])));
  });
});
