import { DETECTOR_PERF } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { OBJECT_DETECTION_MODELS } from '../registry/model-catalogs.js'

// D745 — the Auto tune recommender picks from `DETECTOR_PERF` (a measured
// table in @camstack/types) and writes the pick as a node model pin. Every id
// it can pick must be a real catalog entry with a build for the accelerator the
// table measured it on, or the pin names a model the node cannot load.
const FORMAT_OF_ACCELERATOR: Readonly<Record<string, string>> = {
  'intel-npu': 'openvino',
  'intel-igpu': 'openvino',
  'apple-ane': 'coreml',
  coral: 'tflite',
}

describe('the recommender table names real, runnable catalog models', () => {
  for (const [hardwareClass, byAccelerator] of Object.entries(DETECTOR_PERF)) {
    for (const [accelerator, column] of Object.entries(byAccelerator ?? {})) {
      for (const modelId of Object.keys(column ?? {})) {
        it(`${hardwareClass}/${accelerator}: ${modelId}`, () => {
          const entry = OBJECT_DETECTION_MODELS.find((m) => m.id === modelId)
          expect(entry, `${modelId} is not in OBJECT_DETECTION_MODELS`).toBeDefined()
          const format = FORMAT_OF_ACCELERATOR[accelerator]
          if (format !== undefined) {
            expect(
              Object.keys(entry?.formats ?? {}),
              `${modelId} has no ${format} build`,
            ).toContain(format)
          } else {
            // x86 CPU: the plain ids run as ONNX, the -int8 ids as the OpenVINO IR.
            const expected = modelId.endsWith('-int8') ? 'openvino' : 'onnx'
            expect(Object.keys(entry?.formats ?? {})).toContain(expected)
          }
        })
      }
    }
  }
})
