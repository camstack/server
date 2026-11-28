/**
 * D1059 / D49: a serial number never legitimately disappears. A snapshot whose
 * attributes carry no `serialNumber` marks `serial` unread, so the stored serial
 * is kept, never removed. The writer stores what `device-manager.setIdentifiers`
 * would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { enpalIdentifiers } from '../devices/enpal-metadata-sync.js'

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

async function declare(world: StoredWorld, attributes: Record<string, string>): Promise<void> {
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  const { identifiers, unread } = enpalIdentifiers(attributes)
  await declareDeviceIdentifiers({ deviceId: 7, logger: quiet, writer }, identifiers, { unread })
}

describe('enpalIdentifiers', () => {
  it('declares the piece serial, prefixed by the vendor', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { serialNumber: 'EP-123', model: 'Box' })
    expect(world.stored?.serial?.value).toBe('enpal:ep-123')
  })

  it('keeps the stored serial when a snapshot carries none', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { serialNumber: 'EP-123', model: 'Box' })
    await declare(world, { model: 'Box', firmware: '2.0' })
    expect(world.stored?.serial?.value).toBe('enpal:ep-123')
  })
})
