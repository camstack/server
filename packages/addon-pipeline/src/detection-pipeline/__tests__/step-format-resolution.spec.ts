/**
 * A step's model resolves against the FORMAT it will run on.
 *
 * `inputStepsToPipelineSteps` takes an optional `format` that defaults to
 * `this.currentEngine.format` (the node-default pool); a `deviceKey`
 * dispatch passes that device's format explicitly. These cases used to be
 * framed as the benchmark engine-override's format fix (Task G3); the
 * override is gone (D646), the format seam is not, and a `deviceKey` pool on
 * a node whose default is another format depends on it exactly as the
 * override did.
 */
import type { IScopedLogger, PipelineStepInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'
import { resolveInputSteps } from '../step-resolution.js'

function stubLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeProvider(): DetectionPipelineProvider {
  return new DetectionPipelineProvider(
    { readAddonStore: async () => ({}), writeAddonStore: async () => undefined },
    '/tmp/camstack-test-models',
    stubLogger(),
  )
}

// `yolo26n-int8` is an OpenVINO-only precision variant (no onnx/coreml
// build) — resolving it against 'onnx' substitutes to the onnx default;
// resolving it against 'openvino' keeps it verbatim. This asymmetry is
// what makes the format argument observable.
const OPENVINO_ONLY_MODEL_ID = 'yolo26n-int8'

function requireOpenvinoOnlyModel(): void {
  const def = getStepDefinition('object-detection')
  const entry = def.models.find((m) => m.id === OPENVINO_ONLY_MODEL_ID)
  if (!entry || entry.formats['onnx'] || !entry.formats['openvino']) {
    throw new Error(
      `catalog shape changed — ${OPENVINO_ONLY_MODEL_ID} is no longer openvino-only; pick another fixture model`,
    )
  }
}

describe('step model resolution follows the dispatch format', () => {
  it('sanity: the fixture model is openvino-only (no onnx build)', () => {
    requireOpenvinoOnlyModel()
  })

  describe('pure seam — resolveInputSteps', () => {
    const steps: readonly PipelineStepInput[] = [
      { addonId: 'object-detection', modelId: OPENVINO_ONLY_MODEL_ID, enabled: true },
    ]

    it('resolves the model for the passed format (kept, no substitution)', () => {
      const { steps: resolved, diagnostics } = resolveInputSteps(steps, 'openvino')
      expect(resolved[0]!.modelId).toBe(OPENVINO_ONLY_MODEL_ID)
      expect(diagnostics.substitutions).toEqual([])
    })

    it('resolves the SAME step differently for a different node format (substituted)', () => {
      const { steps: resolved, diagnostics } = resolveInputSteps(steps, 'onnx')
      const expectedOnnxDefault = getDefaultModelForFormat('object-detection', 'onnx')
      expect(resolved[0]!.modelId).toBe(expectedOnnxDefault)
      expect(resolved[0]!.modelId).not.toBe(OPENVINO_ONLY_MODEL_ID)
      expect(diagnostics.substitutions).toEqual([
        {
          addonId: 'object-detection',
          chosen: OPENVINO_ONLY_MODEL_ID,
          running: expectedOnnxDefault,
          format: 'onnx',
        },
      ])
    })
  })

  describe('adapter — DetectionPipelineProvider["inputStepsToPipelineSteps"]', () => {
    // Accessed via bracket notation (existing pattern in this test suite —
    // see probe-gated-auto-pick.spec.ts / engine-auto-resolve.spec.ts) since
    // the method is private; no `as` cast needed.
    const steps: readonly PipelineStepInput[] = [
      { addonId: 'object-detection', modelId: OPENVINO_ONLY_MODEL_ID, enabled: true },
    ]

    it('omitting the format falls back to currentEngine.format (default engine is onnx before init())', () => {
      const provider = makeProvider()
      expect(provider['currentEngine'].format).toBe('onnx')

      const resolved = provider['inputStepsToPipelineSteps'](steps)

      expect(resolved[0]!.modelId).toBe(getDefaultModelForFormat('object-detection', 'onnx'))
    })

    it('an explicit format resolves the step for THAT format, not currentEngine.format', () => {
      const provider = makeProvider()
      expect(provider['currentEngine'].format).toBe('onnx')

      const resolved = provider['inputStepsToPipelineSteps'](steps, 'openvino')

      // The openvino-only model is kept verbatim — proof the passed format
      // (not the still-onnx currentEngine.format) drove resolution.
      expect(resolved[0]!.modelId).toBe(OPENVINO_ONLY_MODEL_ID)
    })
  })
})
