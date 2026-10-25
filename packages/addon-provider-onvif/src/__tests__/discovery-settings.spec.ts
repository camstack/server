/**
 * The ONVIF discovery settings must each do something.
 *
 *  - `discovery.enabled` ("Enable Auto-Discovery") was never read: discovery
 *    runs only when an operator asks for it (the Add-device wizard or the
 *    discovery modal), so the operator's request is the ONE control (D777) and
 *    the switch is gone.
 *  - `discovery.timeout` was stored under its flat dotted key but read as
 *    `raw.discovery.timeout`, so every scan used the 5000 ms default whatever
 *    the operator set.
 */
import type { AddonContext } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const discoverOnvifCameras = vi.fn(async (_timeoutMs: number) => [
  { host: '192.168.10.10', port: 80, name: 'Cam' },
])
vi.mock('../onvif-discovery.js', () => ({ discoverOnvifCameras }))

const { OnvifProviderAddon } = await import('../addon.js')

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
  withTags: () => noopLogger,
}

function contextFor(world: { store: Record<string, unknown> }): AddonContext {
  return {
    id: 'provider-onvif',
    logger: noopLogger,
    eventBus: { emit: () => undefined, subscribe: () => () => undefined, getRecent: () => [] },
    kernel: { localNodeId: 'hub' },
    settings: {
      readAddonStore: async () => structuredClone(world.store),
      readAddonStoreResult: async () => ({ kind: 'value', value: structuredClone(world.store) }),
      writeAddonStore: async (patch: Record<string, unknown>) => {
        world.store = { ...world.store, ...structuredClone(patch) }
      },
      readDeviceStore: async () => ({}),
      writeDeviceStore: async () => undefined,
    },
  } as unknown as AddonContext
}

let addon: InstanceType<typeof OnvifProviderAddon> | null = null
afterEach(async () => {
  await addon?.shutdown()
  addon = null
  discoverOnvifCameras.mockClear()
})

async function boot(store: Record<string, unknown> = {}) {
  const world = { store }
  addon = new OnvifProviderAddon()
  await addon.initialize(contextFor(world))
  return { addon, world }
}

describe('ONVIF discovery settings', () => {
  it('declares no `discovery.enabled` switch — the operator-triggered scan is the one control', async () => {
    const { addon: a } = await boot()
    const view = await a.getGlobalSettings()
    const keys = (view?.sections ?? []).flatMap((s) =>
      s.fields.map((f) => ('key' in f ? f.key : null)),
    )
    expect(keys).not.toContain('discovery.enabled')
    expect(keys).toContain('discovery.timeout')
  })

  it('a timeout the operator saved is the timeout the scan uses', async () => {
    const { addon: a } = await boot()
    await a.updateGlobalSettingsAsOperator({ 'discovery.timeout': 9_000 })

    await a.discoverDevices()

    expect(discoverOnvifCameras).toHaveBeenCalledWith(9_000)
  })

  it('no stored timeout → the 5000 ms default', async () => {
    const { addon: a } = await boot()
    await a.discoverDevices()
    expect(discoverOnvifCameras).toHaveBeenCalledWith(5_000)
  })
})
