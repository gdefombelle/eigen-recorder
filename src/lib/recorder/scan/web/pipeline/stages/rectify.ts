import type {
  DetectedFrame,
  PipelineContext,
  RectifiedPage,
  Stage
} from '../../types.js';
import { perspectiveWarp } from '../../cv/homography.js';
import { targetSizeFromQuad } from '../../cv/quad.js';

/** Full perspective warp via DLT homography. */
export class JsRectifyStage implements Stage<DetectedFrame, RectifiedPage> {
  readonly name = 'rectify.js';
  readonly version = '1.0.0';

  async process(input: DetectedFrame, _ctx: PipelineContext): Promise<RectifiedPage> {
    const targetSize = targetSizeFromQuad(input.quad);
    const image = perspectiveWarp(input.image, input.quad, targetSize.width, targetSize.height);
    return { kind: 'rectified', image, sourceQuad: input.quad, targetSize };
  }
}

/** Passthrough — no warp, kept for A/B comparison. */
export class NaiveRectifyStage implements Stage<DetectedFrame, RectifiedPage> {
  readonly name = 'rectify.naive';
  readonly version = '0.1.0';

  async process(input: DetectedFrame, _ctx: PipelineContext): Promise<RectifiedPage> {
    const targetSize = targetSizeFromQuad(input.quad);
    return { kind: 'rectified', image: input.image, sourceQuad: input.quad, targetSize };
  }
}
