import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ZoneRule, IScopedLogger, DeviceProxy } from '@camstack/types'
import { ZoneRulesProvider } from '../zone-rules-provider.js'

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

const motionExclude: ZoneRule = {
  id: 'm-1',
  name: 'Ignore garden',
  zoneIds: ['z-garden'],
  mode: 'exclude',
  enabled: true,
}
const detectionInclude: ZoneRule = {
  id: 'd-1',
  zoneIds: ['z-porch'],
  mode: 'include',
  classFilter: ['person'],
  enabled: true,
}
const packageInclude: ZoneRule = {
  id: 'p-1',
  name: 'Front porch drop zone',
  zoneIds: ['z-porch'],
  mode: 'include',
  classFilter: ['package'],
  enabled: true,
}

describe('ZoneRulesProvider', () => {
  let store: ReturnType<typeof makeStore>
  let api: ReturnType<typeof makeFetchDevice>
  let provider: ZoneRulesProvider
  let onChange: ReturnType<typeof vi.fn>

  beforeEach(() => {
    store = makeStore()
    api = makeFetchDevice()
    onChange = vi.fn()
    provider = new ZoneRulesProvider({
      logger: makeLogger(),
      settings: {
        readDeviceStore: store.readDeviceStore,
        writeDeviceStore: store.writeDeviceStore,
      },
      fetchDevice: api.fetchDevice,
      onRulesChanged: onChange,
    })
  })

  it('listRules returns empty for unknown device', async () => {
    expect(await provider.listRules({ deviceId: 1, stage: 'detection' })).toEqual([])
  })

  it('setRules persists + mirrors to a unified zone-rules slice', async () => {
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    expect(await provider.listRules({ deviceId: 1, stage: 'detection' })).toEqual([
      detectionInclude,
    ])
    // Mirror is the full {motion, detection, package} slice keyed under cap name 'zone-rules'.
    expect(api.setCapSlice).toHaveBeenCalledWith({
      deviceId: 1,
      capName: 'zone-rules',
      slice: { motion: [], detection: [detectionInclude], package: [] },
    })
    expect(onChange).toHaveBeenCalledWith(1, 'detection', [detectionInclude])
  })

  it('setRules writes the package stage + mirrors it into the unified slice', async () => {
    await provider.setRules({ deviceId: 1, stage: 'package', rules: [packageInclude] })
    // Round-trips through the store — the package stage is now a first-class,
    // functional zone slice (Phase 4), not a passive forward-compat key.
    expect(await provider.listRules({ deviceId: 1, stage: 'package' })).toEqual([packageInclude])
    expect(api.setCapSlice).toHaveBeenCalledWith({
      deviceId: 1,
      capName: 'zone-rules',
      slice: { motion: [], detection: [], package: [packageInclude] },
    })
    expect(onChange).toHaveBeenCalledWith(1, 'package', [packageInclude])
  })

  it('package + motion + detection all survive in the unified slice', async () => {
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    await provider.setRules({ deviceId: 1, stage: 'motion', rules: [motionExclude] })
    await provider.setRules({ deviceId: 1, stage: 'package', rules: [packageInclude] })
    const calls = api.setCapSlice.mock.calls as unknown as ReadonlyArray<
      [{ slice: { motion: unknown; detection: unknown; package: unknown } }]
    >
    const lastSlice = calls[2]![0].slice
    expect(lastSlice.motion).toEqual([motionExclude])
    expect(lastSlice.detection).toEqual([detectionInclude])
    expect(lastSlice.package).toEqual([packageInclude])
  })

  it('writing one stage preserves the other stage in the unified slice', async () => {
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    await provider.setRules({ deviceId: 1, stage: 'motion', rules: [motionExclude] })
    expect(await provider.listRules({ deviceId: 1, stage: 'detection' })).toEqual([
      detectionInclude,
    ])
    expect(await provider.listRules({ deviceId: 1, stage: 'motion' })).toEqual([motionExclude])
    // Both mirror writes use the same unified cap name.
    const calls = api.setCapSlice.mock.calls as unknown as ReadonlyArray<
      [{ capName: string; slice: { motion: unknown; detection: unknown; package: unknown } }]
    >
    const capNames = calls.map((c) => c[0].capName)
    expect(capNames).toEqual(['zone-rules', 'zone-rules'])
    // The second mirror carries every stage in the slice.
    const lastSlice = calls[1]![0].slice
    expect(lastSlice.motion).toEqual([motionExclude])
    expect(lastSlice.detection).toEqual([detectionInclude])
    expect(lastSlice.package).toEqual([])
  })

  it('setRules rejects an invalid rule payload', async () => {
    const broken = { id: 'bad', zoneIds: [], mode: 'wrong' } as unknown as ZoneRule
    await expect(
      provider.setRules({ deviceId: 1, stage: 'motion', rules: [broken] }),
    ).rejects.toThrow(/invalid rule payload/)
    // Nothing persisted on rejection.
    expect(store.data.get(1)).toBeUndefined()
  })

  it('forgetDevice drops cache (next read hits store)', async () => {
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    provider.forgetDevice(1)
    const list = await provider.listRules({ deviceId: 1, stage: 'detection' })
    expect(list).toEqual([detectionInclude])
  })

  it('replace semantics — setRules with empty array clears the stage', async () => {
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [detectionInclude] })
    await provider.setRules({ deviceId: 1, stage: 'detection', rules: [] })
    expect(await provider.listRules({ deviceId: 1, stage: 'detection' })).toEqual([])
  })
})
