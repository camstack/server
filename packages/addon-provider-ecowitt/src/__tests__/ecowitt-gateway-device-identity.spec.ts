/**
 * D1059 through the device class: when the gateway's client comes up and its MAC
 * is unknown for the host it dials, the Gateway device reads it with one unicast
 * probe, stores it on the integration and declares it. No answer leaves it
 * unknown, logged once; a MAC read at another host is never declared.
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
import { type EcowittConfig, settingsToEcowittConfig } from '../config.js'
import { ecowittConnections } from '../ecowitt-client-registry.js'
import { ecowittMacReader } from '../ecowitt-gateway-mac.js'
import type { GatewayMacProbeResult } from '../ecowitt-mac-probe.js'
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

interface World {
  stored: DeviceIdentifiers | null
  readonly probed: string[]
  readonly persisted: { integrationId: string; mac: string; host: string }[]
  readonly lines: LogLine[]
  /** Every declaration the device sent. */
  readonly inputs: SetIdentifiersInput[]
}

const MAC = '00:00:5e:00:53:2a'
const OTHER_MAC = '00:00:5e:00:53:2b'

function local(settings: Record<string, unknown>): EcowittConfig {
  return settingsToEcowittConfig({ transport: 'local', ...settings })
}

/** A device wired to a fake probe; `persist` lands where the addon's does: the running connection. */
function setup(answer: (host: string) => GatewayMacProbeResult): {
  readonly device: EcowittGatewayDevice
  readonly world: World
} {
  const world: World = { stored: null, probed: [], persisted: [], lines: [], inputs: [] }
  ecowittMacReader.set({
    probe: async (host) => {
      world.probed.push(host)
      return answer(host)
    },
    persist: async (integrationId, mac, host) => {
      world.persisted.push({ integrationId, mac, host })
      const current = ecowittConnections.get(integrationId)
      if (current?.transport === 'local') {
        ecowittConnections.set(integrationId, { ...current, mac, macHost: host })
      }
    },
  })
  const setIdentifiers = {
    mutate: async (input: SetIdentifiersInput) => {
      world.inputs.push(input)
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  const device = new EcowittGatewayDevice(rig(setIdentifiers, recordingLogger(world.lines)))
  return { device, world }
}

async function connect(device: EcowittGatewayDevice): Promise<void> {
  device.markOnline(false)
  device.markOnline(true)
  await new Promise((r) => setTimeout(r, 0))
}

describe('EcowittGatewayDevice reads and declares its MAC on connect (D1059)', () => {
  afterEach(() => {
    ecowittConnections.clear()
    ecowittMacReader.set(null)
  })

  it('a probe that answers: the MAC is stored for the host and declared', async () => {
    ecowittConnections.set('e1', local({ host: '192.0.2.7' }))
    const { device, world } = setup(() => ({ ok: true, mac: '00-00-5E-00-53-2A' }))
    await device.onActivate()
    await connect(device)
    await vi.waitFor(() => expect(world.stored?.mac?.[0]?.value).toBe(MAC))
    expect(world.probed).toEqual(['192.0.2.7'])
    expect(world.persisted).toEqual([
      { integrationId: 'e1', mac: '00-00-5E-00-53-2A', host: '192.0.2.7' },
    ])
    expect(world.stored?.ip?.value).toBe('192.0.2.7')

    // The MAC is current for the host: the next connect does not probe again.
    await connect(device)
    expect(world.probed).toEqual(['192.0.2.7'])
  })

  it('no answer: the MAC stays unknown, logged once with the device id; each connect asks once', async () => {
    ecowittConnections.set('e1', local({ host: '192.0.2.7' }))
    const { device, world } = setup(() => ({ ok: false, reason: 'no answer within 1500 ms' }))
    await device.onActivate()
    await connect(device)
    await connect(device)
    await vi.waitFor(() => expect(world.probed).toEqual(['192.0.2.7', '192.0.2.7']))
    expect(world.persisted).toEqual([])
    expect(world.stored?.mac).toBeUndefined()
    expect(world.stored?.ip?.value).toBe('192.0.2.7')
    expect(world.lines.filter((l) => l.msg.startsWith('ecowitt gateway MAC unknown'))).toEqual([
      { msg: 'ecowitt gateway MAC unknown — not declared', deviceId: 21 },
    ])
  })

  it('host change: the old MAC is not declared for the new host, then the re-read is', async () => {
    ecowittConnections.set('e1', local({ host: '192.0.2.7', mac: MAC, macHost: '192.0.2.7' }))
    let reachable = false
    const { device, world } = setup(() =>
      reachable ? { ok: true, mac: OTHER_MAC } : { ok: false, reason: 'no answer within 1500 ms' },
    )
    await device.onActivate()
    await connect(device)
    await vi.waitFor(() => expect(world.stored?.mac?.[0]?.value).toBe(MAC))
    expect(world.probed).toEqual([])

    // The operator points the integration at another gateway; it does not answer yet.
    ecowittConnections.set('e1', local({ host: '192.0.2.8', mac: MAC, macHost: '192.0.2.7' }))
    await connect(device)
    await vi.waitFor(() => expect(world.stored?.ip?.value).toBe('192.0.2.8'))
    expect(world.probed).toEqual(['192.0.2.8'])
    const forNewHost = world.inputs.at(-1)
    expect(forNewHost?.identifiers?.mac).toBeUndefined()
    expect(forNewHost?.unread).toEqual(['mac'])

    reachable = true
    await connect(device)
    await vi.waitFor(() => expect(world.stored?.mac?.[0]?.value).toBe(OTHER_MAC))
    expect(world.persisted).toEqual([{ integrationId: 'e1', mac: OTHER_MAC, host: '192.0.2.8' }])
  })
})
