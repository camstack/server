/**
 * D1059: a VeSync purifier declares its cloud `cid` (`vesync:<cid>`) and the MAC
 * its device-list entry carries. No snapshot declares nothing; an entry without
 * a MAC keeps the stored one (D49). The writer stores what
 * `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type VeSyncIdentityRead, vesyncIdentifiers } from '../vesync-identifiers.js'
import { snapshotOf, type TsVeSyncFan } from '../vesync-tsvesync-client.js'

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

async function declare(world: StoredWorld, read: VeSyncIdentityRead | null): Promise<void> {
  const declaration = vesyncIdentifiers(read)
  if (declaration === null) return
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 61, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

describe('vesyncIdentifiers', () => {
  it('declares the cid as a vendor uid and the MAC', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { nativeId: 'vsaq1a2b3c', mac: 'C4:5B:BE:00:00:01' })
    expect(world.stored?.['vendor-uid']?.value).toBe('vesync:vsaq1a2b3c')
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['c4:5b:be:00:00:01'])
  })

  it('no snapshot, or an entry without a MAC, keeps the stored MAC', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { nativeId: 'vsaq1a2b3c', mac: 'C4:5B:BE:00:00:01' })
    await declare(world, null)
    await declare(world, { nativeId: 'vsaq1a2b3c' })
    expect(world.stored?.mac?.[0]?.value).toBe('c4:5b:be:00:00:01')
    expect(world.stored?.['vendor-uid']?.value).toBe('vesync:vsaq1a2b3c')
  })
})

describe('snapshotOf', () => {
  it('carries the library macId, and none when it is blank', () => {
    const fan = (macId: string): TsVeSyncFan => ({
      cid: 'vsaq1a2b3c',
      macId,
      deviceName: 'Bedroom',
      deviceType: 'Core300S',
      deviceStatus: 'on',
      connectionStatus: 'online',
      mode: 'manual',
      speed: 1,
      filterLife: 90,
      screenStatus: 'on',
      childLock: false,
      airQualityValue: 1,
      getMaxFanSpeed: () => 3,
      getSupportedModes: () => ['manual'],
      hasFeature: () => true,
      getDetails: async () => ({}),
      turnOn: async () => true,
      turnOff: async () => true,
      changeFanSpeed: async () => true,
      setMode: async () => true,
    })
    expect(snapshotOf(fan('c4:5b:be:00:00:01')).mac).toBe('c4:5b:be:00:00:01')
    expect(snapshotOf(fan('')).mac).toBeUndefined()
  })
})
