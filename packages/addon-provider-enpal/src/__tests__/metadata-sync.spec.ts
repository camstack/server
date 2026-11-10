/**
 * The identity facts a piece reports (model, serial, firmware) become device attributes: the
 * Gateway writes the box's, a Container its own. A poll that changed nothing writes nothing.
 */
import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { EnpalMetadataSync } from '../devices/enpal-metadata-sync.js'
import { ENPAL_BOX_ID } from '../enpal-equipment.js'
import type { EnpalSnapshot } from '../enpal-snapshot.js'

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: vi.fn(),
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function snapshot(texts: Record<string, string>): EnpalSnapshot {
  return {
    source: 'blazor',
    readings: new Map(),
    texts: new Map(Object.entries(texts)),
    fetchedAt: 0,
  }
}

describe('EnpalMetadataSync', () => {
  it('writes the box serial and modem firmware on the Gateway, once per change', async () => {
    let current: EnpalSnapshot | null = snapshot({
      'IoTEdgeDevice.SerialNumber': '0042',
      'LTE.Modem.Firmware.Version': '1.2',
    })
    const write = vi.fn(async () => undefined)
    const sync = new EnpalMetadataSync({
      equipment: ENPAL_BOX_ID,
      deviceId: 7,
      getSnapshot: () => current,
      write,
      logger: quiet,
    })
    await sync.apply()
    await sync.apply()
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith({ serialNumber: '0042', modemFirmware: '1.2' })
    current = null
    await sync.apply()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('a failed write is logged with the device id and retried on the next poll', async () => {
    const write = vi.fn(async () => {
      throw new Error('down')
    })
    const sync = new EnpalMetadataSync({
      equipment: ENPAL_BOX_ID,
      deviceId: 7,
      getSnapshot: () => snapshot({ 'IoTEdgeDevice.SerialNumber': '1' }),
      write,
      logger: quiet,
    })
    await sync.apply()
    await sync.apply()
    expect(write).toHaveBeenCalledTimes(2)
    expect(quiet.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: { deviceId: 7 } }),
    )
  })
})
