import { BaseDevice, type DeviceContext, type DeviceFeature, DeviceType } from '@camstack/types'
import { z } from 'zod'
import { UNRAID_SYSTEM } from '../config.js'
import { UNRAID_GATEWAY_ID } from '../unraid-discovery.js'
import { registerUnraidAdminLink } from '../unraid-admin-link.js'
import { unraidInstances } from '../unraid-node-resolver.js'

export const unraidGatewaySchema = z.object({
  nativeId: z.literal(UNRAID_GATEWAY_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(UNRAID_SYSTEM).optional(),
})

/**
 * The Unraid server itself, as a {@link DeviceType.Gateway}. Its connection lives on the
 * INTEGRATION; this device is the server's presence in the device list, and carries the one
 * action the addon offers on it: `device-admin-link`, the WebGUI. The instance Container
 * is NOT a child of it: both are top-level siblings. Online follows the integration's
 * snapshot.
 */
export class UnraidGatewayDevice extends BaseDevice<typeof unraidGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    const cfg = unraidGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unraidGatewaySchema, { type: DeviceType.Gateway })
    this.online = unraidInstances.getSnapshot(cfg.integrationId) !== null
    registerUnraidAdminLink(ctx, this.id, { instanceId: cfg.integrationId })
    void this.updateSourceInfo({
      id: `${cfg.integrationId}:${UNRAID_GATEWAY_ID}`,
      system: UNRAID_SYSTEM,
    })
  }
}
