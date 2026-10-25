import { describe, expect, it } from 'vitest'
import type { IKernelInferenceEngine, KernelInferenceHardware } from '../addon.js'

describe('IKernelInferenceEngine', () => {
  it('resolveHardware resolves KernelInferenceHardware', async () => {
    const hw: KernelInferenceHardware = { gpu: { type: 'intel' }, npu: null }
    const resolver: IKernelInferenceEngine = { resolveHardware: async () => hw }
    await expect(resolver.resolveHardware()).resolves.toEqual({ gpu: { type: 'intel' }, npu: null })
  })

  it('allows a null gpu and an apple-ane npu', () => {
    const hw: KernelInferenceHardware = { gpu: null, npu: { type: 'apple-ane' } }
    expect(hw.npu?.type).toBe('apple-ane')
  })
})
