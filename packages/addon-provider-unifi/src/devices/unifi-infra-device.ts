import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import {
  BaseDevice,
  errMsg,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDevice,
  type InferNativeProvider,
  type PowerMeterStatus,
  powerMeterCapability,
  registerPowerSwitch,
  type WorkloadStatus,
  workloadCapability,
  resyncCapability,
  resyncThroughAdoption,
} from '@dominevo/types'
import { unifiInfraSchema } from '../config.js'
import {
  capsForDescriptor,
  deviceTypeForDescriptor,
  featureLabel,
  featureSuffix,
  infraNameWrite,
  roleForDescriptor,
} from '../unifi-mapping.js'
import { UnifiControllerNotConnectedError, UnifiDeviceMismatchError } from '../unifi-errors.js'
import {
  UNIFI_HOST_WORKLOAD_OPTIONS,
  UNIFI_HOST_WORKLOAD_UNKNOWN,
  unifiHostWorkloadStatus,
} from '../unifi-host-workload.js'
import { hasPoePort, infraPoeTotalStatus } from '../unifi-port-state.js'
import { unifiInfraIdentifiers } from '../unifi-identifiers.js'
import { unifiControllers } from '../unifi-node-resolver.js'
import { registerUnifiStateRefresh } from './unifi-state-refresh.js'
import { UnifiFeatureDevice } from './unifi-feature-device.js'

/**
 * One UniFi infra device (UDM/USX-Max gateway, U6-Pro AP, USW Lite-8-PoE /
 * Flex-Mini switch, …) as the device type its adoption stamped: a `workload` host (D1056)
 * that serves the `workload` cap from the live snapshot and EXPOSES its features; one adopted
 * as a Container before that stays a Container without the cap. Its `workload` serves
 * `restart` through the controller's `restartDevice` — console, switch and access point alike; a
 * console is also the Host the integration talks to (D1064 — there is no Gateway). A top-level SIBLING of the controller's other
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
 *   - no restart Button child (the restart is `workload.restart`) and no LED switch,
 *   - cpu_utilization / cpu_temperature / clients / state / uptime Sensor children.
 */
export class UnifiInfraDevice extends BaseDevice<typeof unifiInfraSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly integrationId: string
  private stopStateRefresh: (() => void) | null = null
  private readonly infraNativeId: string
  private snapshotUnsub: (() => void) | null = null
  /** The last identity declaration sent, so an unchanged poll sends nothing. */
  private lastIdentityKey: string | null = null
  /** The controller name last decided on, so an unchanged poll asks nothing. */
  private lastDesiredName: string | null = null
  private poeTotalRegistered = false

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
    registerUnifiAdminLink(ctx, this.id, { integrationId: this.integrationId })
    this.online = unifiControllers.getInfra(this.integrationId, this.infraNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.infraNativeId}`,
      system: 'unifi',
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The core decides when the controller is re-read (D1062); this device only reads.
    this.stopStateRefresh ??= registerUnifiStateRefresh({
      ctx: this.ctx,
      deviceId: this.id,
      integrationId: this.integrationId,
    })
    this.snapshotUnsub = unifiControllers.onSnapshot(this.integrationId, () => {
      this.recomputeWorkload()
      void this.declareIdentity()
      void this.followControllerName()
    })
    void this.declareIdentity()
    void this.followControllerName()
    // The cap is gated to `workload` devices; a legacy Container keeps none.
    if (this.type !== DeviceType.Workload) return
    const provider: InferNativeProvider<typeof workloadCapability> = {
      getOptions: async () => UNIFI_HOST_WORKLOAD_OPTIONS,
      getStatus: async () =>
        this.runtimeState.getCapState<WorkloadStatus>(workloadCapability.name) ??
        UNIFI_HOST_WORKLOAD_UNKNOWN,
      restart: async ({ deviceId }: { readonly deviceId: number }) => this.restartInfra(deviceId),
    }
    this.ctx.registerNativeCap(workloadCapability, provider)
    // No start / stop is served (a restart is not power), so no switch is registered.
    registerPowerSwitch(this, workloadCapability, provider)
    this.runtimeState.setCapState(workloadCapability.name, UNIFI_HOST_WORKLOAD_UNKNOWN)
    this.recomputeWorkload()
  }

  /**
   * `power-meter` only on a device with a PoE-capable port: the total PoE power it delivers to
   * connected devices (not its own draw).
   */
  private registerPoeTotal(): void {
    const provider: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>(powerMeterCapability.name) ?? {
          lastFetchedAt: 0,
        },
    }
    this.ctx.registerNativeCap(powerMeterCapability, provider)
    this.poeTotalRegistered = true
  }

  /** A console, switch or access point restart: the controller's own `restartDevice` of it. */
  private async restartInfra(deviceId: number): Promise<void> {
    if (deviceId !== this.id) throw new UnifiDeviceMismatchError(this.id, deviceId)
    const client = unifiControllers.getManager(this.integrationId)?.client ?? null
    if (client === null) {
      this.ctx.logger.warn('UniFi restart refused: the controller is not connected', {
        tags: { deviceId: this.id },
        meta: { integrationId: this.integrationId, infraId: this.infraNativeId },
      })
      throw new UnifiControllerNotConnectedError(this.integrationId)
    }
    await client.restartDevice(this.infraNativeId)
    this.ctx.logger.info('UniFi restart requested', {
      tags: { deviceId: this.id },
      meta: { integrationId: this.integrationId, infraId: this.infraNativeId },
    })
  }

  override async removeDevice(): Promise<void> {
    this.stopStateRefresh?.()
    this.stopStateRefresh = null
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
    const ports = unifiControllers.getLiveInfra(this.integrationId, this.infraNativeId)?.ports
    if (ports === undefined) {
      // A failed read is unknown, never the last total a reachable controller reported.
      if (this.poeTotalRegistered) {
        this.runtimeState.setCapState(powerMeterCapability.name, { lastFetchedAt: Date.now() })
      }
    } else if (hasPoePort(ports)) {
      // The snapshot may not be loaded at activation: the cap registers when a PoE port first shows.
      if (!this.poeTotalRegistered) this.registerPoeTotal()
      this.runtimeState.setCapState(
        powerMeterCapability.name,
        infraPoeTotalStatus(ports, Date.now()),
      )
    }
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

  /**
   * Keep the device name on the controller's, unless the operator renamed the device in
   * Dominevo (`infraNameWrite`). A refused rename is logged once per controller name.
   */
  private async followControllerName(): Promise<void> {
    const desired = unifiControllers.getLiveInfra(this.integrationId, this.infraNativeId)?.name
    if (desired === undefined || desired.length === 0 || desired === this.lastDesiredName) return
    try {
      const manager = this.ctx.api?.deviceManager
      if (manager === undefined) return
      const meta = await manager.loadMeta.query({ deviceId: this.id })
      if (meta === null) return
      const decision = infraNameWrite({
        currentName: meta.name,
        userNamed: meta.userNamed,
        adoptedName: this.config.values.name,
        desiredName: desired,
      })
      this.lastDesiredName = desired
      if (decision.kind === 'keep') {
        if (meta.name !== desired) {
          this.ctx.logger.info('UniFi device keeps its Dominevo name, the operator renamed it', {
            tags: { deviceId: this.id },
            meta: { name: meta.name, controllerName: desired },
          })
        }
        return
      }
      await manager.setName.mutate({
        deviceId: this.id,
        name: decision.name,
        stampUserNamed: false,
      })
      await this.config.set('name', decision.name)
      this.ctx.logger.info('UniFi device took the controller name', {
        tags: { deviceId: this.id },
        meta: { from: meta.name, name: decision.name },
      })
    } catch (err) {
      this.lastDesiredName = null
      this.ctx.logger.warn('UniFi device: following the controller name failed', {
        tags: { deviceId: this.id },
        meta: { error: errMsg(err) },
      })
    }
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
