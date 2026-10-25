/**
 * A model id DELETED from a step's catalog behaves like any id the catalog does
 * not know: `resolveModelForFormat` returns it UNCHANGED, as an operator's
 * custom model (there is no `RETIRED_MODEL_IDS` any more — the redirect to the
 * format default is gone, and so is the substitution it used to report).
 *
 * What these specs pin is the catalog side — every deleted id is really absent
 * and the survivor is the whole offer — and the pass-through side. The deleted
 * ids are `REMOVED_MODEL_IDS` from `@camstack/types`: the list the
 * orchestrator's stored-pin reset reads (D725). An id listed there that a
 * catalog still ships, or a step id no catalog knows, fails here.
 */
import { REMOVED_MODEL_IDS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import * as modelCatalogs from '../registry/model-catalogs.js'
import { getStepDefinition, resolveModelForFormat } from '../registry/step-definitions.js'
import { collectSubstitutions } from '../step-resolution.js'

const REMOVED: readonly (readonly [stepId: string, id: string])[] = Object.entries(
  REMOVED_MODEL_IDS,
).flatMap(([stepId, ids]) => ids.map((id) => [stepId, id] as const))

const SURVIVORS: readonly (readonly [stepId: string, id: string])[] = [
  ['face-detection', 'yunet-2023mar'],
  ['face-embedding', 'auraface-r100'],
  ['plate-ocr', 'cct-s-v2-global'],
  ['clip-embedding', 'siglip2-b16-224'],
  ['package-detection', 'rfdetr-package'],
  ['plate-detection', 'yolox-tiny-plate'],
]

describe('removed model ids', () => {
  it('the list still names every model D703/D710/D719 deleted', () => {
    expect(REMOVED.length).toBeGreaterThanOrEqual(16)
    expect(REMOVED).toContainEqual(['object-detection', 'ssdlite-mobiledet-coco-edgetpu'])
  })

  it('RETIRED_MODEL_IDS no longer exists', () => {
    expect('RETIRED_MODEL_IDS' in modelCatalogs).toBe(false)
  })

  it.each(REMOVED)('%s: %s is gone from the catalog', (stepId, id) => {
    expect(getStepDefinition(stepId).models.some((m) => m.id === id)).toBe(false)
  })

  it.each(SURVIVORS)('%s: %s is the only entry', (stepId, id) => {
    expect(getStepDefinition(stepId).models.map((m) => m.id)).toEqual([id])
  })

  it.each(SURVIVORS)('%s: %s is the step default', (stepId, id) => {
    expect(getStepDefinition(stepId).defaultModelId).toBe(id)
  })

  it.each(
    REMOVED,
  )('%s: a saved %s pin passes through unchanged, like a custom model', (stepId, id) => {
    for (const format of ['onnx', 'openvino', 'coreml'] as const) {
      expect(resolveModelForFormat(stepId, id, format)).toBe(id)
    }
  })

  it('a removed pin is no longer reported as a substitution', () => {
    expect(
      collectSubstitutions(
        [
          {
            addonId: 'animal-classifier',
            modelId: 'animals-10',
            enabled: true,
          },
        ],
        'onnx',
      ),
    ).toEqual([])
  })

  it('an unknown id is still treated as a custom model', () => {
    expect(resolveModelForFormat('animal-classifier', 'my-custom', 'onnx')).toBe('my-custom')
    expect(resolveModelForFormat('face-detection', 'my-own-face-model', 'onnx')).toBe(
      'my-own-face-model',
    )
  })
})
