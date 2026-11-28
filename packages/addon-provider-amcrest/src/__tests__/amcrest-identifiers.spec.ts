/**
 * D1059: an Amcrest camera declares its `getSystemInfo` serial, the MAC of the
 * interface serving its host, and the host itself (weak). A read that failed
 * keeps the stored value (D49). The writer stores what
 * `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { type AmcrestIdentityRead, amcrestIdentifiers } from '../amcrest-identifiers.js'

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

async function declare(world: StoredWorld, read: AmcrestIdentityRead): Promise<void> {
  const { identifiers, unread } = amcrestIdentifiers(read)
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 51, logger: quiet, writer }, identifiers, { unread })
}

describe('amcrestIdentifiers', () => {
  it('declares the vendor-prefixed serial, the MAC and the host IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, {
      serialNumber: 'AMC0123456789',
      mac: '9C:8E:CD:00:00:01',
      host: '192.0.2.40',
      channel: 1,
    })
    expect(world.stored?.serial?.value).toBe('amcrest:amc0123456789')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['9c:8e:cd:00:00:01'])
    expect(world.stored?.ip?.value).toBe('192.0.2.40')
  })

  it('a failed MAC read and a serial-less answer keep the stored values', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, {
      serialNumber: 'AMC0123456789',
      mac: '9C:8E:CD:00:00:01',
      host: '192.0.2.40',
      channel: 1,
    })
    await declare(world, { serialNumber: null, mac: null, host: '192.0.2.40', channel: 1 })
    expect(world.stored?.serial?.value).toBe('amcrest:amc0123456789')
    expect(world.stored?.mac?.[0]?.value).toBe('9c:8e:cd:00:00:01')
  })

  it("a recorder channel past the first declares no serial or MAC: they are the recorder's, shared by every channel", async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, {
      serialNumber: 'NVR0123456789',
      mac: '9C:8E:CD:00:00:02',
      host: '192.0.2.41',
      channel: 1,
    })
    await declare(world, {
      serialNumber: 'NVR0123456789',
      mac: '9C:8E:CD:00:00:02',
      host: '192.0.2.41',
      channel: 3,
    })
    expect(world.stored?.serial).toBeUndefined()
    expect(world.stored?.mac).toBeUndefined()
    expect(world.stored?.ip?.value).toBe('192.0.2.41')
  })
})
