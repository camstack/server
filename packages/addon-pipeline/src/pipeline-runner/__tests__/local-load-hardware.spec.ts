/**
 * `getLocalLoad().hardware` — wired to the LOCAL accelerator probe.
 *
 * It used to be a hardcoded `hasGpu: false`, left behind when the hardware
 * probe moved off the runner. The admin UI renders a "GPU" badge straight off
 * this field, so on a node running OpenVINO on its Intel iGPU it read as an
 * answer ("no GPU") rather than as an absence.
 */
import { describe, expect, it, vi } from 'vitest'
import type { KernelInferenceHardware } from '@camstack/types'
import PipelineRunnerAddon from '../index.js'

function makeCtx(
  resolveHardware: (() => Promise<KernelInferenceHardware>) | null,
): Record<string, unknown> {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
  return {
    id: 'pipeline-runner',
    logger,
    kernel: {
      localNodeId: 'hub',
      ...(resolveHardware ? { inferenceEngine: { resolveHardware } } : {}),
    },
  }
}

function addonWithCtx(ctx: Record<string, unknown>): PipelineRunnerAddon {
  const addon = new PipelineRunnerAddon()
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  return addon
}

describe('PipelineRunnerAddon.getLocalLoad — hardware block', () => {
  it('reports hasGpu:true on a node whose kernel probe finds an Intel iGPU', async () => {
    const addon = addonWithCtx(makeCtx(async () => ({ gpu: { type: 'intel' }, npu: null })))
    const load = await addon.getLocalLoad()
    expect(load.hardware.hasGpu).toBe(true)
  })

  it('reports hasGpu:false on a CPU-only node', async () => {
    const addon = addonWithCtx(makeCtx(async () => ({ gpu: null, npu: null })))
    const load = await addon.getLocalLoad()
    expect(load.hardware.hasGpu).toBe(false)
  })

  it('probes ONCE across repeated polls (the probe is deterministic per host)', async () => {
    const resolveHardware = vi
      .fn<() => Promise<KernelInferenceHardware>>()
      .mockResolvedValue({ gpu: { type: 'nvidia' }, npu: null })
    const addon = addonWithCtx(makeCtx(resolveHardware))
    await addon.getLocalLoad()
    await addon.getLocalLoad()
    expect(resolveHardware).toHaveBeenCalledTimes(1)
  })

  it('survives a kernel with no inference resolver at all', async () => {
    const addon = addonWithCtx(makeCtx(null))
    await expect(addon.getLocalLoad()).resolves.toMatchObject({
      hardware: { hasGpu: false },
    })
  })

  it('a throwing probe reports no accelerator and logs it, instead of failing the poll', async () => {
    const ctx = makeCtx(async () => {
      throw new Error('resolver unavailable')
    })
    const addon = addonWithCtx(ctx)
    const load = await addon.getLocalLoad()
    expect(load.hardware.hasGpu).toBe(false)
    const logger = ctx['logger']
    if (!logger || typeof logger !== 'object' || !('warn' in logger)) {
      throw new Error('test fixture: logger missing')
    }
    expect(logger.warn).toHaveBeenCalled()
  })
})
