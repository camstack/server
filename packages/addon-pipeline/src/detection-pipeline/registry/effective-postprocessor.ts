/**
 * The postprocessor a step ACTUALLY runs with, for a given model.
 *
 * `StepDefinition.postprocessor` is the step's default decode;
 * `ModelCatalogEntry.postprocessor` overrides it per model, because one step can
 * host models with different raw output layouts (object-detection is `yolo`, a
 * Coral SSD build is `ssd`; plate-ocr is `ctc`, the plate reader is
 * `plate-slots`).
 *
 * It lives here because TWO places need the answer and they must never disagree:
 * `engine-factory.buildPoolModelConfig` tells the Python pool which decode to
 * run, and `PipelineExecutor` decides from the same fact which PIXELS to cut
 * (see `pipeline/plate-ocr-crop-policy.ts`). When those two drift, the model
 * decodes one way while the executor prepares the input for the other — which is
 * exactly what happened the first time the plate reader was wired: the pool ran
 * the fixed-slot decode while the executor still quad-warped the crop and
 * applied the CTC size floor, i.e. the one combination measured at 4/21 instead
 * of 19/21, and it produced no error anywhere.
 */
import type { ModelCatalogEntry, PostprocessorType, StepDefinition } from '@camstack/types'

export function resolveEffectivePostprocessor(
  definition: StepDefinition,
  modelId: string | undefined,
): PostprocessorType {
  const entry: ModelCatalogEntry | undefined = modelId
    ? definition.models.find((m) => m.id === modelId)
    : undefined
  return resolveEffectivePostprocessorForEntry(definition, entry)
}

/**
 * Entry-based variant for callers that already hold the `ModelCatalogEntry` —
 * required for CUSTOM (operator-registered) models, which are NOT in
 * `definition.models` and would otherwise silently fall back to the step
 * default decode (a plus catalog `yolonas` model decoded as `yolo` produces no
 * error anywhere, just zero detections).
 */
export function resolveEffectivePostprocessorForEntry(
  definition: StepDefinition,
  entry: ModelCatalogEntry | undefined,
): PostprocessorType {
  return entry?.postprocessor ?? definition.postprocessor
}
