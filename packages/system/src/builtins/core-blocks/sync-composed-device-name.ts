/**
 * An operator rename in the composition editor writes the composed device's
 * name as well, stamped, so the row and the block agree. The device is the
 * row whose stable id is `composed-<blockId>` under the composer addon.
 * A failure is logged and swallowed: the block save has already landed, and
 * the composer's next apply retries the device write.
 */
import {
  COMPOSER_ADDON_ID,
  composedDeviceStableId,
  errMsg,
  type IScopedLogger,
} from '@camstack/types'

export interface ComposedDeviceNameRow {
  readonly id: number
  readonly stableId: string
  readonly name: string
}

/** The device-manager calls this needs. `setOperatorName` stamps `userNamed`. */
export interface ComposedDeviceNamePort {
  listPersistedByAddon(addonId: string): Promise<readonly ComposedDeviceNameRow[]>
  setOperatorName(deviceId: number, name: string): Promise<void>
}

export async function writeComposedDeviceName(
  port: ComposedDeviceNamePort,
  logger: IScopedLogger,
  blockId: string,
  name: string,
): Promise<void> {
  const stableId = composedDeviceStableId(blockId)
  let deviceId: number | null = null
  try {
    const rows = await port.listPersistedByAddon(COMPOSER_ADDON_ID)
    const row = rows.find((candidate) => candidate.stableId === stableId)
    if (row === undefined) {
      logger.warn(
        'composed block was renamed but its device row was not found — retried on the next apply',
        { meta: { blockId, stableId } },
      )
      return
    }
    deviceId = row.id
    if (row.name === name) return
    await port.setOperatorName(row.id, name)
  } catch (err: unknown) {
    logger.warn(
      'composed block was renamed but the device name was not written — retried on the next apply',
      {
        ...(deviceId === null ? {} : { tags: { deviceId } }),
        meta: { blockId, error: errMsg(err) },
      },
    )
  }
}
