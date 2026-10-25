/**
 * `validatePipeline` can be asked about ONE device pool (D646).
 *
 * It resolved against the node-default format only, so the replay's cheap
 * question — "can (node, deviceKey) run exactly this model?" — asked about the
 * wrong pool on any node with more than one accelerator, and the analysis
 * found the old replay preflight checking the hub's format for an agent's run.
 */
import type { IScopedLogger, PipelineStepInput } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'
import { getStepDefinition } from '../registry/step-definitions.js'

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

function openvinoOnlySteps(): readonly PipelineStepInput[] {
  const def = getStepDefinition('object-detection')
  // Non-legacy: a legacy pin falls back to the format default on every format,
  // so it would be a substitution even on the openvino pool.
  const entry = def.models.find(
    (m) => m.legacy !== true && m.formats['openvino'] && !m.formats['onnx'],
  )
  if (entry === undefined) throw new Error('catalog has no openvino-only detector to test with')
  return [{ addonId: 'object-detection', modelId: entry.id, enabled: true }]
}

describe('validatePipeline — per device pool (D646)', () => {
  it('without a deviceKey it validates against the node-default format (onnx here)', async () => {
    const result = await makeProvider().validatePipeline({ steps: openvinoOnlySteps() })
    expect(result.format).toBe('onnx')
    expect(result.substitutions).toHaveLength(1)
  })

  it('with a deviceKey it validates against THAT pool’s format', async () => {
    const result = await makeProvider().validatePipeline({
      steps: openvinoOnlySteps(),
      deviceKey: 'openvino:npu',
    })
    expect(result.format).toBe('openvino')
    expect(result.substitutions).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('an unknown device pool is a HARD issue, not a silent pass', async () => {
    const result = await makeProvider().validatePipeline({
      steps: openvinoOnlySteps(),
      deviceKey: 'quantum:qpu',
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map((i) => i.kind)).toEqual(['unknown-device'])
  })
})
