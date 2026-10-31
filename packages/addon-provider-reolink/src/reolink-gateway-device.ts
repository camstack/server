import {
  BaseDevice,
  buildDeviceAdminUrl,
  type DeviceContext,
  DeviceFeature,
  DeviceType,
  deviceAdminLinkCapability,
  type InferNativeProvider,
  rebootCapability,
} from '@camstack/types'
import { z } from 'zod'
import { reolinkHubSessions } from './reolink-hub-session.js'

export const reolinkGatewayDeviceSchema = z.object({
  integrationId: z.string().min(1).describe('Integration (hub session) the device belongs to'),
  /** The adoption candidate id (`<integration>:gateway`). */
  nativeId: z.string().min(1),
})
export type ReolinkGatewayDeviceConfig = z.infer<typeof reolinkGatewayDeviceSchema>

/**
 * The physical NVR / Home Hub, as a {@link DeviceType.Gateway}. Its connection and password
 * live on the INTEGRATION; this device is the box's presence in the device list, and carries
 * the actions the library really supports through existing caps:
 *
 * - `reboot` (Baichuan `Reboot`, no channel), advertised as {@link DeviceFeature.Rebootable};
 * - `device-admin-link`, the unit's own web page.
 *
 * Cameras are NOT children of it: they are adopted as their own top-level devices of the
 * same integration. The addon flips `online` when the hub socket changes.
 */
export class ReolinkGatewayDevice extends BaseDevice<typeof reolinkGatewayDeviceSchema> {
  readonly features: readonly DeviceFeature[] = [DeviceFeature.Rebootable]

  readonly integrationId: string

  constructor(ctx: DeviceContext) {
    const cfg = reolinkGatewayDeviceSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, reolinkGatewayDeviceSchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.online = reolinkHubSessions.get(this.integrationId)?.isOnline === true
    this.registerRebootCap()
    this.registerAdminLinkCap()
    void this.updateSourceInfo({ id: cfg.nativeId, system: 'reolink' })
  }

  private registerRebootCap(): void {
    const provider: InferNativeProvider<typeof rebootCapability> = {
      reboot: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `ReolinkGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const session = reolinkHubSessions.get(this.integrationId)
        if (session === null) {
          this.ctx.logger.warn('Reolink hub reboot refused: no live session', {
            tags: { deviceId: this.id },
          })
          throw new Error('The hub session is down, so it cannot be told to reboot.')
        }
        await session.reboot()
        this.ctx.logger.info('Reolink hub reboot requested', { tags: { deviceId: this.id } })
        return { success: true as const }
      },
    }
    this.ctx.registerNativeCap(rebootCapability, provider)
  }

  /**
   * The hub's web interface, on the hub host. The password is NOT placed in the URL; the page
   * asks for it.
   */
  private registerAdminLinkCap(): void {
    const provider: InferNativeProvider<typeof deviceAdminLinkCapability> = {
      getAdminLink: async ({ deviceId }) => {
        if (deviceId !== this.id) {
          throw new Error(
            `ReolinkGatewayDevice: deviceId mismatch, expected ${this.id}, got ${deviceId}`,
          )
        }
        const host = reolinkHubSessions.get(this.integrationId)?.relayEndpoint().host
        if (host === undefined) {
          this.ctx.logger.debug('reolink admin link unavailable: integration not running', {
            tags: { deviceId: this.id },
          })
          return null
        }
        const built = buildDeviceAdminUrl({ host, port: null, scheme: 'https', path: '/' })
        if (!built.ok) {
          this.ctx.logger.debug('reolink admin link unavailable', {
            tags: { deviceId: this.id },
            meta: { reason: built.reason },
          })
          return null
        }
        return {
          url: built.url,
          label: 'Reolink web interface',
          target: 'integration' as const,
          host,
        }
      },
    }
    this.ctx.registerNativeCap(deviceAdminLinkCapability, provider)
  }
}
