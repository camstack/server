/**
 * Model ids DELETED from a step's catalog (D703, D710, D719), per step — and
 * the one question asked of them: is a stored pin to this id a pin to a model
 * that no longer exists? (D725)
 *
 * This is NOT a resolver input. `resolveModelForFormat` still returns an
 * unknown id unchanged (a custom model), and a bulk pass pinned to one still
 * refuses rather than substitutes (D54). The ONE reader is the orchestrator's
 * stored-pin reset (`removed-model-pin-reset.ts`), which clears such a pin from
 * the store so the step follows its default again — unless a registered custom
 * model carries the same id.
 *
 * `removed-model-ids.spec.ts` (addon-pipeline) pins that every id here is
 * really absent from its step's catalog. A model deleted from a catalog is
 * added here in the same change, or its stored pins stay behind as custom ids.
 */

/** `stepId → ids deleted from that step's catalog`. */
export const REMOVED_MODEL_IDS: Readonly<Record<string, readonly string[]>> = {
  'object-detection': ['efficientdet-lite0-edgetpu', 'ssdlite-mobiledet-coco-edgetpu'],
  'face-detection': ['scrypted-yolov9t-face', 'scrfd-2.5g', 'ssd-mobilenet-v2-face-edgetpu'],
  'face-embedding': ['arcface-r100', 'inception-resnet-v1'],
  'plate-detection': ['yolov8n-plate'],
  'plate-ocr': ['vgg-english-g2'],
  'clip-embedding': ['mobileclip-s0', 'mobileclip-s1', 'mobileclip-s2'],
  'package-detection': ['yolov8n-package'],
  'bird-classifier': ['bird-classifier-aiy-edgetpu', 'bird-nabirds-404'],
  'animal-classifier': ['animals-10'],
  'vehicle-classifier': ['vehicle-type-efficientnet'],
}

/** True when `modelId` was deleted from `stepId`'s catalog. */
export function isRemovedModelId(stepId: string, modelId: string): boolean {
  return REMOVED_MODEL_IDS[stepId]?.includes(modelId) ?? false
}
