import { BaseDevice, type DeviceContext, type DeviceFeature, DeviceType } from '@camstack/types'
import { z } from 'zod'
import { UNRAID_SYSTEM } from '../config.js'
import { UnraidWorkloadRefSchema } from '../unraid-discovery.js'
import { unraidInstances } from '../unraid-node-resolver.js'

/**
 * Persisted config of an adopted Docker container or VM. `workload` names it the way that
 * survives on the server: a container by its name (Unraid recreates a container, with a new
 * id, on every update), a VM by its libvirt domain UUID (the local part of its id).
 */
export const unraidWorkloadSchema = z.object({
  nativeId: z.string().min(1),
  integrationId: z.string().min(1).describe('Owning integration'),
  workload: UnraidWorkloadRefSchema,
  system: z.literal(UNRAID_SYSTEM).optional(),
})

export type UnraidWorkloadConfig = z.infer<typeof unraidWorkloadSchema>

/**
 * One Docker container or VM of an Unraid server, adopted on its own: a top-level device
 * named after it, a sibling of the server's Gateway and instance. It follows the
 * integration online/offline and carries NO capability yet: the run state and the
 * start / stop / restart (and, for a VM, pause / resume / force stop) actions belong to
 * the workload capability still being designed. That provider plugs in at
 * {@link UnraidWorkloadDevice.onActivate} (`ctx.registerNativeCap`), resolving the live
 * client through `unraidInstances.getManager(integrationId)` and the item through
 * `findWorkload` on `unraidInstances.getSnapshot(integrationId)`.
 */
export class UnraidWorkloadDevice extends BaseDevice<typeof unraidWorkloadSchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    const cfg = unraidWorkloadSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidWorkloadSchema, { type: DeviceType.Generic })
    this.online = unraidInstances.getSnapshot(cfg.integrationId) !== null
    void this.updateSourceInfo({
      id: `${cfg.integrationId}:${cfg.nativeId}`,
      system: UNRAID_SYSTEM,
    })
  }
}
