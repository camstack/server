import {
  BaseDevice,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type DeviceFeature,
} from '@camstack/types'
import { ENPAL_SYSTEM } from '../config.js'
import { accessoryChildSpecs, enpalEquipmentSchema } from '../enpal-equipment.js'
import { enpalConnections } from '../enpal-resolver.js'
import { EnpalMetadataSync } from './enpal-metadata-sync.js'

/**
 * One piece Enpal measures (the System: PV, battery, grid, house; the heat pump) as a
 * {@link DeviceType.Container}. It owns no caps: it declares the Sensor children it was
 * adopted with, and the kernel spawns and restores them; which child stands for it is the
 * `primaryChildPreference` stamped at adoption. Its model, serials and firmware are device
 * attributes, written from the box's text rows whenever they change. Online follows the
 * integration's box; the integration marks it offline when a poll fails.
 */
export class EnpalEquipmentDevice extends BaseDevice<typeof enpalEquipmentSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly equipment: string
  private readonly specIds: readonly string[]
  private readonly integrationId: string
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
    const metadata = new EnpalMetadataSync({
      equipment: this.equipment,
      deviceId: this.id,
      getSnapshot: () => enpalConnections.getSnapshot(this.integrationId),
      write: async (patch) => {
        await this.ctx.api.deviceManager.setMetadata.mutate({ deviceId: this.id, patch })
      },
      logger: this.ctx.logger,
    })
    this.snapshotUnsub = enpalConnections.onSnapshot(this.integrationId, () => {
      void metadata.apply()
    })
    await metadata.apply()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return accessoryChildSpecs({
      equipment: this.equipment,
      specIds: this.specIds,
      integrationId: this.integrationId,
    })
  }
}
