/**
 * Regression: a MULTI-RELAY Homematic device must not collapse its relays into
 * one state.
 *
 * The fixture carries the REAL identifiers of the operator's HmIP-BS2
 * ("Pulsante faretti hall", device 1445): one physical address that hosts TWO
 * independent relays on channels `:4` and `:8`. The stable ids repeat the
 * address (`<addr>-act-<addr>:<ch>`) exactly as the live hub stores them — an
 * invented `dev-1` / `dev-2` pair would not discriminate a channel-blind filter
 * from a correct one.
 *
 * Symptom this pins: turning ON the `:4` relay made BOTH children report
 * `switch.on = true` (verified live — both slices carried the SAME
 * `lastChangedAt` millisecond), because the child's `valueChanged` listener
 * filtered on the DEVICE address only and both relays emit `STATE`.
 */

import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import type { HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-gateway.js'

// ── Live identifiers (hub: device 1445 + children 1460 / 1461) ──────────────

const BROKER_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const CHANNEL_A = `${ADDRESS}:4`
const CHANNEL_B = `${ADDRESS}:8`
const DEVICE_ID_A = 1460
const DEVICE_ID_B = 1461
const STABLE_ID_A = `hm:${BROKER_ID}:${ADDRESS}-act-${CHANNEL_A}`
const STABLE_ID_B = `hm:${BROKER_ID}:${ADDRESS}-act-${CHANNEL_B}`

// ── DeviceContext stub (same shape as homematic-device.spec.ts) ─────────────

/** Records `warn` so the drop-path assertion can read the emitted tags.
 *  A type alias (not an interface) mirrors `homematic-device.spec.ts`. */
type StubLogger = {
  debug: () => undefined
  info: () => undefined
  warn: (message: string, extras?: unknown) => undefined
  error: () => undefined
  child: () => StubLogger
  withTags: () => StubLogger
}

interface WarnRecord {
  readonly message: string
  readonly extras: unknown
}

function makeLogger(warnings: WarnRecord[]): StubLogger {
  const logger: StubLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, extras) => {
      warnings.push({ message, extras })
      return undefined
    },
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

interface CtxHandle {
  readonly ctx: DeviceContext
  readonly runtimeState: () => IDeviceRuntimeState
  readonly warnings: readonly WarnRecord[]
}

function makeCtx(id: number, stableId: string, channel: string): CtxHandle {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const warnings: WarnRecord[] = []
  const ctx = {
    id,
    stableId,
    parentDeviceId: 1445,
    deviceMeta: {
      id,
      stableId,
      addonId: 'provider-homematic',
      type: DeviceType.Switch,
      name: `switch ${channel}`,
      location: null,
      disabled: false,
      parentDeviceId: 1445,
      metadata: null,
    },
    persistedConfig: { address: ADDRESS, brokerId: BROKER_ID, channel, kind: 'switch' },
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
    logger: makeLogger(warnings),
    api: {},
    // The kernel builds a full DeviceContext; the stub covers exactly what
    // HmActuatorDevice touches. Widened at this one documented boundary.
  } as unknown as DeviceContext

  return {
    ctx,
    runtimeState: () => {
      if (runtimeStateRef === null) throw new Error('runtimeState not bound')
      return runtimeStateRef
    },
    warnings,
  }
}

// ── Facade stub ─────────────────────────────────────────────────────────────

type Handler = (event: ValueChangedEvent) => void

interface FacadeStub {
  emit: (event: ValueChangedEvent) => void
  on: (event: string, handler: Handler) => () => void
  devices: () => HmDevice[]
  customEntities: () => never[]
}

/** The BS2 as the library reports it: STATE on BOTH relay channels. */
function bs2Snapshot(): HmDevice {
  const state = (address: string): Record<string, unknown> => ({
    id: `${BROKER_ID}:${address}:VALUES:STATE`,
    parameter: 'STATE',
    type: 'BOOL',
    value: false,
    readable: true,
    writable: true,
    hasEvents: true,
  })
  const device = {
    address: ADDRESS,
    type: 'HmIP-BS2',
    interfaceId: BROKER_ID,
    channels: [
      {
        address: CHANNEL_A,
        index: 4,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [state(CHANNEL_A)],
      },
      {
        address: CHANNEL_B,
        index: 8,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [state(CHANNEL_B)],
      },
    ],
  }
  return device as unknown as HmDevice
}

function makeFacade(): { facade: Homematic; emit: (event: ValueChangedEvent) => void } {
  // Keyed by event name: the child also subscribes `ready` / `connection` to
  // re-seed, and firing those on a value change would replay the cached
  // datapoints over the assertion.
  const handlers = new Map<string, Handler[]>()
  const stub: FacadeStub = {
    emit: (event) => {
      for (const handler of handlers.get('valueChanged') ?? []) handler(event)
    },
    on: (name, handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => {
        const index = list.indexOf(handler)
        if (index !== -1) list.splice(index, 1)
      }
    },
    devices: () => [bs2Snapshot()],
    customEntities: () => [],
  }
  return { facade: stub as unknown as Homematic, emit: (event) => stub.emit(event) }
}

function stateEvent(channel: string, value: boolean, ts: number): ValueChangedEvent {
  return {
    dpId: `${BROKER_ID}:${channel}:VALUES:STATE`,
    device: ADDRESS,
    channel,
    parameter: 'STATE',
    value,
    prevValue: !value,
    ts,
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  homematicFacades.clear()
})

describe('HmIP-BS2 dual relay — per-channel state isolation', () => {
  it('routes a STATE event to the relay that owns the channel, and to it only', () => {
    const { facade, emit } = makeFacade()
    homematicFacades.set(BROKER_ID, facade)

    const relayA = makeCtx(DEVICE_ID_A, STABLE_ID_A, CHANNEL_A)
    const relayB = makeCtx(DEVICE_ID_B, STABLE_ID_B, CHANNEL_B)
    new HmActuatorDevice(relayA.ctx)
    new HmActuatorDevice(relayB.ctx)

    emit(stateEvent(CHANNEL_B, true, 1_786_260_613_643))

    expect(relayB.runtimeState().getCapState('switch')).toMatchObject({ on: true })
    // The operator actuated ONE relay; the other must stay off.
    expect(relayA.runtimeState().getCapState('switch')).toMatchObject({ on: false })
  })

  it('keeps the two relays independent when only the first is actuated', () => {
    const { facade, emit } = makeFacade()
    homematicFacades.set(BROKER_ID, facade)

    const relayA = makeCtx(DEVICE_ID_A, STABLE_ID_A, CHANNEL_A)
    const relayB = makeCtx(DEVICE_ID_B, STABLE_ID_B, CHANNEL_B)
    new HmActuatorDevice(relayA.ctx)
    new HmActuatorDevice(relayB.ctx)

    emit(stateEvent(CHANNEL_A, true, 1_786_260_613_643))

    expect(relayA.runtimeState().getCapState('switch')).toMatchObject({ on: true })
    expect(relayB.runtimeState().getCapState('switch')).toMatchObject({ on: false })
  })

  it('drops a channel-less value event and logs it with the numeric deviceId', () => {
    const { facade, emit } = makeFacade()
    homematicFacades.set(BROKER_ID, facade)

    const relayA = makeCtx(DEVICE_ID_A, STABLE_ID_A, CHANNEL_A)
    new HmActuatorDevice(relayA.ctx)

    const unmappable: ValueChangedEvent = { ...stateEvent(CHANNEL_A, true, 1), channel: '' }
    emit(unmappable)

    expect(relayA.runtimeState().getCapState('switch')).toMatchObject({ on: false })
    expect(relayA.warnings).toHaveLength(1)
    expect(relayA.warnings[0]?.extras).toMatchObject({ tags: { deviceId: DEVICE_ID_A } })
  })
})
