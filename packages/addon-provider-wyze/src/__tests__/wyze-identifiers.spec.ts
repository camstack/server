/**
 * D1059: a Wyze camera declares its hardware MAC (strong) and its last-known
 * LAN IP (weak). A camera whose address the cloud never reported keeps the
 * stored IP (D49). The writer stores what `device-manager.setIdentifiers`
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
import { type WyzeIdentityRead, wyzeIdentifiers } from '../wyze-identifiers.js'

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

async function declare(world: StoredWorld, read: WyzeIdentityRead): Promise<void> {
  const declaration = wyzeIdentifiers(read)
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 81, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

describe('wyzeIdentifiers', () => {
  it('declares the hardware MAC and the LAN IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { mac: '2CAA8E0A0B0C', ip: '192.0.2.40' })
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['2c:aa:8e:0a:0b:0c'])
    expect(world.stored?.ip?.value).toBe('192.0.2.40')
  })

  it('a camera whose address the cloud did not report keeps the stored IP and MAC', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { mac: '2CAA8E0A0B0C', ip: '192.0.2.40' })
    await declare(world, { mac: '', ip: '' })
    expect(world.stored?.ip?.value).toBe('192.0.2.40')
    expect(world.stored?.mac?.[0]?.value).toBe('2c:aa:8e:0a:0b:0c')
  })
})
