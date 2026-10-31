import { BaseDevice, type DeviceContext, DeviceType } from '@camstack/types'
import { shcConnections } from '../shc-gateway.js'
import { shcDeviceSchema } from './shc-device-base.js'

/**
 * The Smart Home Controller box, as a {@link DeviceType.Gateway}. Its connection
 * lives on the INTEGRATION; this device is the box's presence in the device list
 * and follows the session's online state (the integration's connect and
 * disconnect callbacks flip it).
 *
 * It registers no action: the controller's local API offers no reboot or update
 * and the box serves no web page, so there is nothing real to expose. Rooms and
 * devices are NOT children of it; they are adopted as their own top-level
 * devices of the same integration.
 */
export class ShcGatewayDevice extends BaseDevice<typeof shcDeviceSchema> {
  readonly features = [] as const

  constructor(ctx: DeviceContext) {
    const cfg = shcDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, shcDeviceSchema, { type: DeviceType.Gateway })
    this.online = shcConnections.has(cfg.brokerId)
    void this.updateSourceInfo({ id: cfg.shcDeviceId, system: 'bosch-shc' })
  }
}
