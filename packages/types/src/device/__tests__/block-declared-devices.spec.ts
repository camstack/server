import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AddonContext } from '../../interfaces/addon.js'
import { DeviceType } from '../device-type.js'
import type { DeviceConstructor } from '../device-context.js'
import type { IDevice } from '../device.js'
import { exposeBlockDevices, reconcileBlockDevices } from '../block-declared-devices.js'

class FakeSensor {
  readonly id = 42
  readonly stableId = 'wan-alert'
}

const SensorClass = FakeSensor as unknown as DeviceConstructor<IDevice>

function makeCtx(overrides: {
  integration?: { id: string; name: string } | null
  create?: ReturnType<typeof vi.fn>
  listOwn?: ReturnType<typeof vi.fn>
  expose?: ReturnType<typeof vi.fn>
}): AddonContext {
  const create = overrides.create ?? vi.fn(async () => new FakeSensor())
  const listOwn = overrides.listOwn ?? vi.fn(async () => [])
  const expose = overrides.expose ?? vi.fn(async () => undefined)
  const getAll = vi.fn(async () => [])
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function child(this: unknown) {
      return logger
    }),
  }
  return {
    id: 'core-block-test',
    logger,
    kernel: {
      devices: { create, getAll, remove: vi.fn(async () => undefined) },
      localNodeId: 'hub',
    },
    api: {
      integrations: {
        getByAddonId: {
          query: vi.fn(async () =>
            overrides.integration === undefined
              ? { id: 'int_blocks', name: 'Blocks' }
              : overrides.integration,
          ),
        },
      },
      deviceManager: {
        listAll: { query: listOwn },
      },
      deviceExport: {
        exposeDevice: { mutate: expose },
      },
    },
  } as unknown as AddonContext
}

describe('reconcileBlockDevices', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when the Blocks integration is not ready', async () => {
    const ctx = makeCtx({ integration: null })
    const result = await reconcileBlockDevices(ctx, {
      devices: [
        {
          stableId: 'wan-alert',
          name: 'WAN alert',
          type: DeviceType.Sensor,
          DeviceClass: SensorClass,
        },
      ],
    })
    expect(result.owned).toBe(false)
    expect(result.devices).toEqual([])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })

  it('creates a declared device under the shared integration', async () => {
    const create = vi.fn(async (stableId: string) => {
      const d = new FakeSensor()
      ;(d as { stableId: string }).stableId = stableId
      return d
    })
    const listOwn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: 42, stableId: 'wan-alert', integrationId: 'int_blocks' }])
    const ctx = makeCtx({ create, listOwn })
    const result = await reconcileBlockDevices(ctx, {
      devices: [
        {
          stableId: 'wan-alert',
          name: 'WAN alert',
          type: DeviceType.Sensor,
          DeviceClass: SensorClass,
        },
      ],
    })
    expect(result.owned).toBe(true)
    expect(result.integrationId).toBe('int_blocks')
    expect(create).toHaveBeenCalled()
  })
})

describe('exposeBlockDevices', () => {
  it('calls exposeDevice for each device × exporter pair', async () => {
    const expose = vi.fn(async () => undefined)
    const ctx = makeCtx({ expose })
    await exposeBlockDevices(ctx, {
      deviceIds: [42, 43],
      exporterAddonIds: ['provider-homeassistant', 'export-hap'],
    })
    expect(expose).toHaveBeenCalledTimes(4)
    expect(expose).toHaveBeenCalledWith({
      addonId: 'provider-homeassistant',
      deviceId: '42',
      nodeId: 'hub',
    })
    expect(expose).toHaveBeenCalledWith({
      addonId: 'export-hap',
      deviceId: '43',
      nodeId: 'hub',
    })
  })

  it('continues when one expose refuses', async () => {
    const expose = vi
      .fn()
      .mockRejectedValueOnce(new Error('unsupported kind'))
      .mockResolvedValue(undefined)
    const ctx = makeCtx({ expose })
    await exposeBlockDevices(ctx, {
      deviceIds: [1, 2],
      exporterAddonIds: ['provider-homeassistant'],
    })
    expect(expose).toHaveBeenCalledTimes(2)
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})
