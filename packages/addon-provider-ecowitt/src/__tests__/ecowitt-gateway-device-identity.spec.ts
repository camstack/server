/**
 * D1059 through the device class: the Ecowitt Gateway device declares the MAC the
 * scan carried into its integration's connection, on activation and when the
 * gateway's client comes up; a connection without a MAC keeps the stored one.
 */
import {
  type DeviceContext,
  type DeviceIdentifiers,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { settingsToEcowittConfig } from '../config.js'
import { ecowittConnections } from '../ecowitt-client-registry.js'
import {
  ECOWITT_GATEWAY_DEVICE_KIND,
  EcowittGatewayDevice,
} from '../devices/ecowitt-gateway-device.js'

interface LogLine {
  readonly msg: string
  readonly deviceId: unknown
}

function recordingLogger(lines: LogLine[]): IScopedLogger {
  const push = (msg: string, ctx?: { tags?: Record<string, unknown> }): void => {
    lines.push({ msg, deviceId: ctx?.tags?.['deviceId'] })
  }
  const logger: IScopedLogger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    child: () => logger,
    withTags: () => logger,
  }
  return logger
}

function rig(setIdentifiers: object, logger: IScopedLogger): DeviceContext {
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the device reads.
  return {
    id: 21,
    stableId: 'ecowitt:192-0-2-7:gateway',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Gateway,
      name: 'GW2000A',
      location: null,
      disabled: false,
      addonId: 'provider-ecowitt',
      metadata: {},
    },
    persistedConfig: {
      kind: ECOWITT_GATEWAY_DEVICE_KIND,
      integrationId: 'e1',
      gatewayId: 'ecowitt:192-0-2-7',
    },
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
    api: { deviceManager: { setIdentifiers } },
    logger,
  } as unknown as DeviceContext
}

describe('EcowittGatewayDevice declares its identity (D1059)', () => {
  afterEach(() => ecowittConnections.clear())

  it('declares the scanned MAC; a connection without one keeps it and logs the reason once', async () => {
    const world: { stored: DeviceIdentifiers | null; calls: number } = { stored: null, calls: 0 }
    const setIdentifiers = {
      mutate: async (input: SetIdentifiersInput) => {
        world.calls += 1
        world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
      },
    }
    const lines: LogLine[] = []
    ecowittConnections.set(
      'e1',
      settingsToEcowittConfig({ transport: 'local', host: '192.0.2.7', mac: '00:00:5E:00:53:2A' }),
    )
    const device = new EcowittGatewayDevice(rig(setIdentifiers, recordingLogger(lines)))
    await device.onActivate()
    await vi.waitFor(() => expect(world.stored?.mac?.[0]?.value).toBe('00:00:5e:00:53:2a'))
    expect(world.stored?.ip?.value).toBe('192.0.2.7')

    // The same declaration on reconnect is not re-sent.
    const before = world.calls
    device.markOnline(false)
    device.markOnline(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(world.calls).toBe(before)

    // The operator edits the integration by hand: the MAC is no longer known to it.
    ecowittConnections.set('e1', settingsToEcowittConfig({ transport: 'local', host: '192.0.2.8' }))
    device.markOnline(false)
    device.markOnline(true)
    device.markOnline(false)
    device.markOnline(true)
    await vi.waitFor(() => expect(world.stored?.ip?.value).toBe('192.0.2.8'))
    expect(world.stored?.mac?.[0]?.value).toBe('00:00:5e:00:53:2a')
    const unknown = lines.filter((l) => l.msg.startsWith('ecowitt gateway MAC unknown'))
    expect(unknown).toEqual([
      {
        msg: 'ecowitt gateway MAC unknown — set up without a LAN scan; not declared',
        deviceId: 21,
      },
    ])
  })
})
