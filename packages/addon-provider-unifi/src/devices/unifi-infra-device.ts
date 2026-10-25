import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
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
 * Flex-Mini switch, …) as a CamStack {@link DeviceType.Container} (USER
 * DIRECTIVE: the controller is the Hub, each infra device is a Container that
 * EXPOSES its features). A CHILD of the controller Hub (standalone mode). Owns no
 * caps itself — it declares `getAccessoryChildren()` so the kernel auto-spawns
 * one {@link UnifiFeatureDevice} per descriptor in the LIVE `features[]` config
 * and reconciles additions/removals when the controller re-persists the list via
 * `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 *
 * The fan-out per infra device:
 *   - per-PoE-port PoE Switch children + power-cycle Button children,
 *   - a device LED Switch child + a restart Button child,
 *   - cpu_utilization / cpu_temperature / clients / state / uptime Sensor children.
 */
export class UnifiInfraDevice extends BaseDevice<typeof unifiInfraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly controllerId: string
  private readonly infraNativeId: string

  constructor(ctx: DeviceContext) {
    const cfg = unifiInfraSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unifiInfraSchema, { type: DeviceType.Container })
    this.controllerId = cfg.controllerId
    this.infraNativeId = cfg.infraNativeId
    registerUnifiAdminLink(ctx, this.id, {
      kind: 'controller',
      controllerId: this.controllerId,
    })
    this.online = unifiControllers.getInfra(this.controllerId, this.infraNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.controllerId}:${this.infraNativeId}`,
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
        ...(role !== undefined ? { role } : {}),
      }
      const config: Record<string, unknown> = {
        kind: descriptor.kind,
        controllerId: this.controllerId,
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
