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
import { ENPAL_SYSTEM } from '../config.js'
import { ENPAL_BOX_ID } from '../enpal-discovery.js'
import { enpalConnections } from '../enpal-resolver.js'

export const enpalGatewaySchema = z.object({
  equipment: z.literal(ENPAL_BOX_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
})

/**
 * The Enpal box itself, as a {@link DeviceType.Gateway}. Its connection lives on the
 * INTEGRATION; this device is the box's presence in the device list, and carries the one
 * action the box really supports: `device-admin-link`, its local device page. The box has no
 * reboot and no update. Equipment is NOT a child of it; each piece is adopted as its own
 * top-level Container. Online follows the integration's box (the integration marks it
 * offline when a poll fails).
 */
export class EnpalGatewayDevice extends BaseDevice<typeof enpalGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string

  constructor(ctx: DeviceContext) {
    const cfg = enpalGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalGatewaySchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = enpalConnections.getSnapshot(this.integrationId) !== null
    this.registerAdminLinkCap()
    void this.updateSourceInfo({
      id: `${this.integrationId}:${ENPAL_BOX_ID}`,
      system: ENPAL_SYSTEM,
    })
  }

  /** The box's local device page (plain HTTP, the page port); no credentials in the URL. */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `EnpalGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const connection = enpalConnections.getManager(this.integrationId)?.connection
        if (connection === undefined) {
          this.ctx.logger.debug('enpal admin link unavailable: integration not running', {
            tags: { deviceId: this.id },
          })
          return null
        }
        const built = buildDeviceAdminUrl({
          host: connection.host,
          port: connection.pagePort,
          scheme: 'http',
          path: '/deviceMessages',
        })
        if (!built.ok) {
          this.ctx.logger.debug('enpal admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'Enpal device page',
          target: 'integration' as const,
          host: connection.host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
