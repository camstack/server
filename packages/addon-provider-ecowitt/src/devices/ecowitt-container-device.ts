import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
  type InferNativeProvider,
  type WeatherStationStatus,
  weatherStationCapability,
  resyncCapability,
  resyncThroughAdoption,
} from '@dominevo/types'
import { ecowittFacades } from '../ecowitt-gateway.js'
import {
  childEntriesForGroup,
  entriesForGroup,
  illuminanceEntriesForGroup,
} from '../ecowitt-sensor-groups.js'
import {
  capForQuantity,
  ecowittGroupDeviceType,
  roleForQuantity,
  sensorLabel,
} from '../ecowitt-mapping.js'
import {
  isGatewayPressureSensorId,
  stationSliceWithGatewayPressure,
  type StationSensorSample,
} from '../station-reading.js'
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
 * the parent gateway's live nodewitt client (the gateway key, see `gatewayKeyOf`); `sensors[]` is the additively-reconciled list of sensors that fan
 * out as accessory children (updated by the gateway device via `applyDerivedSpec`
 * on every `snapshot` push). `system`/`integrationId`/`name` are provenance.
 */
export const ecowittContainerSchema = z.object({
  gatewayId: z.string().min(1).describe('Gateway key of the owning integration'),
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
  private readonly station: boolean
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = ecowittContainerSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittContainerSchema, {
      type: ecowittGroupDeviceType(cfg.deviceGroup),
    })
    // Re-sync with the source (#459, Q6): this binding is what makes Resyncable true.
    this.ctx.registerNativeCap(
      resyncCapability,
      resyncThroughAdoption(this.ctx.api.deviceManager, this.id),
    )
    this.gatewayId = cfg.gatewayId
    this.integrationId = cfg.integrationId
    this.station = cfg.deviceGroup === 'weather-station'
    this.online = ecowittFacades.get(this.gatewayId) !== null
    void this.updateSourceInfo({ id: this.gatewayId, system: 'ecowitt' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    if (!this.station) return
    const provider: InferNativeProvider<typeof weatherStationCapability> = {
      getStatus: async () => this.readStation(),
    }
    this.ctx.registerNativeCap(weatherStationCapability, provider)
    this.runtimeState.setCapState(weatherStationCapability.name, this.readStation())
    this.snapshotUnsub = ecowittFacades.onSnapshot(this.gatewayId, () => {
      try {
        this.publishStation()
      } catch (err) {
        this.ctx.logger.warn('ecowitt station: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
    })
    this.publishStation()
  }

  override async removeDevice(): Promise<void> {
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read the LIVE config so an additive reconcile (re-persisted `sensors[]`
    // via applyDerivedSpec) spawns new children + removes orphaned ones.
    const live = ecowittFacades.getSensors(this.gatewayId)
    const group = this.config.values.deviceGroup
    const own = [
      ...childEntriesForGroup(this.config.values.sensors, group, live),
      ...illuminanceEntriesForGroup(this.config.values.sensors, group, live),
    ]
    return own.map((sensor) => {
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
        stableIdSuffix:
          sensor.quantity === 'illuminance' ? `${sensor.sensorId}:illuminance` : sensor.sensorId,
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new EcowittSensorDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }

  private readStation(): WeatherStationStatus {
    return this.stationFromLive().status
  }

  /** The outdoor group's live sensors, the same snapshot the children read. */
  private publishStation(): void {
    const { status, refused } = this.stationFromLive()
    for (const refusal of refused) {
      this.ctx.logger.warn('ecowitt station: reading refused', {
        tags: { deviceId: this.id },
        meta: {
          sensorId: refusal.sensorId,
          unit: refusal.unit,
          reason: refusal.reason,
        },
      })
    }
    this.runtimeState.setCapState(weatherStationCapability.name, status)
  }

  private stationFromLive(): ReturnType<typeof stationSliceWithGatewayPressure> {
    const live = ecowittFacades.getSensors(this.gatewayId)
    const ownIds = new Set(
      entriesForGroup(this.config.values.sensors, 'weather-station', live).map(
        (entry) => entry.sensorId,
      ),
    )
    const samples: StationSensorSample[] = []
    const gatewaySamples: StationSensorSample[] = []
    for (const sensor of live) {
      const own = ownIds.has(sensor.id)
      if (!own && !isGatewayPressureSensorId(sensor.id)) continue
      const target = own ? samples : gatewaySamples
      target.push({
        id: sensor.id,
        quantity: String(sensor.quantity),
        name: sensor.name,
        value:
          typeof sensor.value === 'number' && Number.isFinite(sensor.value) ? sensor.value : null,
        unit: typeof sensor.unit === 'string' ? sensor.unit : '',
        lastUpdated: sensor.lastUpdated > 0 ? sensor.lastUpdated : Date.now(),
      })
    }
    return stationSliceWithGatewayPressure(samples, gatewaySamples)
  }
}
