import { registerUnraidAdminLink } from '../unraid-admin-link.js'
import { z } from 'zod'
import {
  BaseDevice,
  type AccessoryChildSpec,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  type IDevice,
} from '@camstack/types'
import { UNRAID_SYSTEM } from '../config.js'
import { UNRAID_INSTANCE_ID } from '../unraid-discovery.js'
import { unraidInstances } from '../unraid-node-resolver.js'
import { UnraidEntityIdentitySchema } from '../unraid-mapping.js'
import { UnraidEntityDevice } from './unraid-entity-device.js'

/**
 * Persisted config for the ONE instance Container per Unraid integration. `instanceId`
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
 * The single instance Container for an Unraid server. A TOP-LEVEL device,
 * sibling of the server's Gateway. Owns no caps itself — it declares `getAccessoryChildren()`
 * so the kernel auto-spawns one {@link UnraidEntityDevice} per entity in the LIVE
 * `entities[]` config and reconciles additions/removals when the addon re-persists
 * the list via `applyDerivedSpec`. Mirrors `EcowittContainerDevice`.
 */
export class UnraidInstanceDevice extends BaseDevice<typeof unraidInstanceSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Resyncable]

  private readonly instanceId: string
  private readonly integrationId: string

  constructor(ctx: DeviceContext) {
    const cfg = unraidInstanceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidInstanceSchema, { type: DeviceType.Container })
    this.instanceId = cfg.instanceId
    this.integrationId = cfg.integrationId
    this.online = unraidInstances.getSnapshot(this.instanceId) !== null
    // device-admin-link — the instance Container is a view of the same server.
    registerUnraidAdminLink(ctx, this.id, { instanceId: this.instanceId })
    void this.updateSourceInfo({
      id: `${this.instanceId}:${UNRAID_INSTANCE_ID}`,
      system: UNRAID_SYSTEM,
    })
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
