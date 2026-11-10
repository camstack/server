import {
  BaseDevice,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
} from '@camstack/types'
import { ENPAL_SYSTEM } from '../config.js'
import {
  accessoryChildSpecs,
  enpalEquipmentSchema,
  findEquipment,
  metadataOf,
} from '../enpal-equipment.js'
import { enpalConnections } from '../enpal-resolver.js'

/**
 * One physical piece (the box, the installation, the heat pump) as a
 * {@link DeviceType.Container}. It owns no caps: it declares the Sensor children it was
 * adopted with, and the kernel spawns and restores them. Its model, serials and firmware are
 * device attributes, written from the box's text rows whenever they change. Online follows the integration's
 * box; the integration marks it offline when a poll fails.
 */
export class EnpalEquipmentDevice extends BaseDevice<typeof enpalEquipmentSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly equipment: string
  private readonly specIds: readonly string[]
  private readonly integrationId: string
  private appliedMetadata = ''
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = enpalEquipmentSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalEquipmentSchema, { type: DeviceType.Container })
    this.equipment = cfg.equipment
    this.specIds = cfg.specIds
    this.integrationId = cfg.integrationId
    this.online = enpalConnections.getSnapshot(this.integrationId) !== null
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.equipment}`,
      system: ENPAL_SYSTEM,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = enpalConnections.onSnapshot(this.integrationId, () => {
      void this.applyMetadata()
    })
    await this.applyMetadata()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  /** Write the identity facts the box reported; a poll that changed none writes nothing. */
  private async applyMetadata(): Promise<void> {
    const snapshot = enpalConnections.getSnapshot(this.integrationId)
    if (snapshot === null) return
    const attributes = metadataOf(findEquipment(this.equipment), snapshot)
    const fingerprint = JSON.stringify(attributes)
    if (fingerprint === this.appliedMetadata || Object.keys(attributes).length === 0) return
    try {
      await this.ctx.api.deviceManager.setMetadata.mutate({
        deviceId: this.id,
        patch: attributes,
      })
      this.appliedMetadata = fingerprint
    } catch (err) {
      this.ctx.logger.warn('enpal equipment: could not write the device attributes', {
        tags: { deviceId: this.id },
        meta: { equipment: this.equipment, error: errMsg(err) },
      })
    }
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return accessoryChildSpecs({
      equipment: this.equipment,
      specIds: this.specIds,
      integrationId: this.integrationId,
    })
  }
}
