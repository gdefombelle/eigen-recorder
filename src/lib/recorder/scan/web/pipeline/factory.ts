/**
 * Default pipeline factory. Composes the current best-known stages into
 * a ScanPipeline. Swap implementations here as new ones land.
 */

import type { ScanPipeline } from './orchestrator.js';
import { JsDetectStage } from './stages/detect.js';
import { JsRectifyStage } from './stages/rectify.js';
import { StrategyDewarpStage } from './stages/dewarp.js';
import { BasicEnhanceStage } from './stages/enhance.js';

export function createDefaultPipeline(): ScanPipeline {
  return {
    detect: new JsDetectStage(),
    rectify: new JsRectifyStage(),
    dewarp: new StrategyDewarpStage(),
    enhance: new BasicEnhanceStage(),
  };
}
