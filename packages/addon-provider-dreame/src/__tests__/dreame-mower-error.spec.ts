import { MowerChargingStatus, MowerFault, mowerFaultSeverity } from '@apocaliss92/nodedreame'
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DreameMowerDevice } from '../devices/dreame-mower-device.js'
import { mowerErrorReading } from '../dreame-mower-decode.js'

describe('mowerErrorReading (the `error` cap)', () => {
  it('does not activate for an info code — status, not a fault', () => {
    expect(mowerFaultSeverity(MowerFault.TaskStart)).toBe('info')
    expect(mowerFaultSeverity(MowerFault.NoDeviceCode)).toBe('info')
    expect(mowerErrorReading({ faultRaw: MowerFault.TaskStart, charging: null }, 10)).toMatchObject(
      { active: false, code: null, label: null },
    )
    expect(
      mowerErrorReading({ faultRaw: MowerFault.NoDeviceCode, charging: null }, 10),
    ).toMatchObject({ active: false, label: null })
  })

  it('activates a warning at warning severity, with the enum name split into words', () => {
    expect(mowerFaultSeverity(MowerFault.BatteryTempLow)).toBe('warning')
    expect(
      mowerErrorReading({ faultRaw: MowerFault.BatteryTempLow, charging: null }, 10),
    ).toMatchObject({
      active: true,
      code: String(MowerFault.BatteryTempLow),
      label: 'Battery Temp Low',
      severity: 'warning',
      lastFetchedAt: 10,
    })
  })

  it('activates an error at error severity', () => {
    expect(mowerFaultSeverity(MowerFault.BatteryOverheat)).toBe('error')
    expect(
      mowerErrorReading({ faultRaw: MowerFault.BatteryOverheat, charging: null }, 10),
    ).toMatchObject({
      active: true,
      code: String(MowerFault.BatteryOverheat),
      label: 'Battery Overheat',
      severity: 'error',
      lastFetchedAt: 10,
    })
  })

  it('is UNKNOWN, not clear, when the mower reported no device code', () => {
    expect(mowerErrorReading({ faultRaw: null, charging: null }, 10).active).toBeNull()
  })

  it('raises a low-temperature charging pause as a warning, and only as the principal when no device fault is active', () => {
    const pause = MowerChargingStatus.ChargingPausedLowTemperature
    expect(
      mowerErrorReading({ faultRaw: MowerFault.NoDeviceCode, charging: pause }, 10),
    ).toMatchObject({
      active: true,
      code: 'charging-16',
      label: 'Charging paused: battery too cold',
      severity: 'warning',
      faults: [
        {
          code: 'charging-16',
          label: 'Charging paused: battery too cold',
          severity: 'warning',
        },
      ],
    })

    const withFault = mowerErrorReading(
      { faultRaw: MowerFault.BatteryOverheat, charging: pause },
      10,
    )
    expect(withFault).toMatchObject({
      active: true,
      code: String(MowerFault.BatteryOverheat),
      label: 'Battery Overheat',
      severity: 'error',
    })
    expect(withFault.faults?.map((fault) => fault.code)).toEqual([
      String(MowerFault.BatteryOverheat),
      'charging-16',
    ])
  })
})

const DID = 'did-mower'
const BROKER = 'int_mower'

function mowerCtx(registered: string[]): DeviceContext {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
    withTags: vi.fn(),
  }
  let runtimeState: IDeviceRuntimeState | null = null
  const context = {
    id: 503,
    stableId: `dreame:${DID}:mower`,
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.LawnMower,
      name: 'Mower',
      location: null,
      disabled: false,
      addonId: 'provider-dreame',
      metadata: {},
    },
    persistedConfig: {
      dreameDeviceId: DID,
      brokerId: BROKER,
      model: 'dreame.mower.p2255',
      system: 'dreame',
    },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeState = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      registered.push(cap.name)
      if (cap.runtimeState === undefined || runtimeState === null) return
      runtimeState.installCapSchema(
        cap.name,
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- schema handed through by the test double
        cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
      )
    },
    api: {},
    logger,
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- DeviceContext test double
  return context as unknown as DeviceContext
}

describe('DreameMowerDevice error cap', () => {
  const devices: DreameMowerDevice[] = []

  afterEach(async () => {
    await Promise.all(devices.splice(0).map((device) => device.removeDevice()))
  })

  it('registers the error capability', async () => {
    const registered: string[] = []
    const device = new DreameMowerDevice(mowerCtx(registered))
    devices.push(device)
    await device.onActivate()
    expect(registered).toContain('error')
  })
})
