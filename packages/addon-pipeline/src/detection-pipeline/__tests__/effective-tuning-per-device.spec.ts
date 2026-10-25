/**
 * `getEffectiveTuning` answers for the POOL that ran the work (D646).
 *
 * It used to resolve the node-DEFAULT engine's provisioning only, so a
 * benchmark that ran on `openvino:npu` recorded the onnx pool's
 * `concurrency: 4` beside an NPU number — a history row describing a pool the
 * run never touched. A `deviceKey` now resolves that device's own provisioning,
 * exactly as `resolveDeviceFactory` builds it, and the answer carries
 * `numWorkers` — the knob that actually lifts a saturated pool.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DetectionPipelineProvider } from '../provider.js'

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

describe('getEffectiveTuning — per pool (D646)', () => {
  it('without a deviceKey it describes the node-default pool (onnx before init), numWorkers included', async () => {
    const tuning = await makeProvider().getEffectiveTuning({})
    expect(tuning.runtime).toBe('onnx')
    expect(tuning.deviceKey).toBeNull()
    expect(tuning.concurrency).toBe(4)
    expect(tuning.numWorkers).toBe(1)
  })

  it('with a deviceKey it describes THAT device pool, not the node default', async () => {
    const tuning = await makeProvider().getEffectiveTuning({ deviceKey: 'openvino:npu' })
    expect(tuning.runtime).toBe('openvino')
    expect(tuning.deviceKey).toBe('openvino:npu')
    expect(tuning.concurrency).toBe(1)
    expect(tuning.batchMode).toBe('none')
    expect(tuning.numWorkers).toBe(1)
  })
})
