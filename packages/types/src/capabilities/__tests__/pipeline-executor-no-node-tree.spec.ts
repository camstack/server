import { describe, expect, it } from 'vitest'
import { pipelineExecutorCapability } from '../pipeline-executor.cap.js'

/**
 * D927: the executor's computed node-default tree is not a cap surface. A
 * caller that wants the model a frame ran asks the frame (`{modelId,
 * deviceKey}`), and a caller that wants an accelerator's model asks the
 * orchestrator (`getNodeInferenceDevices`) — never a tree the node computes
 * that no camera ran.
 */
describe('pipeline-executor exposes no computed node tree (D927)', () => {
  it.each(['getGlobalSteps', 'getGlobalPipelineConfig', 'getDefaultSteps'])('%s is gone', (m) => {
    expect(Object.keys(pipelineExecutorCapability.methods)).not.toContain(m)
  })
})
