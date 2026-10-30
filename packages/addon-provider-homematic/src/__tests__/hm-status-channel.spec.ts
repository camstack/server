/**
 * A Homematic entity whose parameter lives on BOTH a command channel and a
 * STATUS channel (an HmIP cover's `LEVEL`, a dimmer's `LEVEL`): the value must
 * be taken from the status channel only, and every branch of the value-change
 * filter — accepted, dropped for a foreign channel, dropped for a non-status
 * source — must leave a line tagged with the numeric deviceId.
 *
 * Every other Homematic fake declares `statusChannels: []`, which never enters
 * the status-channel branch; this fixture is the one that does.
 */

import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@camstack/types'
import type { HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmActuatorDevice } from '../devices/hm-actuator-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '00315F298E5A18'
const COMMAND_CHANNEL = `${ADDRESS}:4`
const STATUS_CHANNEL = `${ADDRESS}:3`
const FOREIGN_CHANNEL = `${ADDRESS}:8`
const DEVICE_ID = 1460
const STABLE_ID = `hm:${INTEGRATION_ID}:${ADDRESS}-act-${COMMAND_CHANNEL}`

interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn'
  readonly message: string
  readonly extras: unknown
}

type StubLogger = {
  debug: (message: string, extras?: unknown) => undefined
  info: (message: string, extras?: unknown) => undefined
  warn: (message: string, extras?: unknown) => undefined
  error: () => undefined
  child: () => StubLogger
  withTags: () => StubLogger
}

function makeLogger(records: LogRecord[]): StubLogger {
  const at =
    (level: LogRecord['level']) =>
    (message: string, extras?: unknown): undefined => {
      records.push({ level, message, extras })
      return undefined
    }
  const logger: StubLogger = {
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: () => undefined,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function makeCtx(records: LogRecord[]): {
  ctx: DeviceContext
  runtimeState: () => IDeviceRuntimeState
} {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: DEVICE_ID,
    stableId: STABLE_ID,
    parentDeviceId: 1445,
    deviceMeta: {
      id: DEVICE_ID,
      stableId: STABLE_ID,
      addonId: 'provider-homematic',
      type: DeviceType.Switch,
      name: 'switch with status channel',
      location: null,
      disabled: false,
      parentDeviceId: 1445,
      metadata: null,
    },
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      channel: COMMAND_CHANNEL,
      kind: 'switch',
    },
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
    logger: makeLogger(records),
    api: {},
    // Same documented stub boundary as hm-actuator-channel-scope.spec.ts.
  } as unknown as DeviceContext
  return {
    ctx,
    runtimeState: () => {
      if (runtimeStateRef === null) throw new Error('runtimeState not bound')
      return runtimeStateRef
    },
  }
}

/** STATE is carried by BOTH the command and the status channel. */
function snapshot(): HmDevice {
  const state = (address: string): Record<string, unknown> => ({
    id: `${INTEGRATION_ID}:${address}:VALUES:STATE`,
    parameter: 'STATE',
    type: 'BOOL',
    value: false,
    readable: true,
    writable: true,
    hasEvents: true,
  })
  return {
    address: ADDRESS,
    type: 'HmIP-BSL',
    interfaceId: INTEGRATION_ID,
    channels: [
      {
        address: STATUS_CHANNEL,
        index: 3,
        type: 'SWITCH_TRANSMITTER',
        dataPoints: [state(STATUS_CHANNEL)],
      },
      {
        address: COMMAND_CHANNEL,
        index: 4,
        type: 'SWITCH_VIRTUAL_RECEIVER',
        dataPoints: [state(COMMAND_CHANNEL)],
      },
    ],
  } as unknown as HmDevice
}

type Handler = (event: ValueChangedEvent) => void

function makeFacade(): { facade: Homematic; emit: Handler } {
  const handlers = new Map<string, Handler[]>()
  const stub = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler])
      return () => undefined
    },
    devices: () => [snapshot()],
    customEntities: () => [
      {
        device: ADDRESS,
        channel: COMMAND_CHANNEL,
        channels: [COMMAND_CHANNEL, STATUS_CHANNEL],
        statusChannels: [STATUS_CHANNEL],
      },
    ],
  }
  return {
    facade: stub as unknown as Homematic,
    emit: (event) => {
      for (const handler of handlers.get('valueChanged') ?? []) handler(event)
    },
  }
}

function stateEvent(channel: string, value: boolean): ValueChangedEvent {
  return {
    dpId: `${INTEGRATION_ID}:${channel}:VALUES:STATE`,
    device: ADDRESS,
    channel,
    parameter: 'STATE',
    value,
    prevValue: !value,
    ts: 1_786_260_613_643,
  }
}

function setup(): { records: LogRecord[]; emit: Handler; state: () => unknown } {
  homematicFacades.clear()
  const records: LogRecord[] = []
  const { facade, emit } = makeFacade()
  homematicFacades.set(INTEGRATION_ID, facade)
  const { ctx, runtimeState } = makeCtx(records)
  new HmActuatorDevice(ctx)
  return { records, emit, state: () => runtimeState().getCapState('switch') }
}

const deviceTagged = (r: LogRecord | undefined): boolean =>
  r !== undefined &&
  typeof r.extras === 'object' &&
  r.extras !== null &&
  'tags' in r.extras &&
  JSON.stringify(r.extras.tags) === JSON.stringify({ deviceId: DEVICE_ID })

beforeEach(() => {
  homematicFacades.clear()
})

describe('Homematic entity with a status channel', () => {
  it('takes the value from the status channel and logs the accepted change', () => {
    const { records, emit, state } = setup()
    emit(stateEvent(STATUS_CHANNEL, true))
    expect(state()).toMatchObject({ on: true })
    const line = records.find((r) => r.message.includes('value change accepted'))
    expect(line?.level).toBe('debug')
    expect(deviceTagged(line)).toBe(true)
  })

  it('ignores the same parameter from the command channel and logs the drop', () => {
    const { records, emit, state } = setup()
    emit(stateEvent(COMMAND_CHANNEL, true))
    expect(state()).toMatchObject({ on: false })
    const line = records.find((r) => r.message.includes('value change dropped'))
    expect(line?.level).toBe('debug')
    expect(deviceTagged(line)).toBe(true)
    expect(JSON.stringify(line?.extras)).toContain('not-status-source')
  })

  it('logs the drop of an event from a channel the entity does not own', () => {
    const { records, emit, state } = setup()
    emit(stateEvent(FOREIGN_CHANNEL, true))
    expect(state()).toMatchObject({ on: false })
    const line = records.find((r) => r.message.includes('value change dropped'))
    expect(deviceTagged(line)).toBe(true)
    expect(JSON.stringify(line?.extras)).toContain('foreign-channel')
  })
})
