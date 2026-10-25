/**
 * Unit tests for HmContainerDevice.getAccessoryChildren() + online derivation.
 *
 * Focus (per the Container task brief): child-spec SHAPE (which children a
 * device yields and their meta/config), NOT the facade round-trips (those are
 * covered by homematic-device.spec.ts). We build fixture HmDevices + custom
 * entities, register a facade stub, construct the Container, and assert the
 * spec list.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  DeviceType,
  DeviceRole,
  DeviceFeature,
  type DeviceContext,
  type IDeviceRuntimeState,
} from '@camstack/types'
import type { Homematic, HmCustomEntity, HmDevice } from 'nodehomematic'
import { HmContainerDevice } from '../devices/hm-container-device.js'
import { homematicFacades } from '../homematic-gateway.js'

// ── Minimal DeviceContext stub (mirrors homematic-device.spec.ts) ──────────

function makeLogger() {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeCtx(persistedConfig: Record<string, unknown>): DeviceContext {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: 7,
    stableId: 'hm:test:7',
    parentDeviceId: null,
    deviceMeta: {
      id: 7,
      stableId: 'hm:test:7',
      addonId: 'provider-homematic',
      type: DeviceType.Container,
      name: 'Test Container',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig,
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      if (cap.runtimeState && runtimeStateRef) {
        runtimeStateRef.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger: makeLogger(),
    api: {},
  } as unknown as DeviceContext
  return ctx
}

// ── Facade stub ─────────────────────────────────────────────────────────────

interface FacadeStub {
  devices: () => HmDevice[]
  customEntities: () => HmCustomEntity[]
  on: () => () => void
}

function makeFacade(hmDevices: HmDevice[], customEntities: HmCustomEntity[]): Homematic {
  const stub: FacadeStub = {
    devices: () => hmDevices,
    customEntities: () => customEntities,
    on: () => () => {},
  }
  // Widen through unknown at this one boundary (Map value is typed Homematic).
  return stub as unknown as Homematic
}

const ADDR = '0001D3C99AB777'

// ── Fixture builders ────────────────────────────────────────────────────────

interface DataPointSeed {
  parameter: string
  type?: string
  value?: boolean | number | string | null
  unit?: string
}

function dataPoint(seed: DataPointSeed) {
  return {
    id: `dp:${seed.parameter.toLowerCase()}`,
    parameter: seed.parameter,
    type: seed.type ?? 'FLOAT',
    value: seed.value ?? null,
    unit: seed.unit,
    readable: true,
    writable: false,
    hasEvents: true,
  }
}

/** A battery thermostat: HEATING channel + a MAINTENANCE channel with
 *  OPERATING_VOLTAGE + RSSI + UNREACH + firmware descriptor. */
function makeBatteryThermostat(): HmDevice {
  return {
    address: ADDR,
    type: 'HmIP-eTRV-C',
    name: 'Thermostat',
    firmware: '1.0.0',
    availableFirmware: '1.0.0',
    updatable: false,
    firmwareUpdateState: 'UP_TO_DATE',
    channels: [
      {
        address: `${ADDR}:1`,
        index: 1,
        type: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        dataPoints: [],
      },
      {
        address: `${ADDR}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          dataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: false }),
          dataPoint({ parameter: 'OPERATING_VOLTAGE', value: 2.9, unit: 'V' }),
          dataPoint({ parameter: 'RSSI_DEVICE', type: 'INTEGER', value: -60, unit: 'dBm' }),
          dataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
        ],
      },
    ],
  } as unknown as HmDevice
}

/** A roller-shutter (cover) with one custom entity + an energy meter channel. */
function makeCover(): HmDevice {
  return {
    address: ADDR,
    type: 'HmIP-BROLL',
    name: 'Roller',
    channels: [
      { address: `${ADDR}:4`, index: 4, type: 'SHUTTER_VIRTUAL_RECEIVER', dataPoints: [] },
      { address: `${ADDR}:7`, index: 7, type: 'ENERGIE_METER_TRANSMITTER', dataPoints: [] },
    ],
  } as unknown as HmDevice
}

/** A 2-key wall switch (event-emitter) with no MAINTENANCE channel. */
function makeWallSwitch(): HmDevice {
  const dps = [{ parameter: 'PRESS_SHORT' }, { parameter: 'PRESS_LONG' }].map(dataPoint)
  return {
    address: ADDR,
    type: 'HmIP-WRC2',
    name: 'Wall switch',
    channels: [
      { address: `${ADDR}:1`, index: 1, type: 'KEY_TRANSCEIVER', dataPoints: dps },
      { address: `${ADDR}:2`, index: 2, type: 'KEY_TRANSCEIVER', dataPoints: dps },
    ],
  } as unknown as HmDevice
}

function coverEntity(): HmCustomEntity {
  return {
    kind: 'cover',
    device: ADDR,
    channel: `${ADDR}:4`,
    channels: [`${ADDR}:4`],
    statusChannels: [],
    travel: 'stable',
    currentPosition: null,
    isClosed: true,
  }
}

beforeEach(() => {
  homematicFacades.clear()
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HmContainerDevice.getAccessoryChildren', () => {
  it('battery thermostat → climate actuator + temp/humidity sensor + voltage/rssi diagnostics + update child', () => {
    homematicFacades.set(
      'hm_001',
      makeFacade(
        [makeBatteryThermostat()],
        [{ kind: 'climate', device: ADDR, channel: `${ADDR}:1` } as unknown as HmCustomEntity],
      ),
    )
    const dev = new HmContainerDevice(
      makeCtx({ address: ADDR, brokerId: 'hm_001', integrationId: 'int-1' }),
    )
    const children = dev.getAccessoryChildren()
    const suffixes = children.map((c) => c.stableIdSuffix)

    // Actuator (climate) from the custom entity.
    expect(suffixes).toContain(`act-${ADDR}:1`)
    // Sensor child (temperature + humidity) from the HEATING channel.
    expect(suffixes).toContain(`sensor-${ADDR}:1`)
    // Diagnostics from MAINTENANCE.
    expect(suffixes).toContain('maint-voltage')
    expect(suffixes).toContain('maint-rssi-device')
    // Firmware update child.
    expect(suffixes).toContain('update')

    // Diagnostic child carries sourceParams provenance + unit + role.
    const voltage = children.find((c) => c.stableIdSuffix === 'maint-voltage')
    expect(voltage?.config['sourceParams']).toEqual(['OPERATING_VOLTAGE'])
    expect(voltage?.config['unit']).toBe('V')
    expect(voltage?.meta.role).toBe(DeviceRole.VoltageSensor)
    expect(voltage?.meta.type).toBe(DeviceType.Sensor)

    // Every child links back to the container + carries broker/integration FK.
    for (const child of children) {
      expect(child.meta.linkDeviceId).toBe(dev.id)
      expect(child.meta.integrationId).toBe('int-1')
      expect(child.config['brokerId']).toBe('hm_001')
      expect(child.config['integrationId']).toBe('int-1')
    }

    // Update child is DeviceType.Update with the update cap.
    const update = children.find((c) => c.stableIdSuffix === 'update')
    expect(update?.meta.type).toBe(DeviceType.Update)
  })

  it('cover device → ONE cover actuator child (entity channel) + ONE power-meter sensor child', () => {
    homematicFacades.set('hm_001', makeFacade([makeCover()], [coverEntity()]))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    const children = dev.getAccessoryChildren()

    const actuator = children.find((c) => c.stableIdSuffix === `act-${ADDR}:4`)
    expect(actuator).toBeDefined()
    expect(actuator?.meta.type).toBe(DeviceType.Cover)
    expect(actuator?.config['kind']).toBe('cover')
    expect(actuator?.config['channel']).toBe(`${ADDR}:4`)

    // The PRIMARY (actuator) child inherits the device display name (mirrors HA),
    // NOT a synthesised "cover <addr>:4". The container's name is 'Test Container'.
    expect(actuator?.meta.name).toBe('Test Container')

    const power = children.find((c) => c.stableIdSuffix === `sensor-${ADDR}:7`)
    expect(power).toBeDefined()
    expect(power?.config['capabilities']).toEqual(['power-meter'])
    // A support entity keeps its own descriptive name, not the device name.
    expect(power?.meta.name).not.toBe('Test Container')

    // No diagnostics / update child (no MAINTENANCE / firmware descriptor).
    expect(children.some((c) => c.stableIdSuffix === 'update')).toBe(false)
    expect(children.some((c) => c.stableIdSuffix.startsWith('maint-'))).toBe(false)
  })

  it('wall switch with key channels → exactly ONE event-emitter child', () => {
    homematicFacades.set('hm_001', makeFacade([makeWallSwitch()], []))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    const children = dev.getAccessoryChildren()

    const eventChildren = children.filter((c) => c.meta.type === DeviceType.EventEmitter)
    expect(eventChildren).toHaveLength(1)
    const ev = eventChildren[0]
    expect(ev?.stableIdSuffix).toBe('events')
    expect(ev?.config['eventTypes']).toEqual(['PRESS_SHORT', 'PRESS_LONG'])
  })

  it('returns no children when the device is not on the facade', () => {
    // No facade registered for this broker.
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    expect(dev.getAccessoryChildren()).toEqual([])
  })
})

describe('HmContainerDevice onProbe', () => {
  it('leaves lastProbedAt at 0 when the device is not on the facade', async () => {
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    await dev.onProbe()
    const slice = dev.runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')
    expect(slice?.lastProbedAt ?? 0).toBe(0)
  })

  it('stamps lastProbedAt when the device is on the facade', async () => {
    homematicFacades.set('hm_001', makeFacade([makeCover()], [coverEntity()]))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    await dev.onProbe()
    const slice = dev.runtimeState.getCapState<{ lastProbedAt?: number }>('feature-probe')
    expect(slice?.lastProbedAt ?? 0).toBeGreaterThan(0)
  })
})

describe('HmContainerDevice features + online', () => {
  it('advertises Resyncable + BatteryOperated when a battery diagnostic exists', () => {
    homematicFacades.set('hm_001', makeFacade([makeBatteryThermostat()], []))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    expect(dev.features).toContain(DeviceFeature.Resyncable)
    expect(dev.features).toContain(DeviceFeature.BatteryOperated)
  })

  it('advertises only Resyncable for a mains-powered cover', () => {
    homematicFacades.set('hm_001', makeFacade([makeCover()], [coverEntity()]))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    expect(dev.features).toEqual([DeviceFeature.Resyncable])
  })

  it('derives online=true from a reachable (UNREACH=false) device', () => {
    homematicFacades.set('hm_001', makeFacade([makeBatteryThermostat()], []))
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    expect(dev.online).toBe(true)
  })

  it('derives online=false when the device is absent from the facade', () => {
    const dev = new HmContainerDevice(makeCtx({ address: ADDR, brokerId: 'hm_001' }))
    expect(dev.online).toBe(false)
  })
})
