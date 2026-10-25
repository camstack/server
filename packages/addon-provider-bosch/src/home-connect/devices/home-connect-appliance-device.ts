import { z } from 'zod'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceType,
  errMsg,
  type IDevice,
} from '@camstack/types'
import { homeConnectDishwasherEntityName } from '../home-connect-discovery.js'
import { legacyChildBindings } from '../home-connect-child-bindings.js'
import { parsePersistedBindings } from '../home-connect-child-reconciler.js'
import { homeConnectConnections, type HomeConnectWatchEvent } from '../home-connect-gateway.js'
import { HOME_CONNECT_INFO_PREFIX, HOME_CONNECT_NETWORK_PREFIX } from '../home-connect-ws-client.js'
import { HomeConnectDishwasherDevice } from './home-connect-dishwasher-device.js'
import { HomeConnectEventDevice } from './home-connect-event-device.js'
import { HomeConnectSensorDevice } from './home-connect-sensor-device.js'

export const homeConnectApplianceSchema = z.object({
  haId: z.string().min(1),
  brokerId: z.string().min(1),
  applianceType: z.string().optional(),
  /** One entry per appliance entity exposed as a child, maintained from the appliance's description. */
  entities: z.array(z.unknown()).optional(),
  /** Children persisted before the description-derived model; read only to keep them alive. */
  children: z.array(z.unknown()).optional(),
  system: z.literal('home-connect').optional(),
  integrationId: z.string().optional(),
})

export type HomeConnectApplianceConfig = z.infer<typeof homeConnectApplianceSchema>

/** Device metadata keys the `/ci/info` fields map onto (the conventional `DeviceMetadata` keys). */
const INFO_TO_METADATA: Readonly<Record<string, string>> = {
  brand: 'manufacturer',
  vib: 'model',
  serialNumber: 'serialNumber',
  sn: 'serialNumber',
  softwareVersion: 'firmware',
  swVersion: 'firmware',
  hardwareVersion: 'hardware',
  hwVersion: 'hardware',
  mac: 'mac',
}

/** One Home Connect appliance as a container: the dishwasher, an event emitter, and one child per entity. */
export class HomeConnectApplianceDevice extends BaseDevice<typeof homeConnectApplianceSchema> {
  readonly features = [] as const

  private readonly integrationId: string | undefined
  private readonly brokerId: string
  private readonly haId: string
  private readonly applianceType: string | undefined
  #unwatch: (() => void) | null = null
  #lastInfo = ''

  constructor(ctx: DeviceContext) {
    const cfg = homeConnectApplianceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeConnectApplianceSchema, { type: DeviceType.Container })
    this.brokerId = cfg.brokerId
    this.haId = cfg.haId
    this.integrationId = cfg.integrationId
    this.applianceType = cfg.applianceType
    void this.updateSourceInfo({ id: cfg.haId, system: 'home-connect' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.#unwatch = homeConnectConnections.watch(this.brokerId, this.haId, (event) =>
      this.onChange(event),
    )
    this.onChange({ kind: 'client' })
  }

  override async removeDevice(): Promise<void> {
    this.#unwatch?.()
    this.#unwatch = null
    await super.removeDevice()
  }

  private onChange(event: HomeConnectWatchEvent): void {
    const client = homeConnectConnections.getClient(this.brokerId)
    this.markOnline(client?.getLinkState(this.haId) === 'connected')
    if (client === null) return
    if (
      event.kind === 'feature' &&
      !event.key.startsWith(HOME_CONNECT_INFO_PREFIX) &&
      !event.key.startsWith(HOME_CONNECT_NETWORK_PREFIX)
    ) {
      return
    }
    void this.publishInfo(client.getFeatures(this.haId))
  }

  /** `/ci/info` as device metadata (manufacturer, model, serial, firmware, …); pushed only when it changed. */
  private async publishInfo(features: ReadonlyMap<string, unknown>): Promise<void> {
    const patch: Record<string, string | number | boolean> = {}
    for (const [field, metadataKey] of Object.entries(INFO_TO_METADATA)) {
      const value = features.get(`${HOME_CONNECT_INFO_PREFIX}${field}`)
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        patch[metadataKey] = value
      }
    }
    const serialized = JSON.stringify(patch)
    if (Object.keys(patch).length === 0 || serialized === this.#lastInfo) return
    const action = this.ctx.api.deviceManager?.setMetadata
    if (!action) return
    try {
      await action.mutate({ deviceId: this.id, patch })
      this.#lastInfo = serialized
    } catch (err: unknown) {
      this.ctx.logger.warn('Home Connect could not publish the appliance info', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const cfg = this.config.values
    // A container saved before the derived model has no `entities`: hold its old children until
    // the description has been read once, or the kernel deletes them by absence.
    const bindings =
      cfg.entities !== undefined
        ? parsePersistedBindings(cfg.entities).bindings
        : legacyChildBindings(cfg.children)
    const containerName = this.name
    const link = {
      haId: this.haId,
      brokerId: this.brokerId,
      system: 'home-connect',
      ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
    }
    const integration =
      this.integrationId !== undefined ? { integrationId: this.integrationId } : {}
    const out: AccessoryChildSpec[] = [
      {
        stableIdSuffix: 'dishwasher',
        meta: {
          type: DeviceType.Dishwasher,
          name: homeConnectDishwasherEntityName(containerName),
          linkDeviceId: this.id,
          ...integration,
        },
        config: {
          ...link,
          ...(this.applianceType !== undefined ? { applianceType: this.applianceType } : {}),
        },
        factory: (childCtx: DeviceContext): IDevice => new HomeConnectDishwasherDevice(childCtx),
      },
    ]
    if (bindings.some((b) => b.convert === 'event-active')) {
      out.push({
        stableIdSuffix: 'events',
        meta: {
          type: DeviceType.EventEmitter,
          name: `${containerName} — Events`,
          linkDeviceId: this.id,
          ...integration,
        },
        config: link,
        factory: (childCtx: DeviceContext): IDevice => new HomeConnectEventDevice(childCtx),
      })
    }
    for (const binding of bindings) {
      out.push({
        stableIdSuffix: binding.stableIdSuffix,
        meta: {
          type: DeviceType.Sensor,
          role: binding.role,
          name: `${containerName} — ${binding.name}`,
          linkDeviceId: this.id,
          ...integration,
        },
        config: { ...link, binding },
        factory: (childCtx: DeviceContext): IDevice => new HomeConnectSensorDevice(childCtx),
      })
    }
    return out
  }
}
