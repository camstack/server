/**
 * A Homematic device's own faults, from its MAINTENANCE channel, on the `error`
 * cap of its container: cold until a service flag has a value, then driven by
 * the CCU's value events, and never declared by a device with no MAINTENANCE.
 */
import { type DeviceContext, DeviceType, type IDeviceRuntimeState } from '@dominevo/types'
import type { HmDevice, Homematic, ValueChangedEvent } from 'nodehomematic'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HmContainerDevice } from '../devices/hm-container-device.js'
import { homematicFacades } from '../homematic-facade-resolver.js'
import { hmDataPoint, hmDevice } from './hm-test-fixtures.js'
import { RecordingLogger } from './recording-logger.js'

const INT = 'hm_001'
const ADDRESS = '00315F298E5A18'

interface Rig {
  readonly ctx: DeviceContext
  readonly declared: string[]
  readonly logger: RecordingLogger
  readonly slice: () => unknown
}

function rig(): Rig {
  let runtime: IDeviceRuntimeState | null = null
  const declared: string[] = []
  const logger = new RecordingLogger()
  // A DeviceContext is the kernel's own object; the spec supplies only what the container reads.
  const ctx = {
    id: 9,
    stableId: `hm:${INT}:${ADDRESS}`,
    parentDeviceId: null,
    deviceMeta: {
      id: 9,
      stableId: `hm:${INT}:${ADDRESS}`,
      addonId: 'provider-homematic',
      type: DeviceType.Container,
      name: 'Valve',
      location: null,
      disabled: false,
      parentDeviceId: null,
      metadata: null,
    },
    persistedConfig: { address: ADDRESS, integrationId: INT },
    initialRuntimeState: {},
    eventBus: { emit: () => {}, subscribe: () => () => {}, getRecent: () => [] },
    persistConfig: async () => {},
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtime = rs
    },
    registerNativeCap: (cap: { name: string; runtimeState?: unknown }) => {
      declared.push(cap.name)
      if (cap.runtimeState && runtime) {
        runtime.installCapSchema(
          cap.name,
          cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
        )
      }
    },
    api: { deviceManager: {}, alerts: undefined },
    logger,
  } as unknown as DeviceContext
  return { ctx, declared, logger, slice: () => runtime?.getCapState('error') }
}

type Handler = (event: ValueChangedEvent) => void

function publishDevice(device: HmDevice | null): Handler {
  const handlers: Handler[] = []
  const stub = {
    devices: () => (device === null ? [] : [device]),
    customEntities: () => [],
    on: (name: string, handler: Handler) => {
      if (name === 'valueChanged') handlers.push(handler)
      return () => undefined
    },
  }
  homematicFacades.set(INT, stub as unknown as Homematic)
  return (event) => {
    for (const handler of handlers) handler(event)
  }
}

function maintenance(values: Record<string, boolean | null>): HmDevice {
  return hmDevice({
    address: ADDRESS,
    type: 'HmIP-eTRV',
    channels: [
      {
        address: `${ADDRESS}:0`,
        index: 0,
        type: 'MAINTENANCE',
        dataPoints: Object.entries(values).map(([parameter, value]) =>
          hmDataPoint({ parameter, type: 'BOOL', value }),
        ),
      },
    ],
  })
}

function event(parameter: string, value: boolean, device = ADDRESS): ValueChangedEvent {
  return {
    dpId: `dp:${parameter.toLowerCase()}`,
    device,
    channel: `${device}:0`,
    parameter,
    value,
    prevValue: !value,
    ts: 1_786_260_613_643,
  }
}

afterEach(() => {
  homematicFacades.clear()
})

describe('HmContainerDevice error cap', () => {
  it('declares the cap and stays unknown while the flags have no value', () => {
    publishDevice(maintenance({ UNREACH: null, LOW_BAT: null }))
    const r = rig()
    new HmContainerDevice(r.ctx)
    expect(r.declared).toContain('error')
    expect(r.slice()).toMatchObject({ active: null, code: null })
  })

  it('publishes the faults the snapshot already carries', () => {
    publishDevice(maintenance({ UNREACH: false, LOW_BAT: true }))
    const r = rig()
    new HmContainerDevice(r.ctx)
    expect(r.slice()).toMatchObject({ active: true, code: 'LOW_BAT', severity: 'warning' })
  })

  it('follows the CCU events: raised, ranked, then cleared', async () => {
    const emit = publishDevice(maintenance({ UNREACH: false, LOW_BAT: false }))
    const r = rig()
    new HmContainerDevice(r.ctx)
    expect(r.slice()).toMatchObject({ active: false })
    emit(event('LOW_BAT', true))
    emit(event('UNREACH', true))
    await vi.waitFor(() =>
      expect(r.slice()).toMatchObject({
        active: true,
        code: 'UNREACH',
        faults: [{ code: 'UNREACH' }, { code: 'LOW_BAT' }],
      }),
    )
    emit(event('UNREACH', false))
    emit(event('LOW_BAT', false))
    await vi.waitFor(() => expect(r.slice()).toMatchObject({ active: false, code: null }))
  })

  it('ignores the events of another device and of other channels', async () => {
    const emit = publishDevice(maintenance({ UNREACH: false }))
    const r = rig()
    new HmContainerDevice(r.ctx)
    emit(event('UNREACH', true, '00000000000001'))
    emit({ ...event('UNREACH', true), channel: `${ADDRESS}:1` })
    await Promise.resolve()
    expect(r.slice()).toMatchObject({ active: false })
  })

  it('declares no error cap for a device without a MAINTENANCE channel', () => {
    publishDevice(hmDevice({ address: ADDRESS, type: 'HmIP-BRC2', channels: [] }))
    const r = rig()
    new HmContainerDevice(r.ctx)
    expect(r.declared).not.toContain('error')
  })
})
