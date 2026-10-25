/**
 * A replayed CCU value is a KNOWN value with an UNKNOWN change time.
 *
 * After a respawn the child replays the library's cached values
 * (`seedCurrentValues`). They were stamped `Date.now()`, so a lock unlocked
 * for hours read as an unlock that had just happened — fresh enough to clear
 * post-analysis's first-sighting floor and fire an armed alarm rule. The
 * convention (`hm-change-stamp.ts`): 0 = placeholder, `HM_SEEDED_CHANGED_AT`
 * = known value, old/unknown change time, a recent stamp = a real change.
 */

import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type LockControlStatus,
} from '@camstack/types'
import type { HmDevice, HmValue, Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { HM_SEEDED_CHANGED_AT, changeStamp } from '../devices/hm-change-stamp.js'
import { HmDiagnosticDevice } from '../devices/hm-diagnostic-device.js'
import { HmSensorDevice } from '../devices/hm-sensor-device.js'
import { homematicFacades } from '../homematic-gateway.js'

const BROKER_ID = 'hm_001'
const ADDRESS = '002A1BE9A3C4F1'
const CHANNEL = `${ADDRESS}:1`
const DEVICE_ID = 4201
const LIVE_TS = 1_790_000_000_000

type Handler = (event: ValueChangedEvent) => void

interface InfoRecord {
  readonly message: string
  readonly extras: unknown
}

interface Harness {
  readonly ctx: DeviceContext
  readonly lock: () => LockControlStatus | undefined
  readonly getCap: <T extends Record<string, unknown> = Record<string, unknown>>(
    capName: string,
  ) => Readonly<T> | undefined
  readonly infos: readonly InfoRecord[]
}

/** Overrides for the one field every child schema disagrees about: the
 *  persisted config shape, plus the `DeviceType` the kernel would assign. */
interface CtxOverrides {
  readonly type?: DeviceType
  readonly persistedConfig?: Record<string, unknown>
  /** The persisted runtime-state blob the kernel hydrates at boot. */
  readonly initialRuntimeState?: Record<string, unknown>
}

function makeCtx(overrides: CtxOverrides = {}): Harness {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const infos: InfoRecord[] = []
  const logger = {
    debug: () => undefined,
    info: (message: string, extras?: unknown) => {
      infos.push({ message, extras })
    },
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  const ctx = {
    id: DEVICE_ID,
    stableId: `hm:${BROKER_ID}:${ADDRESS}-act-${CHANNEL}`,
    parentDeviceId: 4200,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: `hm:${BROKER_ID}:${ADDRESS}-act-${CHANNEL}`,
      addonId: 'provider-homematic',
      type: overrides.type ?? DeviceType.Lock,
      name: 'front door lock',
      location: null,
      disabled: false,
      parentDeviceId: 4200,
      metadata: null,
    },
    persistedConfig: overrides.persistedConfig ?? {
      address: ADDRESS,
      brokerId: BROKER_ID,
      channel: CHANNEL,
      kind: 'lock',
    },
    initialRuntimeState: overrides.initialRuntimeState ?? {},
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
    logger,
    api: {},
    // The kernel builds a full DeviceContext; the stub covers exactly what
    // HmActuatorDevice touches. Widened at this one documented boundary.
  } as unknown as DeviceContext
  return {
    ctx,
    lock: () => runtimeStateRef?.getCapState<LockControlStatus>('lock-control'),
    getCap: <T extends Record<string, unknown> = Record<string, unknown>>(capName: string) =>
      runtimeStateRef?.getCapState<T>(capName),
    infos,
  }
}

interface FacadeHandle {
  readonly facade: Homematic
  /** Change the CCU's cached LOCK_STATE (what the next replay reads). */
  readonly setCached: (value: HmValue) => void
  readonly emitLive: (value: HmValue, ts: number) => void
  readonly reconnect: () => void
}

/** An HmIP-DLD as the library reports it: LOCK_STATE on channel :1. */
function makeFacade(initial: HmValue): FacadeHandle {
  let cached: HmValue = initial
  const handlers = new Map<string, Handler[]>()
  const fire = (name: string, event: ValueChangedEvent): void => {
    for (const handler of handlers.get(name) ?? []) handler(event)
  }
  const snapshot = (): HmDevice => {
    const device = {
      address: ADDRESS,
      type: 'HmIP-DLD',
      interfaceId: BROKER_ID,
      channels: [
        {
          address: CHANNEL,
          index: 1,
          type: 'DOOR_LOCK_STATE_TRANSMITTER',
          dataPoints: [
            {
              id: `${BROKER_ID}:${CHANNEL}:VALUES:LOCK_STATE`,
              parameter: 'LOCK_STATE',
              type: 'ENUM',
              value: cached,
              valueList: ['UNKNOWN', 'LOCKED', 'UNLOCKED'],
              readable: true,
              writable: false,
              hasEvents: true,
            },
          ],
        },
      ],
    }
    // The library's HmDevice carries far more than one channel's one
    // datapoint; the stub covers exactly what the child classes read off
    // it. Widened at this one documented boundary.
    return device as unknown as HmDevice
  }
  const stub = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => undefined
    },
    devices: () => [snapshot()],
    customEntities: () => [],
  }
  const event = (value: HmValue, ts: number): ValueChangedEvent => ({
    dpId: `${BROKER_ID}:${CHANNEL}:VALUES:LOCK_STATE`,
    device: ADDRESS,
    channel: CHANNEL,
    parameter: 'LOCK_STATE',
    value,
    prevValue: null,
    ts,
  })
  return {
    // The stub implements only `on` / `devices` / `customEntities` —
    // exactly what `HmChildDevice` calls on a `Homematic` facade. Widened
    // at this one documented boundary.
    facade: stub as unknown as Homematic,
    setCached: (value) => {
      cached = value
    },
    emitLive: (value, ts) => {
      cached = value
      fire('valueChanged', event(value, ts))
    },
    reconnect: () => fire('connection', event(cached, 0)),
  }
}

/** One datapoint a seed-replay facade offers on `CHANNEL`. */
interface SeedDatapointSpec {
  readonly channelType: string
  readonly parameter: string
  readonly dpType: string
  readonly value: HmValue
  readonly valueList?: readonly string[]
}

/**
 * A facade whose only job is to be seeded from: one device, one channel,
 * one datapoint, no `customEntities` (so every channel/parameter is
 * preferred-source by default — see `isPreferredSource`). Devices under
 * test call this through `seedCurrentValues()` at construction time; there
 * is no live path to drive here.
 */
function makeSeedFacade(spec: SeedDatapointSpec): Homematic {
  const device = {
    address: ADDRESS,
    type: 'HmIP-GENERIC',
    interfaceId: BROKER_ID,
    channels: [
      {
        address: CHANNEL,
        index: 1,
        type: spec.channelType,
        dataPoints: [
          {
            id: `${BROKER_ID}:${CHANNEL}:VALUES:${spec.parameter}`,
            parameter: spec.parameter,
            type: spec.dpType,
            value: spec.value,
            valueList: spec.valueList,
            readable: true,
            writable: false,
            hasEvents: true,
          },
        ],
      },
    ],
    // The stub's dataPoints/channels shape is the library's; only the
    // fields the child classes actually read are populated. Widened at
    // this one documented boundary.
  } as unknown as HmDevice
  const stub = {
    on: () => () => undefined,
    devices: () => [device],
    customEntities: () => [],
    // Same documented boundary as `makeFacade`: the stub covers exactly
    // what `seedCurrentValues()` reads off a `Homematic` facade.
  } as unknown as Homematic
  return stub
}

beforeEach(() => {
  homematicFacades.clear()
})

describe('changeStamp', () => {
  it('a live value is stamped with its event time', () => {
    expect(changeStamp('live', LIVE_TS, 0, false)).toBe(LIVE_TS)
  })

  it('a seed is never `now` and never the placeholder 0', () => {
    expect(changeStamp('seed', LIVE_TS, 0, true)).toBe(HM_SEEDED_CHANGED_AT)
    expect(changeStamp('seed', LIVE_TS, 0, false)).toBe(HM_SEEDED_CHANGED_AT)
    expect(changeStamp('seed', LIVE_TS, null, false)).toBe(HM_SEEDED_CHANGED_AT)
  })

  it('a seed that confirms a real reading keeps its real stamp; one that moves it does not', () => {
    expect(changeStamp('seed', LIVE_TS, 1_000, true)).toBe(1_000)
    expect(changeStamp('seed', LIVE_TS, 1_000, false)).toBe(HM_SEEDED_CHANGED_AT)
  })
})

describe('HmActuatorDevice lock — seeded values are known, never fresh', () => {
  it('a respawn replaying an UNLOCKED lock yields a reading stamped as known-but-old', () => {
    const { facade } = makeFacade('UNLOCKED')
    homematicFacades.set(BROKER_ID, facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)

    expect(h.lock()).toEqual({ state: 'unlocked', lastChangedAt: HM_SEEDED_CHANGED_AT })
  })

  it('a live event is stamped with its own time', () => {
    const f = makeFacade('LOCKED')
    homematicFacades.set(BROKER_ID, f.facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)

    f.emitLive('UNLOCKED', LIVE_TS)

    expect(h.lock()).toEqual({ state: 'unlocked', lastChangedAt: LIVE_TS })
  })

  it('a reconnect replay that confirms the state keeps the real stamp', () => {
    const f = makeFacade('LOCKED')
    homematicFacades.set(BROKER_ID, f.facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)
    f.emitLive('UNLOCKED', LIVE_TS)

    f.reconnect()

    expect(h.lock()).toEqual({ state: 'unlocked', lastChangedAt: LIVE_TS })
  })

  it('a reconnect replay that finds the state moved stamps it known-but-old, not now', () => {
    const f = makeFacade('LOCKED')
    homematicFacades.set(BROKER_ID, f.facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)
    f.emitLive('LOCKED', LIVE_TS)

    f.setCached('UNLOCKED')
    f.reconnect()

    expect(h.lock()).toEqual({ state: 'unlocked', lastChangedAt: HM_SEEDED_CHANGED_AT })
  })

  it('an UNKNOWN LOCK_STATE leaves the cold placeholder a placeholder, and says so', () => {
    const { facade } = makeFacade('UNKNOWN')
    homematicFacades.set(BROKER_ID, facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)

    expect(h.lock()).toEqual({ state: 'unlocked', lastChangedAt: 0 })
    expect(h.infos).toHaveLength(1)
    expect(h.infos[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { keptPlaceholder: true, origin: 'seed' },
    })
  })

  it('an UNKNOWN LOCK_STATE over a real reading keeps state AND stamp', () => {
    const f = makeFacade('LOCKED')
    homematicFacades.set(BROKER_ID, f.facade)
    const h = makeCtx()
    new HmActuatorDevice(h.ctx)
    f.emitLive('LOCKED', LIVE_TS)

    f.emitLive('UNKNOWN', LIVE_TS + 60_000)

    expect(h.lock()).toEqual({ state: 'locked', lastChangedAt: LIVE_TS })
  })
})

interface SeedReplayCase {
  readonly name: string
  readonly type: DeviceType
  readonly persistedConfig: Record<string, unknown>
  readonly datapoint: SeedDatapointSpec
  readonly build: (ctx: DeviceContext) => void
  readonly capName: string
  readonly expected: unknown
}

const SEED_REPLAY_CASES: readonly SeedReplayCase[] = [
  {
    name: 'cover LEVEL=1.0 replays as open, stamped known-but-old',
    type: DeviceType.Cover,
    persistedConfig: { address: ADDRESS, brokerId: BROKER_ID, channel: CHANNEL, kind: 'cover' },
    datapoint: {
      channelType: 'SHUTTER_VIRTUAL_RECEIVER',
      parameter: 'LEVEL',
      dpType: 'FLOAT',
      value: 1.0,
    },
    build: (ctx) => {
      new HmActuatorDevice(ctx)
    },
    capName: 'cover',
    expected: {
      state: 'open',
      position: 100,
      tiltPosition: null,
      lastChangedAt: HM_SEEDED_CHANGED_AT,
    },
  },
  {
    name: 'motion MOTION=true replays as detected, stamped known-but-old',
    type: DeviceType.Sensor,
    persistedConfig: {
      address: ADDRESS,
      brokerId: BROKER_ID,
      channel: CHANNEL,
      capabilities: ['motion'],
    },
    datapoint: {
      channelType: 'MOTION_DETECTION_TRANSMITTER',
      parameter: 'MOTION',
      dpType: 'BOOL',
      value: true,
    },
    build: (ctx) => {
      new HmSensorDevice(ctx)
    },
    capName: 'motion',
    expected: { detected: true, lastDetectedAt: HM_SEEDED_CHANGED_AT, autoClearAfterMs: null },
  },
  {
    name: 'switch STATE=true replays as on, stamped known-but-old',
    type: DeviceType.Switch,
    persistedConfig: { address: ADDRESS, brokerId: BROKER_ID, channel: CHANNEL, kind: 'switch' },
    datapoint: { channelType: 'SWITCH_CHANNEL', parameter: 'STATE', dpType: 'BOOL', value: true },
    build: (ctx) => {
      new HmActuatorDevice(ctx)
    },
    capName: 'switch',
    expected: { on: true, lastChangedAt: HM_SEEDED_CHANGED_AT },
  },
  {
    name: 'diagnostic binary LOWBAT=true replays as on, stamped known-but-old',
    type: DeviceType.Sensor,
    persistedConfig: {
      address: ADDRESS,
      brokerId: BROKER_ID,
      channel: CHANNEL,
      capabilities: ['binary'],
      sourceParams: ['LOWBAT'],
    },
    datapoint: { channelType: 'MAINTENANCE', parameter: 'LOWBAT', dpType: 'BOOL', value: true },
    build: (ctx) => {
      new HmDiagnosticDevice(ctx)
    },
    capName: 'binary',
    expected: { on: true, lastChangedAt: HM_SEEDED_CHANGED_AT },
  },
]

describe('seed replay reaches every child handler — known value, unknown change time', () => {
  it.each(SEED_REPLAY_CASES)('$name', ({
    type,
    persistedConfig,
    datapoint,
    build,
    capName,
    expected,
  }) => {
    homematicFacades.set(BROKER_ID, makeSeedFacade(datapoint))
    const h = makeCtx({ type, persistedConfig })

    build(h.ctx)

    expect(h.getCap(capName)).toEqual(expected)
  })
})

describe('HmSensorDevice motion — a stored rise survives a restart', () => {
  const MOTION_CONFIG = {
    address: ADDRESS,
    brokerId: BROKER_ID,
    channel: CHANNEL,
    capabilities: ['motion'],
  }
  const STORED_RISE = LIVE_TS - 3_600_000
  const stored = {
    motion: { detected: true, lastDetectedAt: STORED_RISE, autoClearAfterMs: null },
  }

  it('the constructor seed keeps the stored rise; the level stays a placeholder', () => {
    const h = makeCtx({
      type: DeviceType.Sensor,
      persistedConfig: MOTION_CONFIG,
      initialRuntimeState: stored,
    })
    new HmSensorDevice(h.ctx)
    expect(h.getCap('motion')).toEqual({
      detected: false,
      lastDetectedAt: STORED_RISE,
      autoClearAfterMs: null,
    })
  })

  it('a replayed MOTION=false after the restart keeps the stored rise', () => {
    homematicFacades.set(
      BROKER_ID,
      makeSeedFacade({
        channelType: 'MOTION_DETECTION_TRANSMITTER',
        parameter: 'MOTION',
        dpType: 'BOOL',
        value: false,
      }),
    )
    const h = makeCtx({
      type: DeviceType.Sensor,
      persistedConfig: MOTION_CONFIG,
      initialRuntimeState: stored,
    })
    new HmSensorDevice(h.ctx)
    expect(h.getCap('motion')).toEqual({
      detected: false,
      lastDetectedAt: STORED_RISE,
      autoClearAfterMs: null,
    })
  })

  it('nothing stored ⇒ null, never an invented time', () => {
    const h = makeCtx({ type: DeviceType.Sensor, persistedConfig: MOTION_CONFIG })
    new HmSensorDevice(h.ctx)
    expect(h.getCap('motion')).toEqual({
      detected: false,
      lastDetectedAt: null,
      autoClearAfterMs: null,
    })
  })
})
