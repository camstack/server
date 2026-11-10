import {
  type AccessoryChildSpec,
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
import { ENPAL_BOX_ID, accessoryChildSpecs } from '../enpal-equipment.js'
import { enpalConnections } from '../enpal-resolver.js'
import { EnpalMetadataSync } from './enpal-metadata-sync.js'

export const enpalGatewaySchema = z.object({
  equipment: z.literal(ENPAL_BOX_ID),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
  /** The box diagnostics it was adopted with; a box adopted before they existed has none. */
  specIds: z.array(z.string().min(1)).default([]),
})

/**
 * The Enpal box itself ("Enpal Box"), as a {@link DeviceType.Gateway}. Its connection lives on
 * the INTEGRATION; this device is the box's presence in the device list: its identity and
 * firmware as device attributes, its own diagnostics (CPU, memory, LTE) as hidden Sensor
 * children, and the one action the box really supports, `device-admin-link`, its local device
 * page. The box has no reboot and no update. The System and the heat pump are NOT children of
 * it; each is adopted as its own top-level Container. Online follows the integration's box
 * (the integration marks it offline when a poll fails).
 */
export class EnpalGatewayDevice extends BaseDevice<typeof enpalGatewaySchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly integrationId: string
  private readonly specIds: readonly string[]
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = enpalGatewaySchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalGatewaySchema, { type: DeviceType.Gateway })
    this.integrationId = cfg.integrationId
    this.specIds = cfg.specIds
    this.online = enpalConnections.getSnapshot(this.integrationId) !== null
    this.registerAdminLinkCap()
    void this.updateSourceInfo({
      id: `${this.integrationId}:${ENPAL_BOX_ID}`,
      system: ENPAL_SYSTEM,
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    const metadata = new EnpalMetadataSync({
      equipment: ENPAL_BOX_ID,
      deviceId: this.id,
      getSnapshot: () => enpalConnections.getSnapshot(this.integrationId),
      write: async (patch) => {
        await this.ctx.api.deviceManager.setMetadata.mutate({ deviceId: this.id, patch })
      },
      logger: this.ctx.logger,
    })
    this.snapshotUnsub = enpalConnections.onSnapshot(this.integrationId, () => {
      void metadata.apply()
    })
    await metadata.apply()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  override getAccessoryChildren(): readonly AccessoryChildSpec[] {
    return accessoryChildSpecs({
      equipment: ENPAL_BOX_ID,
      specIds: this.specIds,
      integrationId: this.integrationId,
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
