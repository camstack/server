import { z } from 'zod'
import {
  BaseDevice,
  DeviceFeature,
  DeviceType,
  type AccessoryChildSpec,
  type DeviceContext,
  type IDevice,
} from '@camstack/types'
import { matterNodes } from '../matter-gateway.js'
import { endpointLabel, mapMatterEndpointToCamStack } from '../matter-cluster-mapping.js'
import { MatterEndpointDevice } from './matter-endpoint-device.js'

/** One endpoint entry persisted on the node container — drives a child spawn. */
const matterEndpointEntrySchema = z.object({
  endpointId: z.number().int().nonnegative(),
  clusterIds: z.array(z.number().int().nonnegative()).default([]),
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

  constructor(ctx: DeviceContext) {
    const cfg = matterNodeSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, matterNodeSchema, { type: DeviceType.Container })
    this.brokerId = cfg.brokerId
    this.nodeId = cfg.nodeId
    this.integrationId = cfg.integrationId
    this.online = matterNodes.getNode(this.brokerId, this.nodeId)?.online ?? false
    matterNodes.bindDevice(this.nodeId, this.id)
    void this.updateSourceInfo({ id: this.nodeId, system: 'matter' })
  }

  override async removeDevice(): Promise<void> {
    matterNodes.unbindDevice(this.nodeId)
    await super.removeDevice()
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    const specs: AccessoryChildSpec[] = []
    for (const endpoint of this.config.values.endpoints) {
      const mapping = mapMatterEndpointToCamStack(endpoint.clusterIds)
      if (mapping.capabilities.length === 0) continue
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
        capabilities: [...mapping.capabilities],
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
