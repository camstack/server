/**
 * D1059: an ONVIF camera declares its serial (prefixed by the manufacturer its
 * GetDeviceInformation reports), the MACs of its GetNetworkInterfaces answer, and
 * its host (weak). A read that failed keeps the stored value (D49). The writer
 * stores what `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type OnvifIdentityRead, onvifIdentifiers, parseOnvifMacs } from '../onvif-identifiers.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

interface StoredWorld {
  stored: DeviceIdentifiers | null
}

async function declare(world: StoredWorld, read: OnvifIdentityRead): Promise<void> {
  const { identifiers, unread } = onvifIdentifiers(read)
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 41, logger: quiet, writer }, identifiers, { unread })
}

const FULL: OnvifIdentityRead = {
  deviceInfo: {
    manufacturer: 'Acme Vision',
    serialNumber: 'AV100-0001',
  },
  macs: ['00:12:34:56:78:9A'],
  host: '192.0.2.30',
}

describe('onvifIdentifiers', () => {
  it('declares the manufacturer-prefixed serial, the interface MAC and the host IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, FULL)
    expect(world.stored?.serial?.value).toBe('acme-vision:av100-0001')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['00:12:34:56:78:9a'])
    expect(world.stored?.ip?.value).toBe('192.0.2.30')
  })

  it('failed device-information and network reads keep the stored serial and MAC', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, FULL)
    await declare(world, { deviceInfo: null, macs: null, host: '192.0.2.30' })
    expect(world.stored?.serial?.value).toBe('acme-vision:av100-0001')
    expect(world.stored?.mac?.[0]?.value).toBe('00:12:34:56:78:9a')
  })
})

describe('parseOnvifMacs', () => {
  it('reads every interface hwAddress (the library drops the array for one interface)', () => {
    expect(
      parseOnvifMacs([
        {
          $: { token: 'eth0' },
          enabled: true,
          info: { name: 'eth0', hwAddress: '00:12:34:56:78:9a' },
        },
        { info: { name: 'wlan0' } },
      ]),
    ).toEqual(['00:12:34:56:78:9a'])
    expect(parseOnvifMacs({ info: { hwAddress: '00:12:34:56:78:9b' } })).toEqual([
      '00:12:34:56:78:9b',
    ])
    expect(parseOnvifMacs('garbage')).toEqual([])
  })
})
