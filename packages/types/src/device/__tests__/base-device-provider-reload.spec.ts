import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import { BaseDeviceProvider } from '../base-device-provider.js'
import type { DeviceConstructor } from '../device-context.js'
import type { CreateDeviceSpec } from '../device-management.js'
import type { IDevice } from '../device.js'
import { DeviceType } from '../device-type.js'

/**
 * `reloadDevice` — the per-device flush `deviceManager.migrateDevice` calls
 * instead of restarting the whole provider (28 devices down for one migrated
 * camera, measured 2026-09-04).
 *
 * The claims: exactly ONE live instance is decommissioned (matched by
 * `stableId` — the numeric id is the thing that changed), the fresh instance
 * is created from the persisted row under whatever id the row carries NOW,
 * first-class children of the reloaded parent come back (the boot restore's
 * pass 2), and an accessory child is refused rather than half-reloaded.
 */

interface LiveDevice {
  readonly id: number
  readonly stableId: string
}

interface PersistedRow {
  readonly id: number
  readonly stableId: string
  readonly type: string
  readonly name: string
  readonly parentDeviceId: number | null
}

class FakeDevice {
  constructor(readonly stableId: string) {}
}

interface Harness {
  readonly provider: BaseDeviceProvider
  readonly decommissioned: number[]
  readonly created: Array<{ stableId: string; parentDeviceId: number | null }>
}

function harness(opts: {
  live?: readonly LiveDevice[]
  /** stableId → post-swap id the hub row now carries. */
  ids: Readonly<Record<string, number>>
  rows: readonly PersistedRow[]
}): Harness {
  const decommissioned: number[] = []
  const created: Array<{ stableId: string; parentDeviceId: number | null }> = []

  const devices = {
    getAll: async (): Promise<readonly IDevice[]> =>
      (opts.live ?? []).map((d) => d as unknown as IDevice),
    decommission: async (deviceId: number): Promise<void> => {
      decommissioned.push(deviceId)
    },
    create: async (
      stableId: string,
      _Class: unknown,
      _config: Record<string, unknown>,
      parentDeviceId: number | null = null,
    ): Promise<IDevice> => {
      created.push({ stableId, parentDeviceId })
      return new FakeDevice(stableId) as unknown as IDevice
    },
  }

  const api = {
    deviceManager: {
      allocateDeviceId: {
        mutate: async (input: { addonId: string; stableId: string }) => {
          const id = opts.ids[input.stableId]
          if (id === undefined) throw new Error(`no id for ${input.stableId}`)
          return { id }
        },
      },
      loadMeta: {
        query: async (input: { deviceId: number }) => {
          const row = opts.rows.find((r) => r.id === input.deviceId)
          if (!row) return null
          return {
            id: row.id,
            stableId: row.stableId,
            addonId: 'provider-test',
            type: row.type,
            name: row.name,
            location: null,
            disabled: false,
            parentDeviceId: row.parentDeviceId,
            metadata: null,
          }
        },
      },
      listPersistedByAddon: {
        query: async (_input: { addonId: string }) => opts.rows,
      },
    },
  }

  class TestProvider extends BaseDeviceProvider {
    protected readonly addonId = 'provider-test'
    protected readonly providerName = 'test'
    protected readonly deviceClasses = {
      [DeviceType.Camera]: FakeDevice as unknown as DeviceConstructor<IDevice>,
    }
    protected async onGetCreationSchema(): Promise<ConfigUISchema | null> {
      return null
    }
    protected async onCreateDevice(): Promise<CreateDeviceSpec> {
      throw new Error('not used')
    }
  }

  const provider = new TestProvider({})
  Reflect.set(provider, '_ctx', {
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    kernel: { devices },
    api,
  })
  return { provider, decommissioned, created }
}

const cameraRow = (id: number, stableId: string, parentDeviceId: number | null = null) => ({
  id,
  stableId,
  type: DeviceType.Camera,
  name: stableId,
  parentDeviceId,
})

describe('BaseDeviceProvider.reloadDevice', () => {
  it('decommissions ONLY the matching live instance and re-creates under the row id', async () => {
    const h = harness({
      // Live under the PRE-swap id 618; a bystander the reload must not touch.
      live: [
        { id: 108, stableId: 'cam-a' },
        { id: 619, stableId: 'cam-bystander' },
      ],
      ids: { 'cam-a': 4362 },
      rows: [cameraRow(4362, 'cam-a')],
    })

    const res = await h.provider.reloadDevice({ stableId: 'cam-a' })

    expect(h.decommissioned).toEqual([108])
    expect(h.created).toEqual([{ stableId: 'cam-a', parentDeviceId: null }])
    expect(res).toEqual({ deviceId: 4362 })
  })

  it('a stableId with no live instance still re-creates — reload is idempotent teardown-side', async () => {
    const h = harness({
      live: [],
      ids: { 'cam-a': 4362 },
      rows: [cameraRow(4362, 'cam-a')],
    })

    const res = await h.provider.reloadDevice({ stableId: 'cam-a' })

    expect(h.decommissioned).toEqual([])
    expect(h.created).toEqual([{ stableId: 'cam-a', parentDeviceId: null }])
    expect(res).toEqual({ deviceId: 4362 })
  })

  it('re-creates first-class children of the reloaded parent — and nobody else', async () => {
    const h = harness({
      live: [{ id: 108, stableId: 'cam-nvr' }],
      ids: { 'cam-nvr': 4362 },
      rows: [
        cameraRow(4362, 'cam-nvr'),
        // Hub-adopted child of the reloaded parent — comes back (pass 2).
        cameraRow(700, 'cam-child', 4362),
        // Child of a DIFFERENT parent — untouched.
        cameraRow(800, 'cam-other-child', 999),
      ],
    })

    await h.provider.reloadDevice({ stableId: 'cam-nvr' })

    expect(h.created).toEqual([
      { stableId: 'cam-nvr', parentDeviceId: null },
      { stableId: 'cam-child', parentDeviceId: 4362 },
    ])
  })

  it('refuses an accessory child (no device class) instead of half-reloading it', async () => {
    const h = harness({
      live: [],
      ids: { siren: 900 },
      rows: [
        { id: 900, stableId: 'siren', type: DeviceType.Siren, name: 'siren', parentDeviceId: 4362 },
      ],
    })

    await expect(h.provider.reloadDevice({ stableId: 'siren' })).rejects.toThrow(
      /reload its parent/,
    )
    expect(h.created).toEqual([])
  })
})
