/**
 * Stage 4: enhance - improve readability of the page image.
 *
 * Enhancement modes target different document types:
 *   - 'document-bw'    : adaptive threshold, strong contrast, near-binary.
 *   - 'document-color' : white balance + light denoise + contrast boost,
 *                        preserves color (good for diagrams, ink notes).
 *   - 'photo'          : minimal processing, preserves photographic content.
 *   - 'auto'           : pick a mode based on image statistics.
 *   - 'none'           : passthrough.
 *
 * Initial implementation does basic per-channel contrast stretching in pure JS.
 * Replace with OpenCV.js (cv.adaptiveThreshold, cv.fastNlMeansDenoising) for
 * proper quality. Heavy ops should also move to Rust->WASM eventually.
 */

import type {
  DewarpedPage,
  EnhancedPage,
  EnhancementMode,
  PipelineContext,
  Stage
} from '../../types.js';

export class BasicEnhanceStage implements Stage<DewarpedPage, EnhancedPage> {
  readonly name = 'enhance.basic';
  readonly version = '0.1.0';

  async process(input: DewarpedPage, ctx: PipelineContext): Promise<EnhancedPage> {
    const mode = ctx.settings.enhancement;
    const out =
      mode === 'none' ? input.image : applyContrastStretch(input.image);
    return { kind: 'enhanced', image: out, mode };
  }
}

/**
 * Per-channel contrast stretch with percentile clipping and white-balance correction.
 *
 * Uses the 1st/99th percentile of opaque pixels (alpha > 0) to determine the
 * stretch range. This handles two common camera issues:
 *   - Blue cast under artificial lighting: per-channel normalisation removes it.
 *   - Bright specular reflections skewing the max: percentile clipping ignores them.
 *   - Transparent border pixels from the perspective warp (alpha=0, RGB=0) are
 *     excluded so they don't pull the minimum to zero for every channel.
 */
function applyContrastStretch(img: ImageData): ImageData {
  const { data, width, height } = img;
  const out = new Uint8ClampedArray(data.length);

  // Build per-channel histograms over opaque pixels only.
  const h0 = new Uint32Array(256);
  const h1 = new Uint32Array(256);
  const h2 = new Uint32Array(256);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! === 0) continue;
    const ri = data[i]!, gi = data[i + 1]!, bi = data[i + 2]!;
    h0[ri] = (h0[ri] ?? 0) + 1;
    h1[gi] = (h1[gi] ?? 0) + 1;
    h2[bi] = (h2[bi] ?? 0) + 1;
    count++;
  }

  if (count === 0) return img;

  // Find 1st and 99th percentile for each channel.
  const lo: [number, number, number] = [0, 0, 0];
  const hi: [number, number, number] = [255, 255, 255];
  const hists = [h0, h1, h2] as const;
  const loThresh = count * 0.01;
  const hiThresh = count * 0.01;
  for (let c = 0; c < 3; c++) {
    const h = hists[c]!;
    let cum = 0;
    for (let v = 0; v < 256; v++) {
      cum += h[v]!;
      if (cum >= loThresh) { lo[c] = v; break; }
    }
    cum = 0;
    for (let v = 255; v >= 0; v--) {
      cum += h[v]!;
      if (cum >= hiThresh) { hi[c] = v; break; }
    }
  }

  const ranges: [number, number, number] = [
    Math.max(1, hi[0] - lo[0]),
    Math.max(1, hi[1] - lo[1]),
    Math.max(1, hi[2] - lo[2]),
  ];

  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!;
      out[i + c] = Math.min(255, Math.max(0, Math.round(((v - lo[c]!) / ranges[c]!) * 255)));
    }
    out[i + 3] = data[i + 3]!;
  }

  return new ImageData(out, width, height);
}

export function pickAutoMode(_img: ImageData): EnhancementMode {
  // Placeholder: real impl computes histogram, edge density, color saturation.
  return 'document-bw';
}
