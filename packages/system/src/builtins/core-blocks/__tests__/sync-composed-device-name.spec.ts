import { COMPOSER_ADDON_ID, composedDeviceStableId } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { recordingLogger } from '../../composer/__tests__/fixtures.js'
import {
  type ComposedDeviceNamePort,
  writeComposedDeviceName,
} from '../sync-composed-device-name.js'

function port(over: Partial<ComposedDeviceNamePort> = {}): ComposedDeviceNamePort {
  return {
    listPersistedByAddon: async () => [
      { id: 1900, stableId: composedDeviceStableId('b1'), name: 'Room' },
    ],
    setOperatorName: async () => undefined,
    ...over,
  }
}

describe('writeComposedDeviceName', () => {
  it('writes the editor name through setName for the composed row', async () => {
    const writes: Array<{ deviceId: number; name: string }> = []
    const listed: string[] = []
    await writeComposedDeviceName(
      port({
        listPersistedByAddon: async (addonId) => {
          listed.push(addonId)
          return [{ id: 1900, stableId: composedDeviceStableId('b1'), name: 'Room' }]
        },
        setOperatorName: async (deviceId, name) => {
          writes.push({ deviceId, name })
        },
      }),
      recordingLogger().logger,
      'b1',
      'Garden',
    )
    expect(listed).toEqual([COMPOSER_ADDON_ID])
    expect(writes).toEqual([{ deviceId: 1900, name: 'Garden' }])
  })

  it('does nothing when the row already has the block name', async () => {
    const writes: string[] = []
    await writeComposedDeviceName(
      port({
        listPersistedByAddon: async () => [
          { id: 1900, stableId: composedDeviceStableId('b1'), name: 'Garden' },
        ],
        setOperatorName: async (_deviceId, name) => {
          writes.push(name)
        },
      }),
      recordingLogger().logger,
      'b1',
      'Garden',
    )
    expect(writes).toEqual([])
  })

  it('logs a missing row and does not throw', async () => {
    const log = recordingLogger()
    await writeComposedDeviceName(
      port({ listPersistedByAddon: async () => [] }),
      log.logger,
      'b1',
      'Garden',
    )
    expect(log.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('device row was not found'),
          extras: expect.objectContaining({ meta: expect.objectContaining({ blockId: 'b1' }) }),
        }),
      ]),
    )
  })

  it('logs a failed device write with the device id and does not throw', async () => {
    const log = recordingLogger()
    await writeComposedDeviceName(
      port({
        setOperatorName: async () => {
          throw new Error('device row locked')
        },
      }),
      log.logger,
      'b1',
      'Garden',
    )
    expect(log.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          message: expect.stringContaining('device name was not written'),
          extras: expect.objectContaining({
            tags: { deviceId: 1900 },
            meta: expect.objectContaining({ blockId: 'b1', error: 'device row locked' }),
          }),
        }),
      ]),
    )
  })
})
