import { z } from 'zod'
import { BaseDevice, type DeviceContext, DeviceType } from '@camstack/types'
import { homeComConnections } from '../homecom-gateway.js'

export const homeComGatewaySchema = z.object({
  nativeId: z.string().min(1),
  brokerId: z.string().min(1),
  system: z.literal('homecom').optional(),
  integrationId: z.string().optional(),
})

/**
 * The HomeCom gateway, as a {@link DeviceType.Gateway}. Its connection lives on the
 * INTEGRATION; this device is the gateway's presence in the device list and follows the
 * integration's online state (its connect and disconnect callbacks flip it).
 *
 * It registers no action: the cloud account offers no reboot, no update and no local page,
 * so there is nothing real to expose. The circuits, the hot water and the heat pump are NOT
 * children of it; each is adopted as its own top-level device of the same integration.
 */
export class HomeComGatewayDevice extends BaseDevice<typeof homeComGatewaySchema> {
  readonly features = [] as const

  constructor(ctx: DeviceContext) {
    const cfg = homeComGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, homeComGatewaySchema, { type: DeviceType.Gateway })
    this.online = homeComConnections.has(cfg.brokerId)
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'homecom' })
  }
}
