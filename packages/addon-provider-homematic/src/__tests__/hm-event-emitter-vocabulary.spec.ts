/**
 * A Homematic remote names the button of a press (D1044).
 *
 * The buttons are read LIVE from the CCU's channel list: a child's config
 * is written once, at adoption, so a remote adopted before the vocabulary
 * existed would otherwise never get its buttons.
 */
import {
  type DeviceContext,
  DeviceType,
  EventCategory,
  type EventEmitterStatus,
  type IDeviceRuntimeState,
} from '@camstack/types'
import type { HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { beforeEach, describe, expect, it } from 'vitest'
import { HmEventEmitterDevice } from '../devices/hm-event-emitter-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'

const INTEGRATION_ID = 'hm_001'
const ADDRESS = '000B1D8990A1B2'
const DEVICE_ID = 5301

type Handler = (event: ValueChangedEvent) => void

interface LogRecord {
  readonly message: string
  readonly extras: unknown
}

interface Emitted {
  readonly category: string
  readonly data: unknown
}

interface Harness {
  readonly ctx: DeviceContext
  readonly status: () => EventEmitterStatus | undefined
  readonly warnings: readonly LogRecord[]
  readonly emitted: readonly Emitted[]
}

function makeCtx(): Harness {
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const warnings: LogRecord[] = []
  const emitted: Emitted[] = []
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
  const stableId = `hm:${INTEGRATION_ID}:${ADDRESS}-events`
  const ctx = {
    id: DEVICE_ID,
    stableId,
    parentDeviceId: 5300,
    deviceMeta: {
      id: DEVICE_ID,
      stableId,
      addonId: 'provider-homematic',
      type: DeviceType.EventEmitter,
      name: 'Buttons',
      location: null,
      disabled: false,
      parentDeviceId: 5300,
      metadata: null,
    },
    // What an adoption older than the vocabulary persisted: tokens only.
    persistedConfig: {
      address: ADDRESS,
      integrationId: INTEGRATION_ID,
      capabilities: ['event-emitter'],
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
    },
    initialRuntimeState: {},
    eventBus: {
      emit: (event: { category: string; data: unknown }) => {
        if (event.category !== EventCategory.EventEmitted) return
        emitted.push({ category: event.category, data: event.data })
      },
      subscribe: () => () => {},
      getRecent: () => [],
    },
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
    // HmEventEmitterDevice touches. Widened at this one documented boundary.
  } as unknown as DeviceContext
  return {
    ctx,
    status: () => runtimeStateRef?.getCapState<EventEmitterStatus>('event-emitter'),
    warnings,
    emitted,
  }
}

interface FacadeHandle {
  readonly facade: Homematic
  readonly press: (channelIndex: number, parameter: string) => void
}

/** A two-button wall switch as the library reports it: keys on :1 and :2. */
function makeFacade(): FacadeHandle {
  const handlers = new Map<string, Handler[]>()
  const device = {
    address: ADDRESS,
    type: 'HmIP-WRC2',
    interfaceId: INTEGRATION_ID,
    channels: [1, 2].map((index) => ({
      address: `${ADDRESS}:${index}`,
      index,
      type: 'KEY_TRANSCEIVER',
      dataPoints: ['PRESS_SHORT', 'PRESS_LONG'].map((parameter) => ({
        id: `${INTEGRATION_ID}:${ADDRESS}:${index}:VALUES:${parameter}`,
        parameter,
        type: 'ACTION',
        value: null,
        readable: false,
        writable: false,
        hasEvents: true,
      })),
    })),
    // The stub carries exactly the fields the child reads off an HmDevice.
    // Widened at this one documented boundary.
  } as unknown as HmDevice
  const stub = {
    on: (name: string, handler: Handler) => {
      const list = handlers.get(name) ?? []
      list.push(handler)
      handlers.set(name, list)
      return () => undefined
    },
    devices: () => [device],
    customEntities: () => [],
  }
  return {
    // Exactly what `HmChildDevice` calls on a `Homematic` facade. Widened at
    // this one documented boundary.
    facade: stub as unknown as Homematic,
    press: (channelIndex, parameter) => {
      const event: ValueChangedEvent = {
        dpId: `${INTEGRATION_ID}:${ADDRESS}:${channelIndex}:VALUES:${parameter}`,
        device: ADDRESS,
        channel: `${ADDRESS}:${channelIndex}`,
        parameter,
        value: true,
        prevValue: null,
        ts: 1_790_000_000_000,
      }
      for (const handler of handlers.get('valueChanged') ?? []) handler(event)
    },
  }
}

beforeEach(() => {
  homematicFacades.clear()
})

describe('HmEventEmitterDevice, the declared vocabulary', () => {
  it('declares one source per button, read live, for a remote adopted with tokens only', () => {
    const f = makeFacade()
    homematicFacades.set(INTEGRATION_ID, f.facade)
    const h = makeCtx()
    new HmEventEmitterDevice(h.ctx)
    const status = h.status()
    expect(status?.vocabulary.map((entry) => `${entry.source?.label}: ${entry.label}`)).toEqual([
      'Button 1 (channel 1): Short press',
      'Button 1 (channel 1): Long press',
      'Button 2 (channel 2): Short press',
      'Button 2 (channel 2): Long press',
    ])
    expect(status?.eventTypes).toEqual(['PRESS_SHORT', 'PRESS_LONG'])
  })

  it('names the button of a press, on the fire and on the bus', () => {
    const f = makeFacade()
    homematicFacades.set(INTEGRATION_ID, f.facade)
    const h = makeCtx()
    new HmEventEmitterDevice(h.ctx)
    f.press(2, 'PRESS_LONG')
    const last = h.status()?.lastEvent
    expect(last?.eventType).toBe('PRESS_LONG')
    expect(last?.sourceId).toBe('2')
    expect(last?.data).toEqual({ channel: '2' })
    expect(h.emitted).toHaveLength(1)
    expect(h.emitted[0]?.data).toMatchObject({ eventType: 'PRESS_LONG', sourceId: '2' })
  })

  it('counts two identical presses as two fires', () => {
    const f = makeFacade()
    homematicFacades.set(INTEGRATION_ID, f.facade)
    const h = makeCtx()
    new HmEventEmitterDevice(h.ctx)
    f.press(1, 'PRESS_SHORT')
    f.press(1, 'PRESS_SHORT')
    expect(h.status()?.eventCountSinceStart).toBe(2)
    expect(h.status()?.lastEvent?.seq).toBe(2)
    expect(h.emitted).toHaveLength(2)
  })

  it('still delivers a press its vocabulary does not declare, and says so once', () => {
    const f = makeFacade()
    homematicFacades.set(INTEGRATION_ID, f.facade)
    const h = makeCtx()
    new HmEventEmitterDevice(h.ctx)
    f.press(1, 'PRESS_CONT')
    f.press(1, 'PRESS_CONT')
    expect(h.emitted).toHaveLength(2)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]?.extras).toMatchObject({
      tags: { deviceId: DEVICE_ID },
      meta: { eventType: 'PRESS_CONT', sourceId: '1' },
    })
  })

  it('declares the plain tokens when the CCU is not reachable', () => {
    const h = makeCtx()
    new HmEventEmitterDevice(h.ctx)
    expect(h.status()?.vocabulary).toEqual([
      { id: 'PRESS_SHORT', label: 'PRESS_SHORT' },
      { id: 'PRESS_LONG', label: 'PRESS_LONG' },
    ])
  })
})
