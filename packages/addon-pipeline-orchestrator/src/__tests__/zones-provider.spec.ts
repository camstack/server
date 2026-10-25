import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Zone, IScopedLogger, DeviceProxy } from '@camstack/types'
import { ZonesProvider } from '../zones-provider.js'

function makeLogger(): IScopedLogger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
    withTags: () => log,
  } as unknown as IScopedLogger
  return log
}

function makeStore() {
  const data = new Map<number, Record<string, unknown>>()
  return {
    data,
    readDeviceStore: vi.fn(async (id: number) => data.get(id) ?? {}),
    writeDeviceStore: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      data.set(id, { ...data.get(id), ...patch })
    }),
  }
}

/**
 * DeviceProxy stub. `setCapSlice` records `(deviceId, capName, slice)`
 * — same payload as the legacy `api.deviceState.setCapSlice.mutate` call
 * pre-migration, so test assertions stay readable. The proxy auto-injects
 * deviceId from the closure (matches the production codegen).
 */
function makeFetchDevice() {
  const setCapSlice = vi.fn(
    async (_args: { deviceId: number; capName: string; slice: Record<string, unknown> }) =>
      undefined,
  )
  const fetchDevice = async (deviceId: number): Promise<DeviceProxy> =>
    ({
      deviceState: {
        setCapSlice: (args: { capName: string; slice: Record<string, unknown> }) =>
          setCapSlice({ deviceId, ...args }),
      },
    }) as unknown as DeviceProxy
  return { fetchDevice, setCapSlice }
}

const driveway: Zone = {
  id: 'z-drv',
  name: 'Driveway',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#3b82f6',
}

const porch: Zone = {
  ...driveway,
  id: 'z-porch',
  name: 'Porch',
}

describe('ZonesProvider', () => {
  let store: ReturnType<typeof makeStore>
  let api: ReturnType<typeof makeFetchDevice>
  let provider: ZonesProvider
  let onZonesChanged: ReturnType<typeof vi.fn>

  beforeEach(() => {
    store = makeStore()
    api = makeFetchDevice()
    onZonesChanged = vi.fn()
    provider = new ZonesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: api.fetchDevice,
      onZonesChanged,
    })
  })

  it('listZones returns empty for unknown device', async () => {
    expect(await provider.listZones({ deviceId: 1 })).toEqual([])
  })

  it('addZone persists + mirrors to dev.state + fires onZonesChanged', async () => {
    await provider.addZone({ deviceId: 1, zone: driveway })
    expect(await provider.listZones({ deviceId: 1 })).toEqual([driveway])
    expect(store.data.get(1)?.zones).toEqual([driveway])
    expect(api.setCapSlice).toHaveBeenCalledWith({
      deviceId: 1,
      capName: 'zones',
      slice: { zones: [driveway] },
    })
    expect(onZonesChanged).toHaveBeenCalledWith(1, [driveway])
  })

  it('addZone rejects id collision', async () => {
    await provider.addZone({ deviceId: 1, zone: driveway })
    await expect(provider.addZone({ deviceId: 1, zone: driveway })).rejects.toThrow(
      /already exists/,
    )
  })

  it('updateZone replaces an existing entry', async () => {
    await provider.addZone({ deviceId: 1, zone: driveway })
    const renamed: Zone = { ...driveway, name: 'Front Path' }
    await provider.updateZone({ deviceId: 1, zone: renamed })
    const list = await provider.listZones({ deviceId: 1 })
    expect(list).toEqual([renamed])
  })

  it('updateZone rejects unknown id', async () => {
    await expect(provider.updateZone({ deviceId: 1, zone: driveway })).rejects.toThrow(/not found/)
  })

  it('removeZone is idempotent for missing ids', async () => {
    await expect(
      provider.removeZone({ deviceId: 1, zoneId: 'never-existed' }),
    ).resolves.toBeUndefined()
  })

  it('removeZone drops the entry and re-persists', async () => {
    await provider.addZone({ deviceId: 1, zone: driveway })
    await provider.addZone({ deviceId: 1, zone: porch })
    await provider.removeZone({ deviceId: 1, zoneId: driveway.id })
    expect(await provider.listZones({ deviceId: 1 })).toEqual([porch])
  })

  it('forgetDevice drops cache (next read hits store)', async () => {
    await provider.addZone({ deviceId: 1, zone: driveway })
    provider.forgetDevice(1)
    const list = await provider.listZones({ deviceId: 1 })
    expect(list).toEqual([driveway])
    expect(store.readDeviceStore).toHaveBeenCalledTimes(2)
  })
})
