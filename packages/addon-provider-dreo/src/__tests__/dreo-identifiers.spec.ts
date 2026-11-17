/**
 * D1059: a Dreo appliance declares the Dreo cloud device id as a `vendor-uid`. A blank id
 * declares nothing, so the stored value survives (D49). The writer stores what
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
import { dreoIdentifiers } from '../dreo-identifiers.js'

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
  const declaration = dreoIdentifiers(cloudId)
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

describe('dreoIdentifiers', () => {
  it('declares the cloud device id as a vendor uid', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, 'HTJ0A1B2C3D4E5F6')
    expect(world.stored?.['vendor-uid']?.value).toBe('dreo:htj0a1b2c3d4e5f6')
  })

  it('a blank id declares nothing, so the stored vendor uid stays', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, 'HTJ0A1B2C3D4E5F6')
    await declare(world, '  ')
    expect(dreoIdentifiers('  ')).toBeNull()
    expect(world.stored?.['vendor-uid']?.value).toBe('dreo:htj0a1b2c3d4e5f6')
  })
})
