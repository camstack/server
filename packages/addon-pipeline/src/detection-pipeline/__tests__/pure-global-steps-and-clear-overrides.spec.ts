/**
 * Pure `nodeDefaultSteps`, and no per-camera detector store — provider unit coverage.
 *
 * The legacy `resetToDefault` (and the persisted `pipelineSteps` /
 * `pipelineEngine` executor seed it reset) were REMOVED: nothing in the live
 * per-camera dispatch path ever read the seed, so resetting it was a lie.
 * What replaced it:
 *   - `nodeDefaultSteps` is PURE — it computes the node's hardware-aware
 *     default tree on demand (`resolveDefaultDetectionModel` for the
 *     object-detection slot), never reads or writes the store, and IGNORES
 *     any stale persisted seed from an old install;
 *   - the per-camera detector store is gone (D927): a model and its
 *     thresholds belong to the accelerator that runs it.
 */

import type { IScopedLogger, KernelInferenceHardware } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'
import { DetectionPipelineProvider } from '../provider.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeLogger(): IScopedLogger {
  const noop = (): void => undefined
  const logger: IScopedLogger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

class InMemoryStore {
  data: Record<string, unknown> = {}
  /** Per-device blobs keyed by deviceId. */
  deviceData = new Map<number, Record<string, unknown>>()

  async readAddonStore(): Promise<Record<string, unknown>> {
    return { ...this.data }
  }
  async writeAddonStore(patch: Record<string, unknown>): Promise<void> {
    // Mirror the real store's patch-MERGE semantics (null preserved as null).
    this.data = { ...this.data, ...patch }
  }
  async readDeviceStore(deviceId: number): Promise<Record<string, unknown>> {
    return { ...this.deviceData.get(deviceId) }
  }
  async writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void> {
    this.deviceData.set(deviceId, { ...this.deviceData.get(deviceId), ...patch })
  }
  async clearDeviceStore(deviceId: number): Promise<void> {
    this.deviceData.delete(deviceId)
  }
}

interface CtxOptions {
  readonly deviceIds: readonly number[]
  readonly resolveHardware?: () => Promise<KernelInferenceHardware>
}

/** Fake AddonContext: local kernel resolver + a device-manager listAll stub. */
function makeCtx(options: CtxOptions): unknown {
  return {
    kernel: {
      localNodeId: 'hub',
      readinessRegistry: undefined,
      inferenceEngine: options.resolveHardware
        ? { resolveHardware: options.resolveHardware }
        : undefined,
    },
    addDisposer: (_fn: () => void) => () => undefined,
    api: {
      deviceManager: {
        listAll: {
          query: vi.fn(async () => options.deviceIds.map((id) => ({ id }))),
        },
      },
      // Custom-model-registry lookups degrade gracefully to the static catalog.
      addons: { listCapabilityProviders: { query: async () => [] } },
    },
  }
}

async function makeReadyProvider(
  store: InMemoryStore,
  deviceIds: readonly number[],
): Promise<DetectionPipelineProvider> {
  const provider = new DetectionPipelineProvider(store, '/tmp/models-reset-test', makeLogger())
  await provider.init()
  await provider.setApi(makeCtx({ deviceIds }))
  return provider
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DetectionPipelineProvider node-default tree (pure, private — D927)', () => {
  it('ignores a stale persisted seed and returns the hardware-aware default tree', async () => {
    const store = new InMemoryStore()
    // A legacy seed from an old install — must be IGNORED, never resolved.
    store.data['pipelineSteps'] = JSON.stringify([
      {
        addonId: 'object-detection',
        addonName: 'Object Detection',
        slot: 'detector',
        inputClasses: [],
        outputClasses: ['person'],
        enabled: true,
        modelId: 'some-stale-custom-model',
        children: [],
      },
    ])

    const provider = await makeReadyProvider(store, [])
    const engine = await provider.getSelectedEngine()
    const expectedModelId = resolveDefaultDetectionModel(
      engine.backend,
      engine.device ?? null,
      engine.format,
    )

    const steps = await provider['nodeDefaultSteps']()
    const detector = steps?.find((s) => s.slot === 'detector')
    expect(detector).toBeDefined()
    expect(detector?.modelId).not.toBe('some-stale-custom-model')
    expect(detector?.modelId).toBe(expectedModelId)
  })

  it('never writes the store (nothing persisted, stale seed left untouched)', async () => {
    const store = new InMemoryStore()
    const staleSeed = JSON.stringify([{ bogus: true }])
    store.data['pipelineSteps'] = staleSeed

    const provider = await makeReadyProvider(store, [])
    const before = { ...store.data }
    await provider['nodeDefaultSteps']()

    // No new keys, no rewritten seed — the computation is pure.
    expect(store.data).toStrictEqual(before)
    expect(store.data['pipelineSteps']).toBe(staleSeed)
  })

  it('is deterministic — two calls yield the identical tree', async () => {
    const store = new InMemoryStore()
    const provider = await makeReadyProvider(store, [])
    const first = await provider['nodeDefaultSteps']()
    const second = await provider['nodeDefaultSteps']()
    expect(second).toStrictEqual(first)
    expect(first?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('DetectionPipelineProvider — no per-camera detector store (D927)', () => {
  it('exposes no clear/read surface over a per-camera detector store, and never reads one', async () => {
    const store = new InMemoryStore()
    store.deviceData.set(1, { minConfidence: 0.9 })
    const read = vi.spyOn(store, 'readDeviceStore')
    const provider = await makeReadyProvider(store, [1])

    expect('clearDeviceOverrides' in provider).toBe(false)
    expect('clearModelBoundDeviceOverrides' in provider).toBe(false)
    expect('deviceOverrides' in provider).toBe(false)
    expect(read).not.toHaveBeenCalled()
  })
})
