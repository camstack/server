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

/**
 * One physical piece of the installation (photovoltaic, battery, grid, house, heat pump) as a
 * {@link DeviceType.Container}. It owns no caps: it declares the Sensor children it was
 * adopted with, and the kernel spawns and restores them. Online follows the integration's
 * box; the integration marks it offline when a poll fails.
 */
export class EnpalEquipmentDevice extends BaseDevice<typeof enpalEquipmentSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly equipment: string
  private readonly specIds: readonly string[]
  private readonly integrationId: string

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

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return accessoryChildSpecs({
      equipment: this.equipment,
      specIds: this.specIds,
      integrationId: this.integrationId,
    })
  }
}
