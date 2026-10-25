import type { StepVariantHandle } from '../../detection-pipeline/engine/pipeline-model-manager.js'

export function makeStepVariantHandle(
  patch: Partial<StepVariantHandle> & Pick<StepVariantHandle, 'engine' | 'modelId'>,
): StepVariantHandle {
  return {
    poolIndex: patch.poolIndex ?? 0,
    engine: patch.engine,
    modelId: patch.modelId,
  }
}
