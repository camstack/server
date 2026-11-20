import { describe, expect, it, vi } from 'vitest'
import { Nodedreo } from '@apocaliss92/nodedreo'
import {
  DeviceType,
  deviceStateRefreshCapability,
  type DeviceContext,
  type IDeviceRuntimeState,
  type SwitchStatus,
} from '@camstack/types'
import { dreoConnections } from '../dreo-gateway.js'
import { DreoFanDevice } from '../devices/dreo-fan-device.js'

interface Registration {
  readonly cap: { readonly name: string }
  readonly provider: {
    refresh: (input: { deviceIds: number[]; reason: string }) => Promise<unknown>
  }
  readonly options: { readonly stateRefresh?: Record<string, unknown> } | undefined
}

const INFO_ROW = {
  deviceSn: 'sn-1',
  deviceId: 'dev-1',
  model: 'DR-HAF001S',
  deviceName: 'Fan',
  online: true,
}

/** A real library facade over a fake cloud: the handle behaves exactly as in production. */
async function liveFanHandle() {
  const nodedreo = new Nodedreo(
    { token: 't', region: 'eu' },
    {},
    {
      http: {
        request: async ({ url }) => {
          if (url.includes('/device/list'))
            return { status: 200, body: { data: { list: [INFO_ROW] } } }
          return { status: 200, body: { data: { mixed: { poweron: false, windlevel: 1 } } } }
        },
      },
      wsFactory: () => {
        let open: () => void = () => undefined
        return {
          send: () => undefined,
          close: () => undefined,
          onMessage: () => undefined,
          onOpen: (cb) => {
            open = cb
            queueMicrotask(() => open())
          },
          onClose: () => undefined,
        }
      },
    },
  )
  await nodedreo.login()
  const infos = await nodedreo.discoverDevices()
  await nodedreo.connect()
  const info = infos[0]
  if (info === undefined) throw new Error('no device discovered')
  const handle = await nodedreo.createDevice(info)
  dreoConnections.set('acct-1', { infos, handles: new Map([[info.deviceId, handle]]) })
  return handle
}

function makeFan() {
  const registrations: Registration[] = []
  let runtimeStateRef: IDeviceRuntimeState | null = null
  const ctx = {
    id: 9,
    stableId: 'dreo:test:9',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Fan,
      name: 'Fan',
      location: null,
      disabled: false,
      addonId: 'provider-dreo',
      metadata: {},
    },
    persistedConfig: { dreoDeviceId: 'dev-1', brokerId: 'acct-1', model: 'DR-HAF001S' },
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async () => {}),
    bindRuntimeState: (rs: IDeviceRuntimeState) => {
      runtimeStateRef = rs
    },
    registerNativeCap: vi.fn(
      (
        cap: { name: string; runtimeState?: unknown },
        provider: Registration['provider'],
        options?: Registration['options'],
      ) => {
        registrations.push({ cap, provider, options })
        if (cap.runtimeState && runtimeStateRef) {
          runtimeStateRef.installCapSchema(
            cap.name,
            cap.runtimeState as Parameters<IDeviceRuntimeState['installCapSchema']>[1],
          )
        }
      },
    ),
    api: {
      deviceManager: {
        registerDevice: { mutate: vi.fn(async () => ({})) },
        setMetadata: { mutate: vi.fn(async () => {}) },
      },
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  const device = new DreoFanDevice(ctx)
  return {
    device,
    refreshReg: () => registrations.find((r) => r.cap.name === deviceStateRefreshCapability.name),
    power: () => device.runtimeState.getCapState<SwitchStatus>('switch')?.on,
  }
}

describe('Dreo device-state-refresh (D1062)', () => {
  it('declares push full for the account, so the core never schedules a read', async () => {
    await liveFanHandle()
    const { device, refreshReg } = makeFan()
    await device.onActivate()
    expect(refreshReg()?.options?.stateRefresh).toMatchObject({
      integrationId: 'acct-1',
      push: 'full',
      batch: false,
    })
  })

  it('a refresh re-applies the live handle state to the slice', async () => {
    const handle = await liveFanHandle()
    const { device, refreshReg, power } = makeFan()
    await device.onActivate()
    expect(power()).toBe(false)
    await device.removeDevice() // stop the push listener: only the refresh can move the slice now
    handle.ingestState({ poweron: true })
    expect(power()).toBe(false)
    await refreshReg()?.provider.refresh({ deviceIds: [9], reason: 'command' })
    expect(power()).toBe(true)
  })

  it('a refresh with no live connection fails, never a silent success', async () => {
    await liveFanHandle()
    const { device, refreshReg } = makeFan()
    await device.onActivate()
    dreoConnections.set('acct-1', null)
    await expect(
      refreshReg()?.provider.refresh({ deviceIds: [9], reason: 'schedule' }),
    ).rejects.toThrow(/cloud connection unavailable/)
  })
})
