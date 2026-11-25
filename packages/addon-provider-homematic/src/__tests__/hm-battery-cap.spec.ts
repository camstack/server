/**
 * planning#709: a battery-operated Homematic device exposed no `battery` cap,
 * so its card drew no battery. The cap lives on the FUNCTIONAL child (the
 * motion sensor), never on the container, and is fed from the MAINTENANCE
 * channel (channel 0): LOW_BAT -> the binary state, OPERATING_VOLTAGE -> volts.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import type { Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmSensorDevice } from '../devices/hm-sensor-device.js'
import { deriveHmEntitySpecs } from '../devices/hm-entity-spec.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { hmDataPoint, hmDevice } from './hm-test-fixtures.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '0001D3C99AB777'
const MOTION_CHANNEL = `${ADDRESS}:1`
const MAINT_CHANNEL = `${ADDRESS}:0`
const DEVICE_ID = 5598

function motionSensor(withBattery: boolean) {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-SMI',
    channels: [
      {
        address: MOTION_CHANNEL,
        index: 1,
        type: 'MOTIONDETECTOR_TRANSCEIVER',
        dataPoints: [
          hmDataPoint({ parameter: 'MOTION', type: 'BOOL', value: false }),
          hmDataPoint({ parameter: 'ILLUMINATION', value: 40 }),
        ],
      },
      {
        address: MAINT_CHANNEL,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: [
          ...(withBattery
            ? [
                hmDataPoint({ parameter: 'LOW_BAT', type: 'BOOL', value: null }),
                hmDataPoint({ parameter: 'OPERATING_VOLTAGE', value: null, unit: 'V' }),
              ]
            : []),
          hmDataPoint({ parameter: 'UNREACH', type: 'BOOL', value: false }),
        ],
      },
    ],
  })
}

type Handler = (event: ValueChangedEvent) => void

function makeFacade(withBattery: boolean): { facade: Homematic; emit: Handler } {
  const handlers: Handler[] = []
  const stub = {
    on: (name: string, handler: Handler) => {
      if (name === 'valueChanged') handlers.push(handler)
      return () => undefined
    },
    devices: () => [motionSensor(withBattery)],
    customEntities: () => [],
  }
  return {
    facade: stub as unknown as Homematic,
    emit: (event) => handlers.forEach((h) => h(event)),
  }
}

interface WarnRecord {
  readonly message: string
  readonly extras: unknown
}

function makeCtx(capabilities: readonly string[]) {
  let rs: IDeviceRuntimeState | null = null
  const registered: string[] = []
  const warnings: WarnRecord[] = []
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string, extras?: unknown) => {
      warnings.push({ message, extras })
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: DEVICE_ID,
    stableId: `hm:${INTEGRATION_ID}:${ADDRESS}-sensor-${MOTION_CHANNEL}`,
    parentDeviceId: 5597,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: 'x',
      addonId: 'provider-homematic',
      type: DeviceType.Sensor,
      name: 'sensor',
      location: null,
      disabled: false,
      parentDeviceId: 5597,
      metadata: null,
    },
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      channel: MOTION_CHANNEL,
      capabilities,
    },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (r: IDeviceRuntimeState) => {
      rs = r
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      registered.push(cap.name)
      if (cap.runtimeState && rs) {
        rs.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    logger,
    api: {},
  } as unknown as DeviceContext
  return {
    ctx,
    registered,
    warnings,
    runtimeState: () => {
      if (rs === null) throw new Error('runtimeState not bound')
      return rs
    },
  }
}

function maintEvent(parameter: string, value: boolean | number): ValueChangedEvent {
  return {
    dpId: `${INTEGRATION_ID}:${MAINT_CHANNEL}:VALUES:${parameter}`,
    device: ADDRESS,
    channel: MAINT_CHANNEL,
    parameter,
    value,
    prevValue: null,
    ts: 1_786_260_613_643,
  }
}

beforeEach(() => {
  homematicFacades.clear()
})

describe('spec derivation: which children host the battery cap', () => {
  it('adds battery to the functional sensor of a LOW_BAT device, not to diagnostics', () => {
    const specs = deriveHmEntitySpecs(motionSensor(true), [])
    const sensor = specs.find((s) => s.key === `sensor-${MOTION_CHANNEL}`)
    expect(sensor?.capabilities).toContain('battery')
    expect(sensor?.config['capabilities']).toContain('battery')
    for (const spec of specs.filter((s) => s.key.startsWith('maint-'))) {
      expect(spec.capabilities).not.toContain('battery')
    }
  })

  it('leaves a mains device (no LOW_BAT) without a battery cap', () => {
    const specs = deriveHmEntitySpecs(motionSensor(false), [])
    expect(specs.some((s) => s.capabilities.includes('battery'))).toBe(false)
  })
})

describe('HmSensorDevice battery', () => {
  it('registers battery, unknown until a reading lands, then LOW_BAT + voltage from channel 0', async () => {
    const { facade, emit } = makeFacade(true)
    homematicFacades.set(INTEGRATION_ID, facade)
    const h = makeCtx(['motion', 'ambient-light-sensor', 'battery'])
    new HmSensorDevice(h.ctx)

    expect(h.registered).toContain('battery')
    expect(h.runtimeState().getCapState('battery')).toBeUndefined()

    emit(maintEvent('LOW_BAT', true))
    emit(maintEvent('OPERATING_VOLTAGE', 2.9))

    expect(h.runtimeState().getCapState('battery')).toMatchObject({
      binary: true,
      level: 15,
      voltage: 2.9,
    })

    emit(maintEvent('LOW_BAT', false))
    expect(h.runtimeState().getCapState('battery')).toMatchObject({ level: 100, voltage: 2.9 })
  })

  it('a voltage alone leaves the level unknown (null), never 0', () => {
    const { facade, emit } = makeFacade(true)
    homematicFacades.set(INTEGRATION_ID, facade)
    const h = makeCtx(['motion', 'battery'])
    new HmSensorDevice(h.ctx)
    emit(maintEvent('OPERATING_VOLTAGE', 3.1))
    expect(h.runtimeState().getCapState('battery')).toMatchObject({ level: null, voltage: 3.1 })
  })

  it('registers no battery when the config does not name it', () => {
    const { facade } = makeFacade(true)
    homematicFacades.set(INTEGRATION_ID, facade)
    const h = makeCtx(['motion'])
    new HmSensorDevice(h.ctx)
    expect(h.registered).not.toContain('battery')
  })

  it('skips the binding of a device without LOW_BAT and logs it with the deviceId', () => {
    const { facade } = makeFacade(false)
    homematicFacades.set(INTEGRATION_ID, facade)
    const h = makeCtx(['motion', 'battery'])
    new HmSensorDevice(h.ctx)
    expect(h.registered).not.toContain('battery')
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE_ID } })
  })
})
