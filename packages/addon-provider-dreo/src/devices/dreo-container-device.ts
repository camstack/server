import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
} from '@camstack/types'
import { dreoConnections } from '../dreo-gateway.js'
import { classifyDreoModel, deviceTypeForKind } from '../dreo-domain-mapping.js'
import { dreoChildFactory } from './dreo-child-class-factory.js'

/**
 * Persisted config for a Dreo Container (the parent of one cloud device).
 * `dreoDeviceId` resolves the live handle from the connection resolver;
 * `brokerId` selects the account; `model` classifies the single accessory
 * child; `integrationId` is stamped onto the child; `system`/`name` are
 * provenance.
 */
export const dreoContainerSchema = z.object({
  dreoDeviceId: z.string().min(1).describe('Dreo cloud device id'),
  brokerId: z.string().min(1).describe('Registry broker id'),
  model: z.string().min(1).describe('Dreo cloud model string'),
  integrationId: z.string().optional(),
  system: z.literal('dreo').optional(),
  name: z.string().optional(),
})

export type DreoContainerConfig = z.infer<typeof dreoContainerSchema>

/**
 * Parent Container device for a single Dreo cloud device. Owns no control caps
 * itself — it declares `getAccessoryChildren()` so the kernel auto-spawns the
 * single typed accessory child (fan / purifier / heater / humidifier) and
 * reconciles it across reboots. Mirrors `DreameContainerDevice`.
 *
 * The Container fans out to exactly ONE accessory child today (one cloud device =
 * one appliance). The container→children cascade is kept (rather than a flat
 * top-level device) for parity with the other provider addons and to leave room
 * for future sub-accessories.
 */
export class DreoContainerDevice extends BaseDevice<typeof dreoContainerSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly dreoDeviceId: string
  private readonly brokerId: string
  private readonly model: string
  private readonly integrationId: string | undefined

  constructor(ctx: DeviceContext) {
    const cfg = dreoContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, dreoContainerSchema, { type: DeviceType.Container })
    this.dreoDeviceId = cfg.dreoDeviceId
    this.brokerId = cfg.brokerId
    this.model = cfg.model
    this.integrationId = cfg.integrationId
    // online derives from whether the live handle is currently present.
    this.online = dreoConnections.getDevice(this.brokerId, this.dreoDeviceId) !== null
    void this.updateSourceInfo({ id: this.dreoDeviceId, system: 'dreo' })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const kind = classifyDreoModel(this.model)
    if (kind === 'unsupported') {
      this.ctx.logger.warn('DreoContainerDevice: unsupported model; no children', {
        meta: { model: this.model, dreoDeviceId: this.dreoDeviceId },
      })
      return []
    }
    const childType = deviceTypeForKind(kind)
    const meta: AccessoryChildSpec['meta'] = {
      type: childType,
      name: this.name,
      linkDeviceId: this.id,
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const config: Record<string, unknown> = {
      dreoDeviceId: this.dreoDeviceId,
      brokerId: this.brokerId,
      model: this.model,
      system: 'dreo',
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    return [
      {
        // Suffix the child stableId by kind so it is deterministic + collision-free.
        stableIdSuffix: kind,
        meta,
        config,
        factory: dreoChildFactory,
      },
    ]
  }
}
