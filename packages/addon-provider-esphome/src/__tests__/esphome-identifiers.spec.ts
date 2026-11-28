/**
 * D1059: an ESPHome board declares the MAC its DeviceInfo reports, and its node
 * name (the board's mDNS hostname, weak). A board that is not connected declares
 * nothing, and one whose DeviceInfo carries no MAC keeps the stored MAC (D49).
 * The writer stores what `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */
import {
  declareDeviceIdentifiers,
  type DeviceIdentifiers,
  type IScopedLogger,
  mergeIdentifiers,
  type SetIdentifiersInput,
} from '@dominevo/types'
import { describe, expect, it } from 'vitest'
import { espBoardIdentifiers } from '../esphome-identifiers.js'
import type { EspBoardInfo } from '../esphome-link.js'

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

async function declare(world: StoredWorld, info: EspBoardInfo | null): Promise<void> {
  const declaration = espBoardIdentifiers(info)
  if (declaration === null) return
  const writer = {
    mutate: async (input: SetIdentifiersInput) => {
      world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
    },
  }
  await declareDeviceIdentifiers({ deviceId: 31, logger: quiet, writer }, declaration.identifiers, {
    unread: declaration.unread,
  })
}

const BOARD: EspBoardInfo = {
  name: 'living-room-plug',
  friendlyName: 'Living room plug',
  model: 'esp32dev',
  manufacturer: 'Espressif',
  esphomeVersion: '2026.10.0',
  macAddress: '24:0A:C4:00:00:01',
  encrypted: true,
}

describe('espBoardIdentifiers', () => {
  it('declares the board MAC and its node name as hostname', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, BOARD)
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['24:0a:c4:00:00:01'])
    expect(world.stored?.hostname?.value).toBe('living-room-plug')
  })

  it('a board that is not connected declares nothing: the stored MAC stays', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, BOARD)
    await declare(world, null)
    expect(world.stored?.mac?.[0]?.value).toBe('24:0a:c4:00:00:01')
  })

  it('a DeviceInfo without a MAC keeps the stored one', async () => {
    const world: StoredWorld = { stored: null }
    await declare(world, BOARD)
    await declare(world, { ...BOARD, macAddress: '' })
    expect(world.stored?.mac?.[0]?.value).toBe('24:0a:c4:00:00:01')
  })
})
