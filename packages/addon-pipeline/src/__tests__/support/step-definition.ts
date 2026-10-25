import type { StepDefinition } from '@camstack/types'
import { makeModelCatalogEntry } from './model-catalog-entry.js'

/** Minimal classifier-shaped {@link StepDefinition} for executor / runner specs. */
export function makeClassifierStepDefinition(
  patch: Partial<StepDefinition> & Pick<StepDefinition, 'id'>,
): StepDefinition {
  const modelId = patch.defaultModelId ?? 'test-model'
  return {
    name: patch.name ?? patch.id,
    slot: 'classifier',
    postprocessor: 'clip',
    extractMode: 'crop-roi',
    inputClasses: ['person'],
    outputClasses: ['embedding'],
    defaultConfidence: 0.25,
    defaultModelId: modelId,
    models: [
      makeModelCatalogEntry({
        id: modelId,
        name: modelId,
      }),
    ],
    ...patch,
    id: patch.id,
  }
}
