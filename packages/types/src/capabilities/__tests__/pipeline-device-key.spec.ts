import { describe, it, expect } from 'vitest'
import { pipelineExecutorCapability } from '../pipeline-executor.cap.js'
import { pipelineRunnerCapability } from '../pipeline-runner.cap.js'

describe('deviceKey plumbing (Phase 2 multi-device)', () => {
  it('runPipeline input has a deviceKey field', () => {
    const shape = pipelineExecutorCapability.methods.runPipeline.input.shape
    expect('deviceKey' in shape).toBe(true)
  })

  it('runPipelineBatch input has a deviceKey field', () => {
    const shape = pipelineExecutorCapability.methods.runPipelineBatch.input.shape
    expect('deviceKey' in shape).toBe(true)
  })

  it('RunnerCameraConfig (attachCamera input) has a deviceKey field', () => {
    const shape = pipelineRunnerCapability.methods.attachCamera.input.shape
    expect('deviceKey' in shape).toBe(true)
  })

  it('deviceKey is optional (omitted or a string both valid at the field level)', () => {
    const field = pipelineExecutorCapability.methods.runPipeline.input.shape.deviceKey
    expect(field.safeParse(undefined).success).toBe(true)
    expect(field.safeParse('edgetpu:usb').success).toBe(true)
  })
})
