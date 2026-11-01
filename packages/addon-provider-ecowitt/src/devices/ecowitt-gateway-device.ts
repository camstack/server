import {
  BaseDevice,
  buildDeviceAdminUrl,
  type DeviceContext,
  type DeviceFeature,
  DeviceType,
  deviceAdminLinkCapability,
  type InferNativeProvider,
} from '@camstack/types'
import { z } from 'zod'
import { ECOWITT_SYSTEM } from '../config.js'
import { ecowittConnections } from '../ecowitt-client-registry.js'
import { ecowittFacades } from '../ecowitt-gateway.js'

/** Marks the Gateway device's blob apart from a group Container's. */
export const ECOWITT_GATEWAY_DEVICE_KIND = 'gateway-device'

export const ecowittGatewayDeviceSchema = z.object({
  kind: z.literal(ECOWITT_GATEWAY_DEVICE_KIND),
  integrationId: z.string().min(1).describe('Owning integration'),
  /** The key the integration's live client is published under. */
  gatewayId: z.string().min(1).describe('Gateway key of the live client'),
  system: z.literal(ECOWITT_SYSTEM).optional(),
})

/**
 * The Ecowitt gateway itself, as a {@link DeviceType.Gateway} (it used to be a Hub with the
 * connection on it). The connection lives on the INTEGRATION; this device is the gateway's
 * presence in the device list and carries the one action the gateway really has,
 * `device-admin-link`, its own web page. The group Containers are NOT children of it; each is a
 * top-level sibling. Online follows the integration's live client.
 */
export class EcowittGatewayDevice extends BaseDevice<typeof ecowittGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string

  constructor(ctx: DeviceContext) {
    const cfg = ecowittGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = ecowittFacades.get(cfg.gatewayId) !== null
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.gatewayId, system: ECOWITT_SYSTEM })
  }

  /**
   * Only the `local` transport knows an address. In `listener` transport the gateway PUSHES to
   * this hub and the addon never learns where it lives, so the answer is null, logged.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `EcowittGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = ecowittConnections.get(this.integrationId)
        if (connection === null || connection.transport !== 'local') {
          this.ctx.logger.debug('ecowitt admin link unavailable: no local address', {
            tags: { deviceId: this.id },
            meta: { transport: connection?.transport ?? 'not-running' },
          })
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: connection.port,
          scheme: 'http',
          path: '/',
        })
        if (!built.ok) {
          this.ctx.logger.debug('ecowitt admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'Gateway page',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
