/**
 * D1059: a Tuya device declares the Tuya cloud device id (`devId`) as a `vendor-uid`. A blank id
 * declares nothing, so the stored value survives (D49). The writer stores what
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
import { tuyaIdentifiers } from '../tuya-identifiers.js'

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

async function declare(world: StoredWorld, cloudId: string): Promise<void> {
  const declaration = tuyaIdentifiers(cloudId)
  if (declaration === null) return
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 91, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

describe('tuyaIdentifiers', () => {
  it('declares the cloud device id as a vendor uid', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, 'bf0a1b2c3d4e5f6a7b8c9d')
    expect(world.stored?.['vendor-uid']?.value).toBe('tuya:bf0a1b2c3d4e5f6a7b8c9d')
  })

  it('a blank id declares nothing, so the stored vendor uid stays', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, 'bf0a1b2c3d4e5f6a7b8c9d')
    await declare(world, '  ')
    expect(tuyaIdentifiers('  ')).toBeNull()
    expect(world.stored?.['vendor-uid']?.value).toBe('tuya:bf0a1b2c3d4e5f6a7b8c9d')
  })
})
