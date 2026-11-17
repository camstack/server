/**
 * D1059 / D49: a boot whose network read THROWS must not erase the MAC and IP an
 * earlier boot declared. The populator marks those kinds `unread`; the writer here
 * stores what `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */

import {
  mergeIdentifiers,
  type DeviceContext,
  type DeviceIdentifiers,
  type IScopedLogger,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  HikvisionIsapiClient,
  type HikvisionDeviceInfo,
  type HikvisionNetworkInterfaceInfo,
} from '../hikvision-isapi-client.js'
import { populateHikvisionMetadata } from '../metadata-populator.js'

const DEVICE_INFO: HikvisionDeviceInfo = {
  deviceName: 'porch',
  deviceType: 'IPCamera',
  model: 'DS-2CD2387G2',
  serialNumber: 'DS-2CD2387G2-SN42',
  firmwareVersion: 'V5.7.3',
  firmwareReleasedDate: null,
  firmwareVersionInfo: null,
  hardwareVersion: null,
  raw: '',
}

const NETWORK: HikvisionNetworkInterfaceInfo = {
  mac: 'AA:BB:CC:DD:EE:42',
  ip: '192.0.2.42',
  subnetMask: null,
  defaultGateway: null,
  addressingType: null,
  speed: null,
  mtu: null,
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface StoredWorld {
  stored: DeviceIdentifiers | null
}

function makeTarget(world: StoredWorld) {
  const api = {
    deviceManager: {
      setMetadata: { mutate: vi.fn(async () => {}) },
      setIdentifiers: {
        mutate: async (input: SetIdentifiersInput) => {
          world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
        },
      },
    },
  }
  // The populator touches only `logger` and `api.deviceManager` of the device context.
  const ctx = { logger: makeLogger(), api } as unknown as DeviceContext
  return { id: 42, ctx, setDeviceCachePatch: vi.fn(async () => {}) }
}

function makeIsapi(network: () => Promise<HikvisionNetworkInterfaceInfo>): HikvisionIsapiClient {
  const isapi = new HikvisionIsapiClient({
    host: '192.0.2.42',
    port: 80,
    https: false,
    username: 'u',
    password: 'p',
  })
  vi.spyOn(isapi, 'getDeviceInfo').mockResolvedValue(DEVICE_INFO)
  vi.spyOn(isapi, 'getNetworkInterfaceInfo').mockImplementation(network)
  return isapi
}

describe('populateHikvisionMetadata — identifiers across boots', () => {
  it('keeps the stored MAC and IP when the network read throws', async () => {
    const world: StoredWorld = { stored: null }
    const target = makeTarget(world)

    await populateHikvisionMetadata(
      makeIsapi(async () => NETWORK),
      target,
    )
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['aa:bb:cc:dd:ee:42'])

    await populateHikvisionMetadata(
      makeIsapi(async () => {
        throw new Error('ISAPI 503')
      }),
      target,
    )
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['aa:bb:cc:dd:ee:42'])
    expect(world.stored?.ip?.value).toBe('192.0.2.42')
    expect(world.stored?.serial?.value).toBe('hikvision:ds-2cd2387g2-sn42')
  })

  it('removes the MAC when the network read answered without one', async () => {
    const world: StoredWorld = { stored: null }
    const target = makeTarget(world)
    await populateHikvisionMetadata(
      makeIsapi(async () => NETWORK),
      target,
    )
    await populateHikvisionMetadata(
      makeIsapi(async () => ({ ...NETWORK, mac: null })),
      target,
    )
    expect(world.stored?.mac).toBeUndefined()
    expect(world.stored?.ip?.value).toBe('192.0.2.42')
  })
})
