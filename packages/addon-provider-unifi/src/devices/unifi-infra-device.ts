import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDevice,
  type InferNativeProvider,
  rebootCapability,
  registerPowerSwitch,
  type WorkloadStatus,
  workloadCapability,
  resyncCapability,
  resyncThroughAdoption,
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
import { isUnifiConsoleModel } from '../unifi-device-kind.js'
import { unifiInfraIdentifiers } from '../unifi-identifiers.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { UnifiFeatureDevice } from './unifi-feature-device.js'

/**
 * One UniFi infra device (UDM/USX-Max gateway, U6-Pro AP, USW Lite-8-PoE /
 * Flex-Mini switch, …) as the device type its adoption stamped: a `workload` host (D1056)
 * that serves the `workload` cap from the live snapshot and EXPOSES its features; one adopted
 * as a Container before that stays a Container without the cap. A console (UDM, UCG, …) is
 * the Host the integration talks to (D1064 — there is no Gateway): it also serves `reboot`
 * through the controller's `restartDevice`. A top-level SIBLING of the controller's other
 * devices; its integration owns the connection. It
 * declares `getAccessoryChildren()` so the kernel auto-spawns
 * one {@link UnifiFeatureDevice} per descriptor in the LIVE `features[]` config
 * and reconciles additions/removals when the addon re-persists the list via
 * `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 *
 * The fan-out per infra device:
 *   - one PoE port device per PoE-capable port: power-meter, network-link and a switch —
 *     PoE on/off when a local account can set it, else only the native power cycle a linked
 *     power-source restart uses (no reboot or power-cycle button of its own),
 *   - a restart Button child (no LED switch),
 *   - cpu_utilization / cpu_temperature / clients / state / uptime Sensor children.
 */
export class UnifiInfraDevice extends BaseDevice<typeof unifiInfraSchema> {
  readonly features: readonly DeviceFeature[]

  private readonly integrationId: string
  private readonly infraNativeId: string
  /** A UniFi OS console, read from its persisted model: the Host that reboots. */
  private readonly isConsole: boolean
  private snapshotUnsub: (() => void) | null = null
  /** The last identity declaration sent, so an unchanged poll sends nothing. */
  private lastIdentityKey: string | null = null

  constructor(ctx: DeviceContext) {
    const cfg = unifiInfraSchema.parse(ctx.persistedConfig ?? {})
    // The type the adoption stamped (`unifiDeviceTarget`), never a second decision here.
    super(ctx, unifiInfraSchema, { type: ctx.deviceMeta.type })
    // Re-sync with the source (#459, Q6): this binding is what makes Resyncable true.
    this.ctx.registerNativeCap(
      resyncCapability,
      resyncThroughAdoption(this.ctx.api.deviceManager, this.id),
    )
    this.integrationId = cfg.integrationId
    this.infraNativeId = cfg.infraNativeId
    this.isConsole = cfg.model !== undefined && isUnifiConsoleModel(cfg.model)
    this.features =
      this.isConsole && this.type === DeviceType.Workload
        ? [DeviceFeature.Resyncable, DeviceFeature.Rebootable]
        : [DeviceFeature.Resyncable]
    registerUnifiAdminLink(ctx, this.id, { integrationId: this.integrationId })
    this.online = unifiControllers.getInfra(this.integrationId, this.infraNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.infraNativeId}`,
      system: 'unifi',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.snapshotUnsub = unifiControllers.onSnapshot(this.integrationId, () => {
      this.recomputeWorkload()
      void this.declareIdentity()
    })
    void this.declareIdentity()
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
    this.recomputeWorkload()
    if (this.isConsole) this.registerReboot()
  }

  /** The console's reboot: the controller's own `restartDevice` of this device. */
  private registerReboot(): void {
    const provider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(`UniFi reboot: deviceId mismatch, expected ${this.id}, got ${deviceId}`)
        }
        const client = unifiControllers.getManager(this.integrationId)?.client ?? null
        if (client === null) {
          this.ctx.logger.warn('UniFi console reboot refused: the controller is not connected', {
            tags: { deviceId: this.id },
            meta: {
              integrationId: this.integrationId,
              infraId: this.infraNativeId,
            },
          })
          throw new Error('The UniFi controller is not connected, so the console cannot reboot.')
        }
        await client.restartDevice(this.infraNativeId)
        this.ctx.logger.info('UniFi console reboot requested', {
          tags: { deviceId: this.id },
          meta: {
            integrationId: this.integrationId,
            infraId: this.infraNativeId,
          },
        })
        return { success: true }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, provider)
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  /**
   * The `workload` slice from the live snapshot. A failed read (or a device the controller no
   * longer lists) is unknown, never the last state a reachable controller reported.
   */
  private recomputeWorkload(): void {
    if (this.type !== DeviceType.Workload) return
    const previous =
      this.runtimeState.getCapState<WorkloadStatus>(workloadCapability.name) ??
      UNIFI_HOST_WORKLOAD_UNKNOWN
    this.runtimeState.setCapState(
      workloadCapability.name,
      unifiHostWorkloadStatus(
        unifiControllers.getLiveInfra(this.integrationId, this.infraNativeId),
        Date.now(),
        previous,
      ),
    )
  }

  /**
   * Declare the MAC, serial and IP the controller reports NOW (D1059). A failed read declares
   * nothing; an unchanged declaration is not re-sent.
   */
  private async declareIdentity(): Promise<void> {
    const declaration = unifiInfraIdentifiers(
      unifiControllers.getLiveInfra(this.integrationId, this.infraNativeId),
    )
    if (declaration === null) return
    const key = JSON.stringify(declaration)
    if (key === this.lastIdentityKey) return
    this.lastIdentityKey = key
    const result = await this.declareIdentifiers(declaration.identifiers, {
      unread: declaration.unread,
    })
    if (result.outcome !== 'declared') this.lastIdentityKey = null
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
