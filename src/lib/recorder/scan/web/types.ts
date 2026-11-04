/**
 * Core type definitions for the document scanning pipeline.
 *
 * The pipeline is modeled as a sequence of typed Stages. Each stage transforms
 * a typed input into a typed output. This makes implementations swappable
 * (e.g. naive dewarp -> Zucker dewarp -> ML dewarp) without rippling changes.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** A quadrilateral in image coordinates, ordered TL, TR, BR, BL. */
export interface Quad {
  readonly tl: Point2;
  readonly tr: Point2;
  readonly br: Point2;
  readonly bl: Point2;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

// ---------------------------------------------------------------------------
// Frames & images
// ---------------------------------------------------------------------------

/**
 * A raw frame coming straight from the camera. We keep it as ImageData for
 * worker-friendly transfer (zero-copy via transferable buffers).
 */
export interface RawFrame {
  readonly kind: 'raw';
  readonly image: ImageData;
  readonly capturedAt: number;
}

export interface DetectedFrame {
  readonly kind: 'detected';
  readonly image: ImageData;
  readonly quad: Quad;
  /** Confidence in [0, 1]. */
  readonly confidence: number;
  readonly capturedAt: number;
}

export interface RectifiedPage {
  readonly kind: 'rectified';
  readonly image: ImageData;
  readonly sourceQuad: Quad;
  readonly targetSize: Size;
}

export interface DewarpedPage {
  readonly kind: 'dewarped';
  readonly image: ImageData;
  /** Sentinel allowing downstream stages to know if real dewarping ran. */
  readonly applied: boolean;
}

export interface EnhancedPage {
  readonly kind: 'enhanced';
  readonly image: ImageData;
  readonly mode: EnhancementMode;
}

export type EnhancementMode =
  | 'auto'
  | 'document-bw'
  | 'document-color'
  | 'photo'
  | 'none';

// ---------------------------------------------------------------------------
// Pipeline contract
// ---------------------------------------------------------------------------

export interface PipelineContext {
  readonly settings: PipelineSettings;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
}

export interface PipelineSettings {
  readonly enhancement: EnhancementMode;
  readonly dewarpStrategy: DewarpStrategy;
  readonly outputDpi: number;
  readonly preserveRaw: boolean;
}

export type DewarpStrategy = 'none' | 'naive' | 'zucker' | 'ml';

export interface ProgressEvent {
  readonly stage: string;
  readonly progress: number; // [0, 1]
  readonly message?: string;
}

/**
 * Generic stage interface. TIn and TOut are tagged union members which makes
 * pipeline composition typesafe at compile time.
 */
export interface Stage<TIn, TOut> {
  readonly name: string;
  readonly version: string;
  process(input: TIn, ctx: PipelineContext): Promise<TOut>;
}

/**
 * Record of which stage implementation processed a page, for audit and
 * for the ability to re-run the pipeline on raw input later with better algos.
 */
export interface PipelineRecord {
  readonly stages: ReadonlyArray<{
    readonly name: string;
    readonly version: string;
    readonly durationMs: number;
  }>;
  readonly totalDurationMs: number;
  readonly settings: PipelineSettings;
}
