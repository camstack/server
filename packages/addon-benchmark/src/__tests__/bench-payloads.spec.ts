/**
 * Pure payload construction for the Detection Pipeline tab.
 *
 * Every assertion here is about a knob REACHING the run. The tab that used
 * to build these objects inline shipped three knobs that did not: an
 * override form whose edits were dropped, a "live path" button that took
 * the `'full'` plane, and a card titled "saves to history" that never
 * saved. Keeping the construction pure is what makes those assertable.
 */
import { describe, expect, it } from 'vitest'
import { buildPipelineRunInput } from '../bench-payloads.js'
import type { PipelineStepInputOutput } from '../benchmark-schemas.js'

const STEPS: readonly PipelineStepInputOutput[] = [
  { addonId: 'object-detection', modelId: 'yolov9m-320-int8', enabled: true, children: [] },
]

describe('buildPipelineRunInput', () => {
  it('carries the resolved (node, deviceKey) pair into the payload', () => {
    const input = buildPipelineRunInput({
      steps: STEPS,
      imageBase64: 'AAAA',
      nodeId: 'agent-a',
      sessionId: 'ui-1',
      deviceKey: 'openvino:gpu',
    })
    expect(input.nodeId).toBe('agent-a')
    expect(input.deviceKey).toBe('openvino:gpu')
  })

  it('carries the execution plane', () => {
    const input = buildPipelineRunInput({
      steps: STEPS,
      imageBase64: 'AAAA',
      nodeId: 'hub',
      sessionId: 'ui-1',
      plane: 'frame',
    })
    expect(input.plane).toBe('frame')
  })

  /**
   * Absent, not `undefined`. `addons.custom` ships the input through
   * superjson and the action schema treats a present-but-undefined key
   * differently from an omitted one.
   */
  it('omits deviceKey and plane entirely when the operator picked neither', () => {
    const input = buildPipelineRunInput({
      steps: STEPS,
      imageBase64: 'AAAA',
      nodeId: 'hub',
      sessionId: 'ui-1',
    })
    expect(Object.keys(input).toSorted()).toEqual(
      ['imageBase64', 'nodeId', 'sessionId', 'steps'].toSorted(),
    )
  })
})
