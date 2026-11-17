import { registerUnraidAdminLink } from '../unraid-admin-link.js'
import { z } from 'zod'
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
  resyncCapability,
  resyncThroughAdoption,
} from '@camstack/types'
import { UNRAID_SYSTEM } from '../config.js'
import { UNRAID_INSTANCE_ID } from '../unraid-discovery.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { UnraidEntityIdentitySchema } from '../unraid-mapping.js'
import {
  UNRAID_HOST_WORKLOAD_OPTIONS,
  unknownWorkloadStatus,
  unraidHostWorkloadStatus,
  unraidServerReach,
} from '../unraid-workload-state.js'
import { UnraidEntityDevice } from './unraid-entity-device.js'

/**
 * Persisted config for the ONE server device (the workload host) per Unraid integration. `instanceId`
 * selects the integration's live client (it equals `integrationId`); `entities[]` is the
 * additively-reconciled identity list the addon re-derives from each snapshot and
 * re-persists via `applyDerivedSpec`. Each identity fans out as one accessory child.
 * `system`/`name` are provenance.
 */
export const unraidInstanceSchema = z.object({
  instanceId: z.string().min(1).describe('Integration id, the key of the live client'),
  entities: z.array(UnraidEntityIdentitySchema).default([]),
  integrationId: z.string().min(1).describe('Owning integration'),
  nativeId: z.literal(UNRAID_INSTANCE_ID).optional(),
  system: z.literal(UNRAID_SYSTEM).optional(),
  name: z.string().optional(),
})

export type UnraidInstanceConfig = z.infer<typeof unraidInstanceSchema>

/**
 * The Unraid server itself: a TOP-LEVEL `workload` host (D1056), sibling of the server's
 * Gateway and of its containers and VMs, which name it as their `hostDeviceId`. It serves the
 * `workload` cap (running while it answers the poll, CPU, temperature; no control) — a row
 * adopted before the workload type stays a Container without it. It declares `getAccessoryChildren()`
 * so the kernel auto-spawns one {@link UnraidEntityDevice} per entity in the LIVE
 * `entities[]` config and reconciles additions/removals when the addon re-persists
 * the list via `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 */
export class UnraidInstanceDevice extends BaseDevice<typeof unraidInstanceSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly instanceId: string
  private readonly integrationId: string
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = unraidInstanceSchema.parse(ctx.persistedConfig ?? {})
    // The type the adoption stamped (a Container before the workload host), never a second decision.
    super(ctx, unraidInstanceSchema, { type: ctx.deviceMeta.type })
    // Re-sync with the source (#459, Q6): this binding is what makes Resyncable true.
    this.ctx.registerNativeCap(
      resyncCapability,
      resyncThroughAdoption(this.ctx.api.deviceManager, this.id),
    )
    this.instanceId = cfg.instanceId
    this.integrationId = cfg.integrationId
    this.online = unraidInstances.getSnapshot(this.instanceId) !== null
    // device-admin-link — the server device is a view of the same server.
    registerUnraidAdminLink(ctx, this.id, { instanceId: this.instanceId })
    void this.updateSourceInfo({
      id: `${this.instanceId}:${UNRAID_INSTANCE_ID}`,
      system: UNRAID_SYSTEM,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // The server device is the host its containers and VMs report, whatever its type.
    unraidInstances.setHostDevice(this.instanceId, this.id)
    if (this.type !== DeviceType.Workload) return
    const provider: InferNativeProvider<typeof workloadCapability> = {
      getOptions: async () => UNRAID_HOST_WORKLOAD_OPTIONS,
      getStatus: async () =>
        this.runtimeState.getCapState<WorkloadStatus>(workloadCapability.name) ??
        unknownWorkloadStatus(null, Date.now()),
    }
    this.ctx.registerNativeCap(workloadCapability, provider)
    // No start / stop is served, so the helper registers no switch.
    registerPowerSwitch(this, workloadCapability, provider)
    this.runtimeState.setCapState(workloadCapability.name, unknownWorkloadStatus(null, Date.now()))
    this.snapshotUnsub = unraidInstances.onSnapshot(this.instanceId, () => this.recomputeWorkload())
    this.recomputeWorkload()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    if (unraidInstances.getHostDevice(this.instanceId) === this.id) {
      unraidInstances.setHostDevice(this.instanceId, null)
    }
    await super.removeDevice()
  }

  /** The server's `workload` slice from the live snapshot. */
  private recomputeWorkload(): void {
    this.runtimeState.setCapState(
      workloadCapability.name,
      unraidHostWorkloadStatus(
        unraidServerReach(unraidInstances.getManager(this.instanceId)),
        Date.now(),
      ),
    )
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    // Read the LIVE config so an additive reconcile (re-persisted `entities[]`
    // via applyDerivedSpec) spawns new children + removes orphaned ones.
    return this.config.values.entities.map((entity) => {
      const meta: AccessoryChildSpec['meta'] = {
        type: entity.deviceType,
        name: entity.name,
        linkDeviceId: this.id,
        ...(entity.role !== undefined ? { role: entity.role } : {}),
        integrationId: this.integrationId,
      }
      const config: Record<string, unknown> = {
        instanceId: this.instanceId,
        entityKey: entity.key,
        kind: entity.kind,
        capName: entity.capName,
        capabilities: [entity.capName],
        system: UNRAID_SYSTEM,
        ...(entity.containerId !== undefined ? { containerId: entity.containerId } : {}),
        ...(entity.action !== undefined ? { action: entity.action } : {}),
        integrationId: this.integrationId,
      }
      return {
        stableIdSuffix: entity.key,
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new UnraidEntityDevice(childCtx),
      } satisfies AccessoryChildSpec
    })
  }
}
