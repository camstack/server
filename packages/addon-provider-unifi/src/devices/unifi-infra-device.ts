import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDevice,
  type InferNativeProvider,
  registerPowerSwitch,
  type WorkloadStatus,
  workloadCapability,
} from '@camstack/types'
import { unifiInfraSchema } from '../config.js'
import {
  capsForDescriptor,
  deviceTypeForDescriptor,
  featureLabel,
  featureSuffix,
  roleForDescriptor,
} from '../unifi-mapping.js'
import {
  UNIFI_HOST_WORKLOAD_OPTIONS,
  UNIFI_HOST_WORKLOAD_UNKNOWN,
  unifiHostWorkloadStatus,
} from '../unifi-host-workload.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { UnifiFeatureDevice } from './unifi-feature-device.js'

/**
 * One UniFi infra device (UDM/USX-Max gateway, U6-Pro AP, USW Lite-8-PoE /
 * Flex-Mini switch, …) as the device type its adoption stamped: a `workload` host (D1056)
 * that serves the `workload` cap from the live snapshot and EXPOSES its features; one adopted
 * as a Container before that stays a Container without the cap. A
 * top-level SIBLING of the controller's Gateway; its integration owns the connection. It
 * declares `getAccessoryChildren()` so the kernel auto-spawns
 * one {@link UnifiFeatureDevice} per descriptor in the LIVE `features[]` config
 * and reconciles additions/removals when the addon re-persists the list via
 * `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 *
 * The fan-out per infra device:
 *   - one PoE port device per PoE-capable port (switch / power-meter / reboot / network-link),
 *   - a restart Button child (no LED switch),
 *   - cpu_utilization / cpu_temperature / clients / state / uptime Sensor children.
 */
export class UnifiInfraDevice extends BaseDevice<typeof unifiInfraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly integrationId: string
  private readonly infraNativeId: string
  private snapshotUnsub: (() => void) | null = null

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

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The cap is gated to `workload` devices; a legacy Container keeps none.
    if (this.type !== DeviceType.Workload) return
    const provider: InferNativeProvider<typeof workloadCapability> = {
      getOptions: async () => UNIFI_HOST_WORKLOAD_OPTIONS,
      getStatus: async () =>
        this.runtimeState.getCapState<WorkloadStatus>(workloadCapability.name) ??
        UNIFI_HOST_WORKLOAD_UNKNOWN,
    }
    this.ctx.registerNativeCap(workloadCapability, provider)
    // No start / stop is served, so the helper registers no switch (no fake control).
    registerPowerSwitch(this, workloadCapability, provider)
    this.runtimeState.setCapState(workloadCapability.name, UNIFI_HOST_WORKLOAD_UNKNOWN)
    this.snapshotUnsub = unifiControllers.onSnapshot(this.integrationId, () =>
      this.recomputeWorkload(),
    )
    this.recomputeWorkload()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  /** The `workload` slice from the live snapshot; a device absent from it keeps its slice. */
  private recomputeWorkload(): void {
    const infra = unifiControllers.getInfra(this.integrationId, this.infraNativeId)
    if (infra === null) return
    this.runtimeState.setCapState(
      workloadCapability.name,
      unifiHostWorkloadStatus(infra, Date.now()),
    )
  }

  /** The client on one of this device's ports in the live snapshot, or null. */
  private portClientName(portIdx: number | undefined): string | null {
    if (portIdx === undefined) return null
    const infra = unifiControllers.getInfra(this.integrationId, this.infraNativeId)
    return infra?.ports.find((p) => p.idx === portIdx)?.clientName ?? null
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read the LIVE config so an additive reconcile (re-persisted `features[]`
    // via applyDerivedSpec) spawns new children + removes orphaned ones.
    return this.config.values.features.map((descriptor) => {
      const role = roleForDescriptor(descriptor)
      const meta: AccessoryChildSpec['meta'] = {
        type: deviceTypeForDescriptor(descriptor),
        name: featureLabel(descriptor, this.portClientName(descriptor.portIdx)),
        linkDeviceId: this.id,
        integrationId: this.integrationId,
        ...(role !== undefined ? { role } : {}),
      }
      const config: Record<string, unknown> = {
        kind: descriptor.kind,
        integrationId: this.integrationId,
        infraNativeId: this.infraNativeId,
        capabilities: [...capsForDescriptor(descriptor)],
        system: 'unifi',
        ...(descriptor.switchFeature !== undefined
          ? { switchFeature: descriptor.switchFeature }
          : {}),
        ...(descriptor.buttonAction !== undefined ? { buttonAction: descriptor.buttonAction } : {}),
        ...(descriptor.portIdx !== undefined ? { portIdx: descriptor.portIdx } : {}),
        ...(descriptor.metric !== undefined ? { metric: descriptor.metric } : {}),
        ...(descriptor.switchable !== undefined ? { switchable: descriptor.switchable } : {}),
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
