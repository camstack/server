/**
 * A Gree air conditioner publishes no slice until the unit answered a status read
 * (planning#561): a placeholder slice published at activation later diffed against the
 * real one as phantom device transitions after every boot.
 */
import type { AcDevice } from '@apocaliss92/nodegree'
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GreeAcDevice } from '../devices/gree-ac-device.js'
import { greeConnections } from '../gree-gateway.js'

interface Harness {
  readonly ctx: DeviceContext
  readonly runtime: () => IDeviceRuntimeState | null
}

function stubContext(): Harness {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the
  // constructor reads (same boundary as the climate-role spec).
  const ctx = {
    id: 21,
    stableId: 'gree-aabbcc-ac',
    parentDeviceId: 20,
    deviceMeta: {
      type: DeviceType.Climate,
      name: 'Living room AC',
      location: null,
      disabled: false,
      addonId: 'gree',
      metadata: {},
    },
    persistedConfig: { greeMac: 'aabbcc', connectionKey: 'k1', system: 'gree' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: vi.fn((cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    }),
    api: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as DeviceContext
  return { ctx, runtime: () => runtime }
}

/** The unit handle: its getters default to 0 until a status read fills `state`. */
function fakeAc(state: Record<string, number>): AcDevice {
  return {
    state,
    power: false,
    mode: 0,
    fanSpeed: 0,
    swingVertical: 0,
    swingHorizontal: 0,
    targetTemperature: 0,
    currentTemperature: undefined,
    turbo: false,
    quiet: false,
    sleep: false,
    powerSave: false,
    steadyHeat: false,
    capabilities: { horizontalSwing: false },
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as AcDevice
}

describe('Gree AC publishes only what the unit reported', () => {
  afterEach(() => vi.restoreAllMocks())

  /** The cap slices the device holds after activation (none = nothing published). */
  async function activate(ac: AcDevice): Promise<Record<string, unknown>[]> {
    vi.spyOn(greeConnections, 'getDevice').mockReturnValue(ac)
    const h = stubContext()
    await new GreeAcDevice(h.ctx).onActivate()
    const rs = h.runtime()
    return ['climate-control', 'fan-control'].flatMap((cap) => {
      const slice = rs?.getCapState<Record<string, unknown>>(cap)
      return slice === undefined ? [] : [slice]
    })
  }

  it('publishes no placeholder slice before the first status read', async () => {
    expect(await activate(fakeAc({}))).toEqual([])
  })

  it('publishes the real slices once the unit has answered', async () => {
    const slices = await activate(fakeAc({ Pow: 1, SetTem: 20 }))
    expect(slices).toHaveLength(2)
  })

  describe('the unit fault on the error cap', () => {
    afterEach(() => greeConnections.clear())

    async function errorSlice(errorCode: number | null): Promise<unknown> {
      vi.spyOn(greeConnections, 'getDevice').mockReturnValue(fakeAc({ Pow: 1, SetTem: 20 }))
      const h = stubContext()
      await new GreeAcDevice(h.ctx).onActivate()
      greeConnections.setExtras('k1', 'aabbcc', { outdoorTemp: 6, defrost: false, errorCode })
      await Promise.resolve()
      return h.runtime()?.getCapState('error')
    }

    it('a non-zero AllErr is an active fault on the AC itself', async () => {
      expect(await errorSlice(12)).toMatchObject({ active: true, code: 'E12', severity: 'error' })
    })

    it('AllErr 0 is a clean reading', async () => {
      expect(await errorSlice(0)).toMatchObject({ active: false, code: null })
    })

    it('an unanswered column stays unknown', async () => {
      expect(await errorSlice(null)).toMatchObject({ active: null })
    })
  })
})
