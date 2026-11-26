import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
  resyncCapability,
  resyncThroughAdoption,
} from '@camstack/types'
import { matterNodes } from '../matter-gateway.js'
import { endpointLabel, mapMatterEndpointToCamStack } from '../matter-cluster-mapping.js'
import { MatterEndpointDevice } from './matter-endpoint-device.js'

/** One endpoint entry persisted on the node container — drives a child spawn. */
export const matterEndpointEntrySchema = z.object({
  endpointId: z.number().int().nonnegative(),
  clusterIds: z.array(z.number().int().nonnegative()).default([]),
  /** Descriptor device types; empty on an entry persisted before they were read. */
  deviceTypeIds: z.array(z.number().int().nonnegative()).default([]),
  /** `"clusterId:attributeId"` of the recognised attributes the endpoint carries. */
  attributes: z.array(z.string()).default([]),
  /** DoorLock FeatureMap carries Unbolting; absent = unknown (no Open). */
  lockUnbolting: z.boolean().optional(),
  /**
   * A PowerSource-only endpoint folded into this entry: its attribute reports
   * feed this child's `battery` cap and it spawns no child of its own.
   */
  powerSourceEndpointId: z.number().int().nonnegative().optional(),
})
export type MatterEndpointEntry = z.infer<typeof matterEndpointEntrySchema>

/**
 * Persisted config for a Matter node Container. `brokerId` selects the fabric;
 * `nodeId` the commissioned node; `endpoints[]` is the additively-reconciled list
 * of endpoints that fan out as accessory children. `system`/`integrationId`/
 * `name` are provenance.
 */
export const matterNodeSchema = z.object({
  brokerId: z.string().min(1).describe('Registry broker id'),
  nodeId: z.string().min(1).describe('Matter operational node id'),
  endpoints: z.array(matterEndpointEntrySchema).default([]),
  integrationId: z.string().optional(),
  system: z.literal('matter').optional(),
  name: z.string().optional(),
})

export type MatterNodeConfig = z.infer<typeof matterNodeSchema>

/**
 * Parent Container for one Matter node. Owns no caps itself — it declares
 * `getAccessoryChildren()` so the kernel auto-spawns one
 * {@link MatterEndpointDevice} per mappable endpoint in the LIVE `endpoints[]`
 * config and reconciles additions/removals when the addon re-persists the list
 * via `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 */
export class MatterNodeDevice extends BaseDevice<typeof matterNodeSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly brokerId: string
  private readonly nodeId: string
  private readonly integrationId: string | undefined
  private presenceUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = matterNodeSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, matterNodeSchema, { type: DeviceType.Container })
    // Re-sync with the source (#459, Q6): this binding is what makes Resyncable true.
    this.ctx.registerNativeCap(
      resyncCapability,
      resyncThroughAdoption(this.ctx.api.deviceManager, this.id),
    )
    this.brokerId = cfg.brokerId
    this.nodeId = cfg.nodeId
    this.integrationId = cfg.integrationId
    this.online = matterNodes.getNode(this.brokerId, this.nodeId)?.online ?? false
    matterNodes.bindDevice(this.nodeId, this.id)
    void this.updateSourceInfo({ id: this.nodeId, system: 'matter' })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.presenceUnsub = matterNodes.onNodePresence((brokerId, nodeId, online) => {
      if (brokerId !== this.brokerId || nodeId !== this.nodeId) return
      if (this.online !== online) this.markOnline(online)
    })
  }

  override async removeDevice(): Promise<void> {
    this.presenceUnsub?.()
    this.presenceUnsub = null
    matterNodes.unbindDevice(this.nodeId)
    await super.removeDevice()
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const specs: AccessoryChildSpec[] = []
    for (const endpoint of this.config.values.endpoints) {
      const mapping = mapMatterEndpointToCamStack(endpoint.clusterIds, {
        deviceTypeIds: endpoint.deviceTypeIds,
        attributes: endpoint.attributes,
      })
      if (mapping.capabilities.length === 0) continue
      const capabilities =
        endpoint.powerSourceEndpointId !== undefined && !mapping.capabilities.includes('battery')
          ? [...mapping.capabilities, 'battery']
          : [...mapping.capabilities]
      const meta: AccessoryChildSpec['meta'] = {
        type: mapping.deviceType,
        name: endpointLabel(endpoint.endpointId, mapping.deviceType),
        linkDeviceId: this.id,
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      const config: Record<string, unknown> = {
        brokerId: this.brokerId,
        nodeId: this.nodeId,
        endpointId: endpoint.endpointId,
        clusterIds: endpoint.clusterIds,
        deviceTypeIds: endpoint.deviceTypeIds,
        attributes: endpoint.attributes,
        capabilities,
        ...(endpoint.lockUnbolting !== undefined ? { lockUnbolting: endpoint.lockUnbolting } : {}),
        ...(endpoint.powerSourceEndpointId !== undefined
          ? { powerSourceEndpointId: endpoint.powerSourceEndpointId }
          : {}),
        system: 'matter',
        ...(this.integrationId !== undefined ? { integrationId: this.integrationId } : {}),
      }
      specs.push({
        stableIdSuffix: String(endpoint.endpointId),
        meta,
        config,
        factory: (childCtx: DeviceContext): IDevice => new MatterEndpointDevice(childCtx),
      })
    }
    return specs
  }
}
