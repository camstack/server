/**
 * D1059: a Gree AC declares the MAC its bind answered with (strong) and its
 * last-known LAN IP (weak). An AC whose address was never learnt keeps the
 * stored IP (D49). The writer stores what `device-manager.setIdentifiers`
 * would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type GreeIdentityRead, greeIdentifiers } from '../gree-identifiers.js'

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

async function declare(world: StoredWorld, read: GreeIdentityRead): Promise<void> {
  const declaration = greeIdentifiers(read)
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 71, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

describe('greeIdentifiers', () => {
  it('declares the bound MAC (colon-less, as Gree reports it) and the LAN IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { mac: 'f4911e0a0b0c', ip: '192.0.2.30' })
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['f4:91:1e:0a:0b:0c'])
    expect(world.stored?.ip?.value).toBe('192.0.2.30')
  })

  it('an AC whose address was never learnt keeps the stored IP', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, { mac: 'f4911e0a0b0c', ip: '192.0.2.30' })
    await declare(world, { mac: 'f4911e0a0b0c', ip: undefined })
    expect(world.stored?.ip?.value).toBe('192.0.2.30')
    expect(world.stored?.mac?.[0]?.value).toBe('f4:91:1e:0a:0b:0c')
  })
})
