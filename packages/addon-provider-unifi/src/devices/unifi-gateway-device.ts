import { BaseDevice, type DeviceContext, type DeviceFeature, DeviceType } from '@camstack/types'
import { z } from 'zod'
import { UNIFI_SYSTEM } from '../config.js'
import { registerUnifiAdminLink } from '../unifi-admin-link.js'
import { UNIFI_GATEWAY_ID } from '../unifi-discovery.js'
import { unifiControllers } from '../unifi-node-resolver.js'

export const unifiGatewaySchema = z.object({
  nativeId: z.literal(UNIFI_GATEWAY_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(UNIFI_SYSTEM).optional(),
})

/**
 * The UniFi Network controller itself, as a {@link DeviceType.Gateway}. Its connection lives
 * on the INTEGRATION; this device is the controller's presence in the device list and carries
 * the one action the addon offers on it: `device-admin-link`, the controller's UI. The infra
 * Containers and client Presence devices are NOT children of it: all are top-level siblings.
 * Online follows the integration's live manager.
 */
export class UnifiGatewayDevice extends BaseDevice<typeof unifiGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  constructor(ctx: DeviceContext) {
    const cfg = unifiGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, unifiGatewaySchema, { type: DeviceType.Gateway })
    this.online = unifiControllers.getManager(cfg.integrationId)?.status === 'connected'
    registerUnifiAdminLink(ctx, this.id, { integrationId: cfg.integrationId })
    void this.updateSourceInfo({
      id: `${cfg.integrationId}:${UNIFI_GATEWAY_ID}`,
      system: UNIFI_SYSTEM,
    })
  }
}
