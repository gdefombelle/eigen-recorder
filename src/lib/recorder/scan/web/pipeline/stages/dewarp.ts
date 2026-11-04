/**
 * Stage 3: dewarp - correct residual page curvature.
 *
 * This is the most differentiating stage of the pipeline and the reason
 * a custom Rust->WASM module is planned. Three strategies are anticipated:
 *
 * - 'none'   : passthrough, used for flat sheets where rectify is enough.
 * - 'naive'  : cylindrical model, fits a single curve along the page spine.
 *              Cheap and works for many bound books photographed perpendicular
 *              to the spine.
 * - 'zucker' : Matt Zucker's page_dewarp algorithm (text-baseline mesh).
 *              Best general-purpose results. Will be implemented in Rust.
 * - 'ml'     : neural model (e.g. DocTr or DocUNet) via ONNX runtime web.
 *              Most robust, heaviest in compute and bundle size.
 *
 * The Stage interface guarantees these are interchangeable.
 */

import type {
  DewarpedPage,
  DewarpStrategy,
  PipelineContext,
  RectifiedPage,
  Stage
} from '../../types.js';

/** Passthrough: useful as default and for flat sheets. */
export class NoopDewarpStage implements Stage<RectifiedPage, DewarpedPage> {
  readonly name = 'dewarp.noop';
  readonly version = '0.1.0';

  async process(input: RectifiedPage, _ctx: PipelineContext): Promise<DewarpedPage> {
    return { kind: 'dewarped', image: input.image, applied: false };
  }
}

/**
 * Naive cylindrical dewarp placeholder. Real implementation will:
 *  1. Detect text lines (binarize + connected components + line grouping).
 *  2. Fit a low-degree polynomial to top and bottom envelopes.
 *  3. Build a 2D grid mesh and inverse-map pixels.
 *
 * For now, returns the input unchanged so the pipeline runs end-to-end.
 */
export class NaiveDewarpStage implements Stage<RectifiedPage, DewarpedPage> {
  readonly name = 'dewarp.naive';
  readonly version = '0.1.0';

  async process(input: RectifiedPage, _ctx: PipelineContext): Promise<DewarpedPage> {
    return { kind: 'dewarped', image: input.image, applied: false };
  }
}

/**
 * Adapter that picks a strategy at runtime. Add new implementations
 * (Zucker, ML) by registering them here.
 */
export class StrategyDewarpStage implements Stage<RectifiedPage, DewarpedPage> {
  readonly name = 'dewarp.strategy';
  readonly version = '0.1.0';

  private readonly impls: Record<DewarpStrategy, Stage<RectifiedPage, DewarpedPage>>;

  constructor(impls?: Partial<Record<DewarpStrategy, Stage<RectifiedPage, DewarpedPage>>>) {
    const noop = new NoopDewarpStage();
    const naive = new NaiveDewarpStage();
    this.impls = {
      none: impls?.none ?? noop,
      naive: impls?.naive ?? naive,
      zucker: impls?.zucker ?? noop, // until Rust impl lands
      ml: impls?.ml ?? noop
    };
  }

  async process(input: RectifiedPage, ctx: PipelineContext): Promise<DewarpedPage> {
    const impl = this.impls[ctx.settings.dewarpStrategy];
    return impl.process(input, ctx);
  }
}
