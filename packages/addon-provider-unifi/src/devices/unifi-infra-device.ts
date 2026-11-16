import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  type IDevice,
} from '@camstack/types'
import { unifiInfraSchema } from '../config.js'
import {
  capForDescriptor,
  deviceTypeForDescriptor,
  featureLabel,
  featureSuffix,
  roleForDescriptor,
} from '../unifi-mapping.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { UnifiFeatureDevice } from './unifi-feature-device.js'

/**
 * One UniFi infra device (UDM/USX-Max gateway, U6-Pro AP, USW Lite-8-PoE /
 * Flex-Mini switch, …) as the device type its adoption stamped — a Container until #585 (USER
 * DIRECTIVE: each infra device is a Container that EXPOSES its features). A
 * top-level SIBLING of the controller's Gateway; its integration owns the connection. Owns no
 * caps itself — it declares `getAccessoryChildren()` so the kernel auto-spawns
 * one {@link UnifiFeatureDevice} per descriptor in the LIVE `features[]` config
 * and reconciles additions/removals when the addon re-persists the list via
 * `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 *
 * The fan-out per infra device:
 *   - per-PoE-port PoE Switch children + power-cycle Button children,
 *   - a restart Button child (no LED switch: the Integration API cannot serve it),
 *   - cpu_utilization / cpu_temperature / clients / state / uptime Sensor children.
 */
export class UnifiInfraDevice extends BaseDevice<typeof unifiInfraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly integrationId: string
  private readonly infraNativeId: string

  constructor(ctx: DeviceContext) {
    const cfg = unifiInfraSchema.parse(ctx.persistedConfig ?? {})
    // The type the adoption stamped (`unifiDeviceTarget`), never a second decision here.
    super(ctx, unifiInfraSchema, { type: ctx.deviceMeta.type })
    this.integrationId = cfg.integrationId
    this.infraNativeId = cfg.infraNativeId
    registerUnifiAdminLink(ctx, this.id, { integrationId: this.integrationId })
    this.online = unifiControllers.getInfra(this.integrationId, this.infraNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.infraNativeId}`,
      system: 'unifi',
    })
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read the LIVE config so an additive reconcile (re-persisted `features[]`
    // via applyDerivedSpec) spawns new children + removes orphaned ones.
    return this.config.values.features.map((descriptor) => {
      const role = roleForDescriptor(descriptor)
      const meta: AccessoryChildSpec['meta'] = {
        type: deviceTypeForDescriptor(descriptor),
        name: featureLabel(descriptor),
        linkDeviceId: this.id,
        integrationId: this.integrationId,
        ...(role !== undefined ? { role } : {}),
      }
      const config: Record<string, unknown> = {
        kind: descriptor.kind,
        integrationId: this.integrationId,
        infraNativeId: this.infraNativeId,
        capabilities: [capForDescriptor(descriptor)],
        system: 'unifi',
        ...(descriptor.switchFeature !== undefined
          ? { switchFeature: descriptor.switchFeature }
          : {}),
        ...(descriptor.buttonAction !== undefined ? { buttonAction: descriptor.buttonAction } : {}),
        ...(descriptor.portIdx !== undefined ? { portIdx: descriptor.portIdx } : {}),
        ...(descriptor.metric !== undefined ? { metric: descriptor.metric } : {}),
      }
      return {
        stableIdSuffix: featureSuffix(descriptor),
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new UnifiFeatureDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }
}
