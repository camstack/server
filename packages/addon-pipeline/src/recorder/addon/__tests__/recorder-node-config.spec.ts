/**
 * P3b settings-API migration: the recorder's `recordingNodeId` /
 * `recordingHubHostname` cluster settings are plain SHARED schema fields
 * resolved through `BaseAddon.resolveConfig()` (`this.config.*`) instead of a
 * raw `readAddonStore()` at boot. Behavior-preserving: same store keys, same
 * `'hub'` default, same empty-string handling, same inert-node gate.
 *
 * Every spec here drives the INERT branch of `onInitialize` (designated node
 * ≠ own node) so the boot stays lightweight — no storage/broker wiring runs.
 */
import { describe, it, expect } from 'vitest'
import type { AddonContext, IEventBus } from '@camstack/types'
import RecorderV2Addon from '../index.js'

function makeCtx(store: Record<string, unknown>, localNodeId: string): AddonContext {
  const eventBus: IEventBus = {
    emit: () => {
      /* lifecycle events are best-effort in tests */
    },
    subscribe: () => () => {
      /* no-op */
    },
    getRecent: () => [],
  }

  const ctx: AddonContext = {
    id: 'recorder',
    addDisposer: () => () => {
      /* no-op */
    },
    logger: {
      debug: () => {
        /* silent */
      },
      info: () => {
        /* silent */
      },
      warn: () => {
        /* silent */
      },
      error: () => {
        /* silent */
      },
      child: () => ctx.logger,
      withTags: () => ctx.logger,
    } as AddonContext['logger'],
    eventBus,
    dataDir: '/tmp/recorder-test',
    nodeDataDir: '/tmp',
    addonConfig: {},
    api: {} as unknown as AddonContext['api'],
    settings: {
      readAddonStore: async () => ({ ...store }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        Object.assign(store, patch)
      },
      readDeviceStoreBatch: async (ids: readonly number[]) => new Map(ids.map((id) => [id, {}])),
      listDeviceStoreIds: async () => [],
      readDeviceStore: async (_deviceId: number) => ({}),
      writeDeviceStore: async (_deviceId: number, _patch: Record<string, unknown>) => {
        /* no-op */
      },
      clearDeviceStore: async (_deviceId: number) => {
        /* no-op */
      },
      readDeviceRuntimeState: async (_deviceId: number) => ({}),
      writeDeviceRuntimeState: async (_deviceId: number, _data: Record<string, unknown>) => {
        /* no-op */
      },
      clearDeviceRuntimeState: async (_deviceId: number) => {
        /* no-op */
      },
      getSection: async (_section: string) => ({}),
      setSection: async (_section: string, _patch: Record<string, unknown>) => {
        /* no-op */
      },
    } satisfies AddonContext['settings'],
    kernel: {
      localNodeId,
      capabilityRegistry: null,
    } as unknown as AddonContext['kernel'],
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {
        /* no-op */
      },
      installPythonRequirements: async () => {
        /* no-op */
      },
      getDepsDir: () => '/tmp/recorder-test/deps',
    },
    getNativeProvider: (): never => {
      throw new Error('not available in fake ctx')
    },
    fetchDevice: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    useCapability: (): never => {
      throw new Error('not available in fake ctx')
    },
    acquireCapability: async (): Promise<never> => {
      throw new Error('not available in fake ctx')
    },
    onCapabilityStateChange: () => () => {
      /* no-op */
    },
  }
  return ctx
}

/** Providers array off an initialize() result (null when the shape is unexpected). */
function providersOf(result: unknown): readonly unknown[] | null {
  if (result && typeof result === 'object' && 'providers' in result) {
    const providers = (result as { providers?: readonly unknown[] }).providers
    return providers ?? null
  }
  return null
}

describe('recorder — recordingNodeId resolves via config (shared key, not perNode)', () => {
  it('defaults to hub / empty hostname before any persisted value', () => {
    const addon = new RecorderV2Addon()
    expect(addon.config.recordingNodeId).toBe('hub')
    expect(addon.config.recordingHubHostname).toBe('')
  })

  it('hydrates the persisted shared keys and stays INERT when another node is designated', async () => {
    const addon = new RecorderV2Addon()
    const ctx = makeCtx({ recordingNodeId: 'agent-x', recordingHubHostname: 'hub.lan' }, 'hub')
    const result = await addon.initialize(ctx)
    expect(addon.config.recordingNodeId).toBe('agent-x')
    expect(addon.config.recordingHubHostname).toBe('hub.lan')
    expect(providersOf(result)).toEqual([])
    await addon.shutdown()
  })

  it('with no persisted value a non-hub node is inert (default designated node = hub)', async () => {
    const addon = new RecorderV2Addon()
    const result = await addon.initialize(makeCtx({}, 'agent-y'))
    expect(addon.config.recordingNodeId).toBe('hub')
    expect(providersOf(result)).toEqual([])
    await addon.shutdown()
  })

  it('treats an EMPTY persisted recordingNodeId as the hub default (legacy semantics)', async () => {
    const addon = new RecorderV2Addon()
    const result = await addon.initialize(makeCtx({ recordingNodeId: '' }, 'agent-y'))
    // '' hydrates into config verbatim, but the gate falls back to 'hub'.
    expect(providersOf(result)).toEqual([])
    await addon.shutdown()
  })
})
