import {
  BaseDevice,
  DeviceType,
  errMsg,
  type AccessoryChildSpec,
  type DeviceContext,
  type DeviceFeature,
} from '@camstack/types'
import { ENPAL_SYSTEM } from '../config.js'
import {
  accessoryChildSpecs,
  enpalEquipmentSchema,
  findEquipment,
  primaryChildPreferenceOf,
} from '../enpal-equipment.js'
import { ENPAL_LEGACY_CONSUMPTION_NAME } from '../enpal-catalog.js'
import { renameLegacyCatalogDevices } from './enpal-catalog-rename.js'
import { enpalConnections } from '../enpal-resolver.js'
import { EnpalMetadataSync } from './enpal-metadata-sync.js'
import { backfillPrimaryChildPreference } from './enpal-preference-backfill.js'

/**
 * One piece Enpal measures (the System: PV, battery, grid, house; the heat pump) as a
 * {@link DeviceType.Container}. It owns no caps: it declares the Sensor children it was
 * adopted with, and the kernel spawns and restores them; which child stands for it is the
 * `primaryChildPreference` stamped at adoption, and re-stamped on activation for a
 * container adopted before it had one. Its model, serials and firmware are device
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
    await backfillPrimaryChildPreference({
      deviceId: this.id,
      stored: this.ctx.deviceMeta.primaryChildPreference,
      declared: primaryChildPreferenceOf(findEquipment(this.equipment), this.specIds),
      write: async (keys) => {
        await this.ctx.api.deviceManager.setPrimaryChildPreference.mutate({
          deviceId: this.id,
          primaryChildPreference: keys,
        })
      },
      logger: this.ctx.logger,
    })
    await this.renameLegacyNames()
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

  /**
   * A meter created as "Consumption" takes the current catalogue name. A name
   * the operator changed is left as it is.
   */
  private async renameLegacyNames(): Promise<void> {
    const manager = this.ctx.api.deviceManager
    try {
      const children = await manager.getChildren.query({ parentDeviceId: this.id })
      const legacy = children.flatMap((child) => {
        const specId = child.config['specId']
        if (typeof specId !== 'string' || child.name !== ENPAL_LEGACY_CONSUMPTION_NAME) return []
        return [{ deviceId: child.id, specId, name: child.name }]
      })
      const rows = await Promise.all(
        legacy.map(async (child) => {
          const meta = await manager.loadMeta.query({ deviceId: child.deviceId })
          return {
            ...child,
            name: meta?.name ?? child.name,
            userNamed: meta?.userNamed,
          }
        }),
      )
      await renameLegacyCatalogDevices({
        children: rows,
        rename: (deviceId, name, stampUserNamed) =>
          manager.setName.mutate({
            deviceId,
            name,
            ...(stampUserNamed ? {} : { stampUserNamed: false }),
          }),
        logger: this.ctx.logger,
      })
    } catch (err: unknown) {
      this.ctx.logger.warn(
        'enpal: could not rename devices still carrying the old catalogue name',
        {
          tags: { deviceId: this.id },
          meta: { error: errMsg(err) },
        },
      )
    }
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
