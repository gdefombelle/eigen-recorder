import type {
  DetectedFrame,
  PipelineContext,
  RawFrame,
  Stage
} from '../../types.js';
import { toGrayscale, detectEdgesFromGray } from '../../cv/edges.js';
import { findDocumentQuad, scaleQuad } from '../../cv/quad.js';

/** Canny edge detection + extremal-projection quad finder. */
export class JsDetectStage implements Stage<RawFrame, DetectedFrame> {
  readonly name = 'detect.js';
  readonly version = '1.0.0';

  // Downsample to this width before edge detection for speed.
  private static readonly PROC_WIDTH = 640;

  async process(input: RawFrame, _ctx: PipelineContext): Promise<DetectedFrame> {
    const { width, height } = input.image;

    const scale = width > JsDetectStage.PROC_WIDTH ? JsDetectStage.PROC_WIDTH / width : 1;
    const procImg = scale < 1 ? await downsample(input.image, scale) : input.image;

    const gray = toGrayscale(procImg);
    const edges = detectEdgesFromGray(gray, procImg.width, procImg.height);
    const rawQuad = findDocumentQuad(gray, edges, procImg.width, procImg.height);

    if (!rawQuad) {
      // Fallback: 5% inset with zero confidence so callers know detection failed.
      const ix = width * 0.05, iy = height * 0.05;
      return {
        kind: 'detected',
        image: input.image,
        capturedAt: input.capturedAt,
        confidence: 0,
        quad: {
          tl: { x: ix,           y: iy },
          tr: { x: width - ix,   y: iy },
          br: { x: width - ix,   y: height - iy },
          bl: { x: ix,           y: height - iy },
        },
      };
    }

    const quad = scale < 1 ? scaleQuad(rawQuad, scale) : rawQuad;
    return { kind: 'detected', image: input.image, capturedAt: input.capturedAt, confidence: 0.8, quad };
  }
}

async function downsample(img: ImageData, scale: number): Promise<ImageData> {
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(img, 0, 0);
  const dst = new OffscreenCanvas(w, h);
  dst.getContext('2d')!.drawImage(src, 0, 0, w, h);
  return dst.getContext('2d')!.getImageData(0, 0, w, h);
}

/** Passthrough placeholder — kept for easy A/B comparison. */
export class NaiveDetectStage implements Stage<RawFrame, DetectedFrame> {
  readonly name = 'detect.naive';
  readonly version = '0.1.0';

  async process(input: RawFrame, _ctx: PipelineContext): Promise<DetectedFrame> {
    const { width, height } = input.image;
    const ix = width * 0.05, iy = height * 0.05;
    return {
      kind: 'detected',
      image: input.image,
      capturedAt: input.capturedAt,
      confidence: 0,
      quad: {
        tl: { x: ix,         y: iy },
        tr: { x: width - ix, y: iy },
        br: { x: width - ix, y: height - iy },
        bl: { x: ix,         y: height - iy },
      },
    };
  }
}
