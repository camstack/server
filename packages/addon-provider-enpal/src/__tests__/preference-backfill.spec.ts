/**
 * A System adopted before containers declared their primary child carries no
 * `primaryChildPreference`, and one adopted before the Energy system child
 * existed carries an older one. The device re-stamps the current declaration
 * when it activates and the stored one differs; an equal one is left alone,
 * and the operator's own pick (`primaryChildEntityId`) is a different column
 * nothing here writes.
 */
import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EnpalEquipmentDevice } from '../devices/enpal-equipment-device.js'
import { backfillPrimaryChildPreference } from '../devices/enpal-preference-backfill.js'
import { findEquipment, primaryChildPreferenceOf } from '../enpal-equipment.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

interface Row {
  primaryChildEntityId: string | null
  primaryChildPreference: readonly string[] | undefined
}

function rig(row: Row): {
  readonly row: Row
  readonly write: (keys: readonly string[]) => Promise<void>
} {
  return {
    row,
    write: async (keys) => {
      row.primaryChildPreference = keys
    },
  }
}

const SYSTEM = findEquipment('impianto')
const SPEC_IDS = ['battery', 'pv', 'house']
const DECLARED = primaryChildPreferenceOf(SYSTEM, SPEC_IDS)

describe('backfillPrimaryChildPreference', () => {
  it('declares the Energy system first, then PV, on a System adopted without a preference', async () => {
    const { row, write } = rig({ primaryChildEntityId: null, primaryChildPreference: undefined })
    const wrote = await backfillPrimaryChildPreference({
      deviceId: 9,
      stored: row.primaryChildPreference,
      declared: DECLARED,
      write,
      logger: quiet,
    })
    expect(wrote).toBe(true)
    expect(row.primaryChildPreference).toEqual(['energy-system', 'pv', 'battery', 'house'])
  })

  it("never touches the operator's pick", async () => {
    const { row, write } = rig({
      primaryChildEntityId: 'enpal-sys-battery',
      primaryChildPreference: undefined,
    })
    await backfillPrimaryChildPreference({
      deviceId: 9,
      stored: row.primaryChildPreference,
      declared: DECLARED,
      write,
      logger: quiet,
    })
    expect(row.primaryChildEntityId).toBe('enpal-sys-battery')
  })

  it('leaves a stored declaration equal to the current one alone', async () => {
    const { row, write } = rig({ primaryChildEntityId: null, primaryChildPreference: DECLARED })
    const wrote = await backfillPrimaryChildPreference({
      deviceId: 9,
      stored: row.primaryChildPreference,
      declared: DECLARED,
      write,
      logger: quiet,
    })
    expect(wrote).toBe(false)
    expect(row.primaryChildPreference).toEqual(DECLARED)
  })

  it('re-stamps an older declaration: the Energy system now stands for the System', async () => {
    const { row, write } = rig({
      primaryChildEntityId: null,
      primaryChildPreference: ['pv', 'battery', 'house'],
    })
    const wrote = await backfillPrimaryChildPreference({
      deviceId: 9,
      stored: row.primaryChildPreference,
      declared: DECLARED,
      write,
      logger: quiet,
    })
    expect(wrote).toBe(true)
    expect(row.primaryChildPreference?.[0]).toBe('energy-system')
  })

  it('writes nothing for a piece that declares nothing', async () => {
    const { row, write } = rig({ primaryChildEntityId: null, primaryChildPreference: undefined })
    const wrote = await backfillPrimaryChildPreference({
      deviceId: 9,
      stored: row.primaryChildPreference,
      declared: [],
      write,
      logger: quiet,
    })
    expect(wrote).toBe(false)
    expect(row.primaryChildPreference).toBeUndefined()
  })
})

describe('EnpalEquipmentDevice on activation', () => {
  function deviceRig(stored: readonly string[] | undefined): {
    readonly ctx: DeviceContext
    readonly mutate: ReturnType<typeof vi.fn>
  } {
    const mutate = vi.fn(async () => undefined)
    let runtime: IDeviceRuntimeState | null = null
    // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
    const ctx = {
      id: 9,
      stableId: 'enpal:int-1:impianto',
      parentDeviceId: null,
      deviceMeta: {
        type: DeviceType.Container,
        name: 'System',
        location: null,
        disabled: false,
        addonId: 'provider-enpal',
        metadata: {},
        ...(stored === undefined ? {} : { primaryChildPreference: stored }),
      },
      persistedConfig: { equipment: 'impianto', specIds: SPEC_IDS, integrationId: 'int-1' },
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
      api: {
        deviceManager: {
          setPrimaryChildPreference: { mutate },
          setMetadata: { mutate: vi.fn(async () => undefined) },
        },
      },
      logger: quiet,
    } as unknown as DeviceContext
    return { ctx, mutate }
  }

  it('re-stamps the declaration on a row that has none', async () => {
    const { ctx, mutate } = deviceRig(undefined)
    const device = new EnpalEquipmentDevice(ctx)
    await device.onActivate()
    expect(mutate).toHaveBeenCalledWith({ deviceId: 9, primaryChildPreference: DECLARED })
    await device.removeDevice().catch(() => undefined)
  })

  it('does not write over a stored declaration equal to the current one', async () => {
    const { ctx, mutate } = deviceRig(DECLARED)
    const device = new EnpalEquipmentDevice(ctx)
    await device.onActivate()
    expect(mutate).not.toHaveBeenCalled()
    await device.removeDevice().catch(() => undefined)
  })
})
