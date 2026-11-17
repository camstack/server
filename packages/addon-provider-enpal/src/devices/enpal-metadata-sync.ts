import { errMsg, type IScopedLogger, type RawDeviceIdentifiers } from '@camstack/types'
import { findEquipment, metadataOf } from '../enpal-equipment.js'
import type { EnpalSnapshot } from '../enpal-snapshot.js'

/** What {@link EnpalMetadataSync} reads and writes through; the device supplies each. */
export interface EnpalMetadataSyncOptions {
  /** Catalog id of the piece: `box` on the Gateway, the equipment id on a Container. */
  readonly equipment: string
  readonly deviceId: number
  readonly getSnapshot: () => EnpalSnapshot | null
  readonly write: (patch: Readonly<Record<string, string>>) => Promise<void>
  readonly logger: IScopedLogger
}

/**
 * Writes the identity facts a piece reported (model, serial, firmware) as device attributes.
 * A poll that changed none writes nothing; a failed write is logged and retried next poll.
 */
export class EnpalMetadataSync {
  private applied = ''

  constructor(private readonly options: EnpalMetadataSyncOptions) {}

  async apply(): Promise<void> {
    const snapshot = this.options.getSnapshot()
    if (snapshot === null) return
    const attributes = metadataOf(findEquipment(this.options.equipment), snapshot)
    const fingerprint = JSON.stringify(attributes)
    if (fingerprint === this.applied || Object.keys(attributes).length === 0) return
    try {
      await this.options.write(attributes)
      this.applied = fingerprint
    } catch (err) {
      this.options.logger.warn('enpal: could not write the device attributes', {
        tags: { deviceId: this.options.deviceId },
        meta: { equipment: this.options.equipment, error: errMsg(err) },
      })
    }
  }
}

/**
 * The identifiers (D1059) a piece's attributes carry: its own `serialNumber`,
 * prefixed by the vendor. The serials of parts it reports about (battery,
 * dongle, gateway) belong to other objects and are not this device's identity.
 */
export function enpalIdentifiers(
  attributes: Readonly<Record<string, string>>,
): RawDeviceIdentifiers {
  const serial = attributes['serialNumber']
  return { serial: serial === undefined ? null : { manufacturer: 'Enpal', serial } }
}
