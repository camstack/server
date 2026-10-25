/**
 * The synthetic bench is START-then-POLL, carries no engine override, and
 * reports the tuning of the POOL it measured (D646).
 *
 * `runSyntheticBench` answered synchronously: up to 16 parallel × 1000
 * iterations on the UDS addon-call plane, whose request timeout is 60 s. A
 * long bench was abandoned by its caller while it kept loading the node.
 */
import { describe, expect, it } from 'vitest'
import { pipelineRunnerBenchActions, StartSyntheticBenchInputSchema } from '../bench-actions.js'
import { buildBenchTuningQuery } from '../bench-dispatch.js'
import { RunCapacityRampInputSchema } from '../capacity/capacity-schemas.js'

const STEP = { addonId: 'object-detection', modelId: 'yolov9t', enabled: true }
const FOREIGN_ENGINE = { runtime: 'python', backend: 'onnx', format: 'onnx', device: 'cuda' }

describe('synthetic bench — start then poll (D646)', () => {
  it('the catalog offers start + status and no synchronous run', () => {
    const names = Object.keys(pipelineRunnerBenchActions)
    expect(names).toContain('startSyntheticBench')
    expect(names).toContain('getSyntheticBenchStatus')
    expect(names).toContain('abortSyntheticBench')
    expect(names).not.toContain('runSyntheticBench')
  })

  it('start requires the correlation id it is polled by', () => {
    const missing = StartSyntheticBenchInputSchema.safeParse({
      frameId: 'f',
      steps: [STEP],
      parallel: 1,
      iterations: 1,
    })
    expect(missing.success).toBe(false)
  })
})

describe('no engine override reaches the runner bench paths (D646)', () => {
  it('a smuggled `engine` on a synthetic bench start is stripped', () => {
    const parsed = StartSyntheticBenchInputSchema.parse({
      frameId: 'f',
      steps: [STEP],
      parallel: 1,
      iterations: 1,
      sessionId: 's',
      engine: FOREIGN_ENGINE,
    })
    expect('engine' in parsed).toBe(false)
  })

  it('a smuggled `engine` on a capacity ramp is stripped', () => {
    const parsed = RunCapacityRampInputSchema.parse({
      frameId: 'f',
      steps: [STEP],
      sessionId: 's',
      engine: FOREIGN_ENGINE,
    })
    expect('engine' in parsed).toBe(false)
  })
})

describe('the tuning reported is the measured pool’s (D646)', () => {
  it('asks the benched node for the benched deviceKey pool', () => {
    expect(buildBenchTuningQuery({ nodeId: 'agent-a', deviceKey: 'openvino:gpu' })).toEqual({
      nodeId: 'agent-a',
      input: { deviceKey: 'openvino:gpu' },
    })
  })

  it('asks for the node-default pool when no deviceKey was benched — absent, not undefined', () => {
    const query = buildBenchTuningQuery({ nodeId: 'hub' })
    expect(query).toEqual({ nodeId: 'hub', input: {} })
    expect('deviceKey' in query.input).toBe(false)
  })
})
