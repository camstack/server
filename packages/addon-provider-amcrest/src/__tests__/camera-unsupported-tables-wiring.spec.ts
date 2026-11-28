/**
 * The CAMERA's wiring of the unsupported-table fallback (the reader itself is
 * pinned in `dahua-unsupported-tables.spec.ts`): a real `AmcrestCamera`, a real
 * CGI client, and a local HTTP server that answers like a Dahua Lite model —
 * HTTP 400 for any `getConfig` that names `Lighting` or `VideoInBacklight`.
 */
import { createServer, type Server } from 'node:http'

import {
  type DeviceContext,
  DeviceType,
  type IDeviceRuntimeState,
  type InferNativeProvider,
  imageSettingsCapability,
} from '@dominevo/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AmcrestCamera } from '../amcrest-camera.js'
import type { AmcrestExtrasSnapshot } from '../extra-settings.js'

const MISSING = new Set(['Lighting', 'VideoInBacklight'])
const TABLES: Readonly<Record<string, string>> = {
  LightGlobal: 'table.LightGlobal[0].Enable=true\r\n',
  NTP: 'table.NTP.Enable=true\r\ntable.NTP.Address=pool.ntp.org\r\n',
  AutoMaintain: 'table.AutoMaintain.AutoRebootEnable=false\r\n',
}

interface Harness {
  readonly camera: AmcrestCamera
  readonly requests: string[]
  readonly persisted: () => Record<string, unknown>
  readonly server: Server
  readonly registered: (cap: 'image-settings') => ImageSettingsProvider
}

type ImageSettingsProvider = InferNativeProvider<typeof imageSettingsCapability>

async function harness(): Promise<Harness> {
  const requests: string[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://camera')
    requests.push(`${url.pathname}${url.search}`)
    const names = url.searchParams.getAll('name')
    if (names.some((name) => MISSING.has(name))) {
      res.statusCode = 400
      res.end('Bad Request!')
      return
    }
    res.end(names.map((name) => TABLES[name] ?? '').join(''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no TCP port')

  let config: Record<string, unknown> = {
    host: '127.0.0.1',
    port: address.port,
    https: false,
    username: 'admin',
    password: 'x',
    channel: 1,
  }
  let runtime: IDeviceRuntimeState | null = null
  // A DeviceContext is the kernel's own object; the spec supplies only what the
  // camera's constructor and the paths under test read (same boundary as the
  // Gree device specs).
  const ctx = {
    id: 3901,
    stableId: 'amcrest-lite',
    parentDeviceId: null,
    deviceMeta: {
      type: DeviceType.Camera,
      name: 'Lite',
      location: null,
      disabled: false,
      addonId: 'provider-amcrest',
      metadata: {},
    },
    persistedConfig: config,
    initialRuntimeState: {},
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => {}), getRecent: vi.fn(() => []) },
    persistConfig: vi.fn(async (next: Record<string, unknown>) => {
      config = { ...config, ...next }
    }),
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
    api: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
      withTags: vi.fn(),
    },
  } as unknown as DeviceContext
  const camera = new AmcrestCamera(ctx)
  const registered = (name: 'image-settings'): ImageSettingsProvider => {
    const call = vi.mocked(ctx.registerNativeCap).mock.calls.find(([cap]) => cap.name === name)
    if (call === undefined) throw new Error(`${name} not registered`)
    return call[1] as ImageSettingsProvider
  }
  return { camera, requests, persisted: () => config, server, registered }
}

/** The camera's private refresh — the path `onActivate` and the form open take. */
async function refreshExtras(camera: AmcrestCamera): Promise<void> {
  await camera['refreshExtrasSnapshot']()
}

function extrasOf(camera: AmcrestCamera): AmcrestExtrasSnapshot | undefined {
  return camera['config'].get('deviceCache')?.extras
}

const BATCH =
  '/cgi-bin/configManager.cgi?action=getConfig&name=Lighting&name=LightGlobal&name=NTP&name=AutoMaintain'
const SUPPORTED_BATCH =
  '/cgi-bin/configManager.cgi?action=getConfig&name=LightGlobal&name=NTP&name=AutoMaintain'

let open: Server | null = null
afterEach(async () => {
  const server = open
  open = null
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('AmcrestCamera on a model without some config tables', () => {
  it('a 400 batch still fills the extras snapshot from the tables that answer', async () => {
    const h = await harness()
    open = h.server
    await refreshExtras(h.camera)
    const extras = extrasOf(h.camera)
    expect(extras?.statusLedEnabled).toBe(true)
    expect(extras?.ntpServer).toBe('pool.ntp.org')
    expect(extras?.unsupportedTables).toEqual(['Lighting'])
    expect(h.requests[0]).toBe(BATCH)
  })

  it('the next refresh batches only the supported tables', async () => {
    const h = await harness()
    open = h.server
    await refreshExtras(h.camera)
    h.requests.length = 0
    await refreshExtras(h.camera)
    expect(h.requests).toEqual([SUPPORTED_BATCH])
  })

  it('going offline forgets the probe — the next read asks for every table again', async () => {
    const h = await harness()
    open = h.server
    await refreshExtras(h.camera)
    h.camera['onReachabilityChange'](false)
    h.requests.length = 0
    await refreshExtras(h.camera)
    expect(h.requests[0]).toBe(BATCH)
  })

  it('a connection patch forgets the probe too', async () => {
    const h = await harness()
    open = h.server
    await refreshExtras(h.camera)
    await h.camera.applySettingsPatch({ username: 'admin2' })
    h.requests.length = 0
    await refreshExtras(h.camera)
    expect(h.requests[0]).toBe(BATCH)
  })

  it('image settings keep the other tables and stop advertising backlight', async () => {
    const h = await harness()
    open = h.server
    const provider = h.registered('image-settings')
    // `setSettings` with nothing to write is a refresh the caller awaits.
    await provider.setSettings({ deviceId: 3901, settings: {} })
    expect(h.requests[0]).toContain('name=VideoInBacklight')
    const options = await provider.getOptions({ deviceId: 3901 })
    expect(options.backlightModes).toEqual([])
    expect(options.supportsBrightness).toBe(true)
  })
})
