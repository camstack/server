/**
 * D1059: a Dreame robot declares the Dreame cloud device id (`did`) as a `vendor-uid`. A blank id
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
import { dreameIdentifiers } from '../dreame-identifiers.js'

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
  const declaration = dreameIdentifiers(cloudId)
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

describe('dreameIdentifiers', () => {
  it('declares the cloud device id as a vendor uid', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, '1234567890')
    expect(world.stored?.['vendor-uid']?.value).toBe('dreame:1234567890')
  })

  it('a blank id declares nothing, so the stored vendor uid stays', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, '1234567890')
    await declare(world, '  ')
    expect(dreameIdentifiers('  ')).toBeNull()
    expect(world.stored?.['vendor-uid']?.value).toBe('dreame:1234567890')
  })
})
