import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
} from '@camstack/types'
import { ecowittFacades } from '../ecowitt-gateway.js'
import { capForQuantity, roleForQuantity, sensorLabel } from '../ecowitt-mapping.js'
import { EcowittSensorDevice } from './ecowitt-sensor-device.js'

/** One sensor entry persisted on the gateway container — drives a child spawn. */
const ecowittSensorEntrySchema = z.object({
  sensorId: z.string(),
  quantity: z.string(),
  channel: z.number().optional(),
  // Specific measurement name from nodewitt (e.g. "Outdoor Temperature",
  // "Wind Gust") — distinguishes same-quantity sensors in the child name.
  name: z.string().optional(),
  // Self-describing nodewitt category, persisted so a re-derive can recompute the
  // sensor's device group without re-resolving the live model. Optional for
  // backward-compat with sensor entries persisted before the 1→3 split.
  category: z.enum(['gateway', 'weather-station', 'channel-sensor', 'external']).optional(),
})
export type EcowittSensorEntry = z.infer<typeof ecowittSensorEntrySchema>

/**
 * Persisted config for one Ecowitt gateway-group Container. `gatewayId` selects
 * the parent gateway's live nodewitt client (the gateway Hub device's
 * `stableId`); `sensors[]` is the additively-reconciled list of sensors that fan
 * out as accessory children (updated by the gateway device via `applyDerivedSpec`
 * on every `snapshot` push). `system`/`integrationId`/`name` are provenance.
 */
export const ecowittContainerSchema = z.object({
  gatewayId: z.string().min(1).describe('Parent gateway Hub stableId'),
  // The logical device this Container represents within the gateway split. One
  // physical gateway fans out into up to THREE Containers (gateway /
  // weather-station / temp-sensor-ch1); each Container holds only the sensors
  // whose device group matches.
  deviceGroup: z.enum(['gateway', 'weather-station', 'temp-sensor-ch1']).default('gateway'),
  sensors: z.array(ecowittSensorEntrySchema).default([]),
  integrationId: z.string().optional(),
  system: z.literal('ecowitt').optional(),
  name: z.string().optional(),
})

export type EcowittContainerConfig = z.infer<typeof ecowittContainerSchema>

/**
 * One gateway-group Container for an Ecowitt station. A CHILD of the gateway Hub
 * (standalone mode). Owns no caps itself — it declares `getAccessoryChildren()`
 * so the kernel auto-spawns one {@link EcowittSensorDevice} per sensor in the
 * LIVE `sensors[]` config and reconciles additions/removals when the gateway
 * re-persists the list via `applyDerivedSpec`. Mirrors `HaContainerDevice` (which
 * reads its `entities[]` live and is re-derived on reconcile).
 */
export class EcowittContainerDevice extends BaseDevice<typeof ecowittContainerSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly gatewayId: string
  private readonly integrationId: string | undefined

  constructor(ctx: DeviceContext) {
    const cfg = ecowittContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittContainerSchema, { type: DeviceType.Container })
    this.gatewayId = cfg.gatewayId
    this.integrationId = cfg.integrationId
    this.online = ecowittFacades.get(this.gatewayId) !== null
    void this.updateSourceInfo({ id: this.gatewayId, system: 'ecowitt' })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read the LIVE config so an additive reconcile (re-persisted `sensors[]`
    // via applyDerivedSpec) spawns new children + removes orphaned ones.
    return this.config.values.sensors.map((sensor) => {
      const meta: AccessoryChildSpec['meta'] = {
        type: DeviceType.Sensor,
        role: roleForQuantity(sensor.quantity),
        name: sensorLabel(sensor.quantity, sensor.channel, sensor.name, sensor.sensorId),
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      const config: Record<string, unknown> = {
        sensorId: sensor.sensorId,
        gatewayId: this.gatewayId,
        quantity: sensor.quantity,
        capabilities: [capForQuantity(sensor.quantity)],
        system: 'ecowitt',
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      return {
        stableIdSuffix: sensor.sensorId,
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new EcowittSensorDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }
}
